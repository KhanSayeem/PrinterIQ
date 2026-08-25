import { Queue } from "bullmq";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { ProcessReplyJob } from "./types.js";
import { stripePayments } from "./stripe.js";
import { queries as defaultQueries } from "./db/queries.js";
import { REPLIES_QUEUE_NAME, REPLY_JOB_OPTIONS } from "./queue.js";
import { recordPreviewView, type PreviewViewConfig } from "./preview_view.js";

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
  queries?: Pick<typeof defaultQueries, "recordInstantlyBounce" | "recordInstantlyUnsubscribe">;
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

function mapInstantlyPayload(payload: Record<string, unknown>): ProcessReplyJob {
  const tenantId = readNestedString(payload, ["metadata", "tenant_id"]);
  const leadId = readNestedString(payload, ["metadata", "lead_id"]);
  const body = readString(payload, ["reply_text", "body", "text", "message"]);
  const instantlyLeadId = readNestedString(payload, ["lead", "id"]);
  const instantlyEmailId = readNestedString(payload, ["email", "id"]);
  const instantlyAccountId = readNestedString(payload, ["email", "eaccount"]);

  if (!tenantId || !leadId || !body || !instantlyLeadId || !instantlyEmailId || !instantlyAccountId) {
    throw new Error("missing required webhook fields");
  }

  return {
    job_type: "process_reply",
    tenant_id: tenantId,
    lead_id: leadId,
    channel: "email",
    direction: "inbound",
    body,
    raw_webhook: payload,
    instantly_lead_id: instantlyLeadId,
    instantly_email_id: instantlyEmailId,
    instantly_account_id: instantlyAccountId,
  };
}

function mapInstantlyLeadEventPayload(payload: Record<string, unknown>): {
  tenantId: string;
  leadId: string;
  instantlyLeadId: string;
} {
  const tenantId = readNestedString(payload, ["metadata", "tenant_id"]);
  const leadId = readNestedString(payload, ["metadata", "lead_id"]);
  const instantlyLeadId = readNestedString(payload, ["lead", "id"]);

  if (!tenantId || !leadId || !instantlyLeadId) {
    throw new Error("missing required webhook fields");
  }

  return { tenantId, leadId, instantlyLeadId };
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const server = Fastify({ logger: false });
  const stripe = options.stripe ?? stripePayments;
  const queries = options.queries ?? defaultQueries;

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

      const parsed = webhookPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid webhook payload" });
      }

      let job: ProcessReplyJob;
      try {
        job = mapInstantlyPayload(parsed.data);
      } catch {
        return reply.code(400).send({ error: "invalid webhook payload" });
      }

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

      const parsed = webhookPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid webhook payload" });
      }

      let event: { tenantId: string; leadId: string; instantlyLeadId: string };
      try {
        event = mapInstantlyLeadEventPayload(parsed.data);
      } catch {
        return reply.code(400).send({ error: "invalid webhook payload" });
      }

      try {
        await queries.recordInstantlyBounce(event.tenantId, event.leadId, event.instantlyLeadId);
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

      const parsed = webhookPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid webhook payload" });
      }

      let event: { tenantId: string; leadId: string; instantlyLeadId: string };
      try {
        event = mapInstantlyLeadEventPayload(parsed.data);
      } catch {
        return reply.code(400).send({ error: "invalid webhook payload" });
      }

      try {
        await queries.recordInstantlyUnsubscribe(event.tenantId, event.leadId, event.instantlyLeadId);
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

  return server;
}

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
    previewView: buildPreviewViewConfig(),
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
