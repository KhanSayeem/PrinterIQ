import { Queue } from "bullmq";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { OutreachTarget, ProcessReplyJob } from "./types.js";
import { stripePayments } from "./stripe.js";
import { queries as defaultQueries } from "./db/queries.js";
import { REPLIES_QUEUE_NAME, REPLY_JOB_OPTIONS } from "./queue.js";
import { recordPreviewView, type PreviewViewConfig } from "./preview_view.js";
import { buildOpsAlertConfig, sendOpsAlert, type OpsAlertConfig } from "./ops_alert.js";

export type ReplyQueue = {
  add(name: string, payload: ProcessReplyJob): Promise<unknown>;
  close?(): Promise<void>;
};

type BuildServerOptions = {
  instantlyWebhookSecrets: {
    reply: string;
    bounced: string;
    unsubbed: string;
  };
  queue: ReplyQueue;
  queries?: Pick<
    typeof defaultQueries,
    | "recordInstantlyBounce"
    | "recordInstantlyUnsubscribe"
    | "findOutreachTargetByInstantlyLeadId"
    | "findOutreachTargetByEmail"
    | "findOutreachTargetByLeadId"
  >;
  /** Tenant to scope an email lookup by when a webhook payload names none.
   *
   * Instantly sends no tenant of ours, and an email address is only unique
   * inside one tenant, so without this the email fallback cannot run at all.
   * Absent rather than required because the other resolution routes do not
   * need it, and a missing TENANT_ID must not take the reply route down with
   * it. When it is absent the log line says the lookup was skipped.
   */
  tenantId?: string;
  stripeWebhookSecret?: string;
  stripe?: {
    handleWebhook(rawBody: string | Buffer, signature: string, options?: { webhookSecret?: string }): Promise<unknown>;
  };
  /** Omit to leave the preview view route unregistered.
   *
   * Absent configuration means the route 404s rather than accepting hits it
   * cannot attribute. A half-configured recorder that answers 204 and writes
   * nothing is the exact failure this feature exists to detect elsewhere.
   */
  previewView?: PreviewViewConfig;
  /** Omit to leave the ops alert route unregistered.
   *
   * The pipeline stall monitor posts here because Python workers are not
   * allowed to call an SMS provider directly. With no configuration the route
   * 404s, which the monitor reports as a delivery failure, rather than
   * accepting alerts it has no credentials to deliver.
   */
  opsAlert?: OpsAlertConfig;
};

const webhookPayloadSchema = z.record(z.unknown());

function readString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function readNestedString(payload: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = payload;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

/** Read a single-valued request header, treating blank and repeated as absent. */
function readHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length === 1 && value[0]?.trim()) {
    return value[0];
  }
  return null;
}

function readInstantlySecret(request: FastifyRequest): string | null {
  const value = request.headers["x-instantly-secret"];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length === 1 && value[0]?.trim()) {
    return value[0];
  }
  return null;
}

/** Read the shared secret from either the header or the `:webhookId` path segment.
 *
 * Instantly cannot send a custom header: its webhook object exposes only
 * target_hook_url, name, event_type and status. The secret therefore has to
 * travel in the URL, and it is the id Instantly issues per webhook, stored in
 * INSTANTLY_WEBHOOK_ID_*. The header form is kept because it is strictly
 * better, and lets another provider, or a proxy that injects the header,
 * authenticate without the secret ever appearing in a URL.
 */
function readWebhookSecret(request: FastifyRequest): string | null {
  const fromHeader = readInstantlySecret(request);
  if (fromHeader) {
    return fromHeader;
  }
  const params = request.params as { webhookId?: string } | undefined;
  const fromPath = params?.webhookId;
  return typeof fromPath === "string" && fromPath.trim().length > 0 ? fromPath : null;
}

/** Authenticate a webhook request, and make a rejection visible if it fails.
 *
 * The route logs on failure because the previous auth regression was silent:
 * Fastify runs with `logger: false` and nginx sets `access_log off` on
 * `/instantly/`, so every delivery 400'd for two months without a trace. Only
 * the route name and the reason are logged, never the supplied secret, the
 * expected secret, or any part of the payload, which keeps the no-PII rule.
 */
function authorised(request: FastifyRequest, expected: string, route: string): boolean {
  if (secretsMatch(readWebhookSecret(request), expected)) {
    return true;
  }
  console.warn(`instantly webhook rejected: route=${route} reason=invalid_secret`);
  return false;
}

function secretsMatch(actual: string | null, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

/** The ids needed to act on an Instantly event, once we know whose it is. */
type InstantlyLeadReference = {
  tenantId: string;
  leadId: string;
  instantlyLeadId: string;
};

type ResolutionQueries = Pick<
  typeof defaultQueries,
  "findOutreachTargetByInstantlyLeadId" | "findOutreachTargetByEmail" | "findOutreachTargetByLeadId"
>;

type ResolutionDeps = {
  queries: ResolutionQueries;
  /** Tenant to scope an email lookup by when the payload names none. */
  tenantId?: string;
};

type Resolution =
  | { resolved: true; reference: InstantlyLeadReference }
  | { resolved: false; identifierFound: boolean; attempts: string[] };

/** Containers holding identifiers of ours rather than Instantly's.
 *
 * `metadata` is the shape the mappers used to demand. `custom_variables` is
 * the shape `schedule_outreach._instantly_payload` actually sends, and
 * Instantly echoes custom variables back on lead events.
 */
const OWN_IDENTIFIER_CONTAINERS = ["metadata", "custom_variables"];

/** Keys whose string value could be Instantly's own lead id.
 *
 * Ordered by how likely the value is to be that id rather than something
 * else. Instantly's docs do not publish exhaustive payload examples and tell
 * integrators to log the real JSON, so this scans for the id instead of
 * asserting where it sits. Every candidate is checked against
 * `outreach_sends.instantly_lead_id`, so a wrong guess costs one indexed
 * lookup and resolves nothing.
 */
const INSTANTLY_LEAD_ID_KEYS = ["instantly_lead_id", "lead_id", "id"];

/** Keys whose string value could be the lead's own email address. */
const LEAD_EMAIL_KEYS = [
  "lead_email",
  "email",
  "email_address",
  "recipient_email",
  "recipient",
  "to_email",
  "to",
  "contact_email",
  "prospect_email",
];

/** Keys holding an address that is ours, not the lead's.
 *
 * `eaccount` is the sending mailbox on every reply payload. Resolving a lead
 * from it would attribute the event to whichever lead happens to share our
 * own address, so these are never candidates and neither is anything nested
 * under them.
 */
const SENDER_EMAIL_KEYS = [
  "eaccount",
  "email_account",
  "from",
  "from_email",
  "from_address",
  "sender",
  "sender_email",
  "reply_to",
  "reply_to_email",
];

const EMAIL_PATTERN = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

const PAYLOAD_SCAN_MAX_DEPTH = 5;
const PAYLOAD_SCAN_MAX_NODES = 400;
const MAX_INSTANTLY_LEAD_ID_CANDIDATES = 6;
const MAX_EMAIL_CANDIDATES = 4;
const MAX_IDENTIFIER_LENGTH = 320;

type ScannedString = {
  key: string;
  parentKey: string | null;
  value: string;
  /** True when the value sits inside `metadata` or `custom_variables`. */
  ownContainer: boolean;
};

/** Every non-empty string in the payload, with the key it arrived under.
 *
 * Bounded in both depth and node count because the payload is attacker
 * shaped in principle: the route authenticates a shared secret, not a schema.
 */
function scanPayloadStrings(payload: Record<string, unknown>): ScannedString[] {
  const found: ScannedString[] = [];
  let visited = 0;

  const walk = (
    node: unknown,
    key: string,
    parentKey: string | null,
    depth: number,
    ownContainer: boolean,
  ): void => {
    if (depth > PAYLOAD_SCAN_MAX_DEPTH || visited >= PAYLOAD_SCAN_MAX_NODES) {
      return;
    }
    visited += 1;

    if (typeof node === "string") {
      const value = node.trim();
      if (value.length > 0) {
        found.push({ key, parentKey, value, ownContainer });
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, key, parentKey, depth + 1, ownContainer);
      }
      return;
    }

    if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
        const normalisedChildKey = childKey.toLowerCase();
        walk(
          child,
          normalisedChildKey,
          key,
          depth + 1,
          ownContainer || OWN_IDENTIFIER_CONTAINERS.includes(normalisedChildKey),
        );
      }
    }
  };

  for (const [key, value] of Object.entries(payload)) {
    const normalisedKey = key.toLowerCase();
    walk(value, normalisedKey, null, 1, OWN_IDENTIFIER_CONTAINERS.includes(normalisedKey));
  }

  return found;
}

function rankedCandidates(
  scanned: ScannedString[],
  keys: string[],
  limit: number,
  accept: (entry: ScannedString) => boolean,
): string[] {
  const ranked = scanned
    .map((entry, index) => ({ entry, index, keyRank: keys.indexOf(entry.key) }))
    .filter(({ entry, keyRank }) => keyRank >= 0 && accept(entry))
    .sort((left, right) => {
      const leftScore =
        (left.entry.ownContainer ? 100 : 0) +
        left.keyRank * 10 +
        (left.entry.parentKey === "lead" ? 0 : 1);
      const rightScore =
        (right.entry.ownContainer ? 100 : 0) +
        right.keyRank * 10 +
        (right.entry.parentKey === "lead" ? 0 : 1);
      return leftScore - rightScore || left.index - right.index;
    });

  const unique: string[] = [];
  for (const { entry } of ranked) {
    if (!unique.includes(entry.value)) {
      unique.push(entry.value);
    }
    if (unique.length >= limit) {
      break;
    }
  }

  return unique;
}

function collectInstantlyLeadIdCandidates(scanned: ScannedString[], ownIds: string[]): string[] {
  return rankedCandidates(
    scanned,
    INSTANTLY_LEAD_ID_KEYS,
    MAX_INSTANTLY_LEAD_ID_CANDIDATES,
    (entry) =>
      entry.value.length <= MAX_IDENTIFIER_LENGTH &&
      !EMAIL_PATTERN.test(entry.value) &&
      // Our own tenant and lead ids are echoed under the same key names. They
      // are handled by their own lookup and are never Instantly lead ids.
      !ownIds.includes(entry.value),
  );
}

function collectLeadEmailCandidates(scanned: ScannedString[]): string[] {
  return rankedCandidates(
    scanned,
    LEAD_EMAIL_KEYS,
    MAX_EMAIL_CANDIDATES,
    (entry) =>
      entry.value.length <= MAX_IDENTIFIER_LENGTH &&
      EMAIL_PATTERN.test(entry.value) &&
      !SENDER_EMAIL_KEYS.includes(entry.key) &&
      !(entry.parentKey !== null && SENDER_EMAIL_KEYS.includes(entry.parentKey)),
  );
}

/** Our own tenant and lead id, if Instantly echoed both back together. */
function readOwnIdentifierPair(
  payload: Record<string, unknown>,
): { tenantId: string; leadId: string } | null {
  for (const container of OWN_IDENTIFIER_CONTAINERS) {
    const tenantId = readNestedString(payload, [container, "tenant_id"]);
    const leadId = readNestedString(payload, [container, "lead_id"]);
    if (tenantId && leadId) {
      return { tenantId, leadId };
    }
  }

  return null;
}

function readOwnTenantId(payload: Record<string, unknown>): string | null {
  for (const container of OWN_IDENTIFIER_CONTAINERS) {
    const tenantId = readNestedString(payload, [container, "tenant_id"]);
    if (tenantId) {
      return tenantId;
    }
  }

  return null;
}

function toReference(target: OutreachTarget): InstantlyLeadReference {
  return {
    tenantId: target.tenant_id,
    leadId: target.lead_id,
    instantlyLeadId: target.instantly_lead_id,
  };
}

/** Work out which of our leads an Instantly event is about.
 *
 * The mappers this replaces required `metadata.tenant_id`,
 * `metadata.lead_id` and `lead.id`, none of which the pipeline has ever sent:
 * `schedule_outreach` puts `lead_id` in `custom_variables` and sent no tenant
 * at all. Every reply, bounce and unsubscribe therefore threw, 400'd and was
 * discarded without a log line.
 *
 * So resolution now works from what is certainly there, in order:
 *
 *  1. `metadata.tenant_id` + `metadata.lead_id` + `lead.id`, the shape the
 *     old mappers demanded. Kept first and kept free of any database work, so
 *     a future Instantly change that starts echoing metadata is a fast path
 *     rather than a behaviour change.
 *  2. Instantly's own lead id, looked up against
 *     `outreach_sends.instantly_lead_id`, which is populated on every send
 *     and distinct per row. The candidate is scanned for rather than read
 *     from a fixed path, because Instantly does not publish exhaustive
 *     payload examples.
 *  3. Our own tenant and lead id echoed back without an Instantly lead id,
 *     turned into a send row, since both suppression writes match on it.
 *  4. The lead's email address, tenant scoped. Slowest and last, but the one
 *     identifier a bounce, unsubscribe or reply must carry.
 *
 * A lookup that throws is left to propagate. A database outage is not the
 * same answer as "no such lead" and must not be reported as one.
 */
async function resolveInstantlyLead(
  payload: Record<string, unknown>,
  deps: ResolutionDeps,
): Promise<Resolution> {
  const attempts: string[] = [];

  const metadataTenantId = readNestedString(payload, ["metadata", "tenant_id"]);
  const metadataLeadId = readNestedString(payload, ["metadata", "lead_id"]);
  const metadataInstantlyLeadId = readNestedString(payload, ["lead", "id"]);

  if (metadataTenantId && metadataLeadId && metadataInstantlyLeadId) {
    return {
      resolved: true,
      reference: {
        tenantId: metadataTenantId,
        leadId: metadataLeadId,
        instantlyLeadId: metadataInstantlyLeadId,
      },
    };
  }
  attempts.push(
    `metadata_fast_path:${metadataTenantId && metadataLeadId ? "no_instantly_lead_id" : "absent"}`,
  );

  const ownPair = readOwnIdentifierPair(payload);
  const knownTenantId = readOwnTenantId(payload);
  const scanned = scanPayloadStrings(payload);
  const instantlyLeadIds = collectInstantlyLeadIdCandidates(
    scanned,
    [knownTenantId, ownPair?.leadId].filter((value): value is string => Boolean(value)),
  );
  const emails = collectLeadEmailCandidates(scanned);
  const identifierFound = instantlyLeadIds.length > 0 || ownPair !== null || emails.length > 0;

  if (instantlyLeadIds.length === 0) {
    attempts.push("instantly_lead_id:absent");
  } else {
    for (const candidate of instantlyLeadIds) {
      const target = await deps.queries.findOutreachTargetByInstantlyLeadId(
        candidate,
        knownTenantId,
      );
      if (target) {
        return { resolved: true, reference: toReference(target) };
      }
    }
    attempts.push(`instantly_lead_id:missed(${instantlyLeadIds.length})`);
  }

  if (!ownPair) {
    attempts.push("own_lead_id:absent");
  } else {
    const target = await deps.queries.findOutreachTargetByLeadId(ownPair.tenantId, ownPair.leadId);
    if (target) {
      return { resolved: true, reference: toReference(target) };
    }
    attempts.push("own_lead_id:missed(1)");
  }

  const emailTenantId = knownTenantId ?? deps.tenantId ?? null;
  if (emails.length === 0) {
    attempts.push("email:absent");
  } else if (!emailTenantId) {
    // An unscoped email lookup would have to search every tenant, and two
    // tenants working the same trade in the same city share leads. Refusing
    // is the only safe answer, and the log line says so.
    attempts.push(`email:skipped_no_tenant(${emails.length})`);
  } else {
    for (const email of emails) {
      const target = await deps.queries.findOutreachTargetByEmail(emailTenantId, email);
      if (target) {
        return { resolved: true, reference: toReference(target) };
      }
    }
    attempts.push(`email:missed(${emails.length})`);
  }

  return { resolved: false, identifierFound, attempts };
}

/** Describe a payload by its top level key names and nothing else.
 *
 * Key names are the provider's vocabulary, values are the lead's data. The
 * project's no-PII-in-logs rule means only the former may be written down,
 * which is still enough to tell whether Instantly changed shape.
 */
function describePayloadKeys(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload)
    .map((key) => key.toLowerCase().slice(0, 40))
    .sort();
  if (keys.length === 0) {
    return "keys=none";
  }

  const shown = keys.slice(0, 24);
  const omitted = keys.length - shown.length;
  return `keys=${shown.join("|")}${omitted > 0 ? ` keys_omitted=${omitted}` : ""}`;
}

type InstantlyRoute = "reply" | "bounced" | "unsubbed";

type LeadEventParse =
  | {
      ok: true;
      payload: Record<string, unknown>;
      reference: InstantlyLeadReference;
      body: string | null;
    }
  | { ok: false; status: 400 | 404; error: string };

/** Read an Instantly lead event, and make any failure loud.
 *
 * The status codes separate the two failures that used to share one 400.
 * "We cannot find a lead identifier in this" is a shape change on Instantly's
 * side or a bug on ours, and calls for a code change. "These identifiers
 * match no lead of ours" is data, and calls for none. Reporting both as 400
 * hid whichever was rarer, and reporting either as 200 would discard the
 * delivery exactly the way this incident did.
 */
async function parseInstantlyLeadEvent(
  route: InstantlyRoute,
  rawBody: unknown,
  deps: ResolutionDeps,
  options: { requireReplyBody: boolean },
): Promise<LeadEventParse> {
  const parsed = webhookPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    console.warn(`instantly webhook unparsed: route=${route} reason=payload_not_an_object`);
    return { ok: false, status: 400, error: "invalid webhook payload" };
  }

  const payload = parsed.data;
  const body = readString(payload, ["reply_text", "body", "text", "message"]);

  if (options.requireReplyBody && !body) {
    console.warn(
      `instantly webhook unparsed: route=${route} reason=missing_reply_body ${describePayloadKeys(payload)}`,
    );
    return { ok: false, status: 400, error: "invalid webhook payload" };
  }

  const resolution = await resolveInstantlyLead(payload, deps);
  if (resolution.resolved) {
    return { ok: true, payload, reference: resolution.reference, body };
  }

  const lookups = `lookups=${resolution.attempts.join(",")}`;
  if (!resolution.identifierFound) {
    console.warn(
      `instantly webhook unparsed: route=${route} reason=no_lead_identifier ${describePayloadKeys(payload)} ${lookups}`,
    );
    return { ok: false, status: 400, error: "invalid webhook payload" };
  }

  console.warn(
    `instantly webhook unresolved: route=${route} ${describePayloadKeys(payload)} ${lookups}`,
  );
  return { ok: false, status: 404, error: "lead not found" };
}

/** Report a failed lookup by class name only, never by message.
 *
 * A driver error message can carry a connection string, and a query error can
 * quote the parameters, which here are a lead's own identifiers.
 */
function logLookupFailure(route: InstantlyRoute, error: unknown): void {
  console.error(
    `instantly webhook lookup failed: route=${route} error=${
      error instanceof Error ? error.name : "UnknownError"
    }`,
  );
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const server = Fastify({ logger: false });
  const stripe = options.stripe ?? stripePayments;
  const queries = options.queries ?? defaultQueries;
  const resolution: ResolutionDeps = { queries, tenantId: options.tenantId };

  server.addContentTypeParser<string>("application/json", { parseAs: "string" }, (request, body, done) => {
    (request as typeof request & { rawBody?: string }).rawBody = body;

    if (request.url.startsWith("/stripe")) {
      done(null, body);
      return;
    }

    try {
      done(null, JSON.parse(body) as unknown);
    } catch (error) {
      done(error as Error);
    }
  });

  server.setErrorHandler((_error, _request, reply) => {
    return reply.code(500).send({ error: "webhook processing failed" });
  });

  server.post("/instantly", {
    onRequest: async (request, reply) => {
      return reply.code(400).send({ error: "invalid instantly webhook route" });
    },
  }, async () => undefined);

  server.post("/instantly/", {
    onRequest: async (request, reply) => {
      return reply.code(400).send({ error: "invalid instantly webhook route" });
    },
  }, async () => undefined);

  for (const path of ["/instantly/reply", "/instantly/reply/:webhookId"]) {
    server.post(path, {
      onRequest: async (request, reply) => {
        if (!authorised(request, options.instantlyWebhookSecrets.reply, "reply")) {
          return reply.code(400).send({ error: "invalid webhook secret" });
        }
      },
    }, async (request, reply) => {
      if (!authorised(request, options.instantlyWebhookSecrets.reply, "reply")) {
        return reply.code(400).send({ error: "invalid webhook secret" });
      }

      let event: LeadEventParse;
      try {
        event = await parseInstantlyLeadEvent("reply", request.body, resolution, {
          requireReplyBody: true,
        });
      } catch (error) {
        logLookupFailure("reply", error);
        return reply.code(500).send({ error: "webhook processing failed" });
      }

      if (!event.ok) {
        return reply.code(event.status).send({ error: event.error });
      }

      const body = event.body;
      if (body === null) {
        // Unreachable: requireReplyBody rejected an empty body above. Kept so
        // the job's body is a string without an assertion talking over the
        // type system.
        return reply.code(400).send({ error: "invalid webhook payload" });
      }

      const job: ProcessReplyJob = {
        job_type: "process_reply",
        tenant_id: event.reference.tenantId,
        lead_id: event.reference.leadId,
        channel: "email",
        direction: "inbound",
        body,
        raw_webhook: event.payload,
        instantly_lead_id: event.reference.instantlyLeadId,
        // Stored as nullable metadata on the conversation. Requiring them, as
        // the old mapper did, turned a reply that merely lacked them into a
        // discarded 400.
        instantly_email_id: readNestedString(event.payload, ["email", "id"]),
        instantly_account_id: readNestedString(event.payload, ["email", "eaccount"]),
      };

      try {
        await options.queue.add("process_reply", job);
      } catch {
        return reply.code(500).send({ error: "webhook processing failed" });
      }

      return reply.code(200).send({ ok: true });
    });
  }

  for (const path of ["/instantly/bounced", "/instantly/bounced/:webhookId"]) {
    server.post(path, {
      onRequest: async (request, reply) => {
        if (!authorised(request, options.instantlyWebhookSecrets.bounced, "bounced")) {
          return reply.code(400).send({ error: "invalid webhook secret" });
        }
      },
    }, async (request, reply) => {
      if (!authorised(request, options.instantlyWebhookSecrets.bounced, "bounced")) {
        return reply.code(400).send({ error: "invalid webhook secret" });
      }

      let event: LeadEventParse;
      try {
        event = await parseInstantlyLeadEvent("bounced", request.body, resolution, {
          requireReplyBody: false,
        });
      } catch (error) {
        logLookupFailure("bounced", error);
        return reply.code(500).send({ error: "webhook processing failed" });
      }

      if (!event.ok) {
        return reply.code(event.status).send({ error: event.error });
      }

      try {
        await queries.recordInstantlyBounce(
          event.reference.tenantId,
          event.reference.leadId,
          event.reference.instantlyLeadId,
        );
      } catch {
        return reply.code(500).send({ error: "webhook processing failed" });
      }

      return reply.code(200).send({ ok: true });
    });
  }

  for (const path of ["/instantly/unsubbed", "/instantly/unsubbed/:webhookId"]) {
    server.post(path, {
      onRequest: async (request, reply) => {
        if (!authorised(request, options.instantlyWebhookSecrets.unsubbed, "unsubbed")) {
          return reply.code(400).send({ error: "invalid webhook secret" });
        }
      },
    }, async (request, reply) => {
      if (!authorised(request, options.instantlyWebhookSecrets.unsubbed, "unsubbed")) {
        return reply.code(400).send({ error: "invalid webhook secret" });
      }

      let event: LeadEventParse;
      try {
        event = await parseInstantlyLeadEvent("unsubbed", request.body, resolution, {
          requireReplyBody: false,
        });
      } catch (error) {
        logLookupFailure("unsubbed", error);
        return reply.code(500).send({ error: "webhook processing failed" });
      }

      if (!event.ok) {
        return reply.code(event.status).send({ error: event.error });
      }

      try {
        await queries.recordInstantlyUnsubscribe(
          event.reference.tenantId,
          event.reference.leadId,
          event.reference.instantlyLeadId,
        );
      } catch {
        return reply.code(500).send({ error: "webhook processing failed" });
      }

      return reply.code(200).send({ ok: true });
    });
  }

  server.post("/stripe", async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string" || signature.length === 0) {
      return reply.code(400).send({ error: "invalid stripe signature" });
    }

    const rawBody = (request as typeof request & { rawBody?: string }).rawBody;
    if (!rawBody) {
      return reply.code(400).send({ error: "invalid stripe signature" });
    }

    try {
      await stripe.handleWebhook(rawBody, signature, {
        webhookSecret: options.stripeWebhookSecret,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.toLowerCase().includes("signature")) {
        return reply.code(400).send({ error: "invalid stripe signature" });
      }

      return reply.code(500).send({ error: "stripe webhook processing failed" });
    }

    return reply.code(200).send({ ok: true });
  });

  const previewView = options.previewView;
  if (previewView) {
    /** Mirrored hit on a preview page, sent by nginx from
     * `preview.presciaiq.com`. See `nginx/preview.presciaiq.com.conf`.
     *
     * nginx discards this response, so the status code is for curl and for
     * the tests. What matters is that it always answers and never throws: the
     * prospect's page was already served by the original request, and no
     * failure here may follow it back.
     *
     * `webhooks.presciaiq.com` proxies every path to this process, so this
     * route is publicly reachable even though nginx only ever calls it over
     * localhost. The shared secret is what stops a stranger forging views and
     * making a lead that never opened the email look engaged.
     */
    server.post("/internal/preview-view", async (request, reply) => {
      if (!secretsMatch(readHeader(request, "x-preview-view-secret"), previewView.secret)) {
        console.warn("preview view rejected: reason=invalid_secret");
        return reply.code(403).send();
      }

      await recordPreviewView(
        {
          path: readHeader(request, "x-preview-path") ?? undefined,
          method: readHeader(request, "x-preview-method") ?? undefined,
          userAgent: readHeader(request, "user-agent") ?? undefined,
        },
        { tenantId: previewView.tenantId, queries: previewView.queries },
      );

      return reply.code(204).send();
    });
  }

  const opsAlert = options.opsAlert;
  if (opsAlert) {
    /** Operational alert from the pipeline stall monitor.
     *
     * CLAUDE.md forbids the Python pipeline from calling an SMS provider, and
     * this service already owns the only outbound SMS path in the system, so
     * the monitor posts its message here and `escalate()`'s client sends it.
     *
     * The status codes are load-bearing. The monitor claims a Redis cooldown
     * before it posts and releases it when delivery fails, so answering 202
     * on a failed send would silence the alarm for an hour having paged
     * nobody. Every failure path answers with an error on purpose.
     */
    server.post("/internal/ops-alert", async (request, reply) => {
      if (!secretsMatch(readHeader(request, "x-ops-alert-secret"), opsAlert.secret)) {
        console.warn("ops alert rejected: reason=invalid_secret");
        return reply.code(403).send();
      }

      const parsed = opsAlertSchema.safeParse(request.body);
      if (!parsed.success) {
        console.warn("ops alert rejected: reason=invalid_payload");
        return reply.code(400).send({ error: "invalid ops alert payload" });
      }

      try {
        await sendOpsAlert(
          { subject: parsed.data.subject ?? "", body: parsed.data.body },
          opsAlert.sms,
        );
      } catch (error) {
        console.error(
          `ops alert delivery failed: source=${parsed.data.source ?? "unknown"} error=${
            error instanceof Error ? error.name : "UnknownError"
          }`,
        );
        return reply.code(502).send({ error: "ops alert delivery failed" });
      }

      return reply.code(202).send({ ok: true });
    });
  }

  return server;
}

const opsAlertSchema = z.object({
  source: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().min(1),
});

function createQueue(): Queue<ProcessReplyJob> {
  const connectionUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

  // Retry policy lives with the worker so producer and consumer cannot drift.
  // Without it BullMQ defaults to a single attempt and a transient failure
  // retires the job silently.
  return new Queue<ProcessReplyJob>(REPLIES_QUEUE_NAME, {
    connection: { url: connectionUrl },
    defaultJobOptions: REPLY_JOB_OPTIONS,
  });
}

/** Build the preview view configuration, or explain why there is none.
 *
 * Missing configuration is a warning rather than a startup failure. Reply
 * handling, Stripe and the Instantly webhooks are revenue-critical and must
 * keep running; view tracking is an observability signal. Refusing to boot
 * over it would trade a lost signal for a lost sale. The warning is loud
 * because the alternative, a service that quietly records nothing, looks
 * exactly like a campaign that never landed.
 */
export function buildPreviewViewConfig(
  env: NodeJS.ProcessEnv = process.env,
  queries: PreviewViewConfig["queries"] = defaultQueries,
): PreviewViewConfig | undefined {
  const secret = env.PREVIEW_VIEW_SECRET;
  const tenantId = env.TENANT_ID;

  if (!secret || !tenantId) {
    const missing = [!secret ? "PREVIEW_VIEW_SECRET" : null, !tenantId ? "TENANT_ID" : null]
      .filter(Boolean)
      .join(", ");
    console.warn(`preview view tracking disabled: missing ${missing}`);
    return undefined;
  }

  return { secret, tenantId, queries };
}

async function main(): Promise<void> {
  const instantlyWebhookSecrets = {
    reply:
      process.env.INSTANTLY_WEBHOOK_AUTH_REPLY ??
      process.env.INSTANTLY_WEBHOOK_SECRET_REPLY ??
      process.env.INSTANTLY_WEBHOOK_ID_REPLY,
    bounced:
      process.env.INSTANTLY_WEBHOOK_AUTH_BOUNCED ??
      process.env.INSTANTLY_WEBHOOK_SECRET_BOUNCED ??
      process.env.INSTANTLY_WEBHOOK_ID_BOUNCED,
    unsubbed:
      process.env.INSTANTLY_WEBHOOK_AUTH_UNSUBBED ??
      process.env.INSTANTLY_WEBHOOK_SECRET_UNSUBBED ??
      process.env.INSTANTLY_WEBHOOK_ID_UNSUBBED,
  };
  const missingInstantlyWebhookSecret = Object.entries(instantlyWebhookSecrets).find(([, value]) => !value)?.[0];
  if (missingInstantlyWebhookSecret) {
    throw new Error(`INSTANTLY_WEBHOOK_AUTH_${missingInstantlyWebhookSecret.toUpperCase()} is required`);
  }

  const queue = createQueue();
  const server = buildServer({
    instantlyWebhookSecrets: instantlyWebhookSecrets as { reply: string; bounced: string; unsubbed: string },
    queue,
    tenantId: process.env.TENANT_ID,
    previewView: buildPreviewViewConfig(),
    opsAlert: buildOpsAlertConfig(),
  });
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);

  await server.listen({ port, host: "0.0.0.0" });
}

export function shouldStartWebhookServer(entrypointPath: string | undefined, pmId: string | undefined, moduleUrl = import.meta.url): boolean {
  if (pmId) {
    return true;
  }

  return Boolean(entrypointPath && moduleUrl === pathToFileURL(entrypointPath).href);
}

if (shouldStartWebhookServer(process.argv[1], process.env.pm_id)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "reply-agent failed to start");
    process.exit(1);
  });
}
