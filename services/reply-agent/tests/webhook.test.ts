import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { buildServer, shouldStartWebhookServer, type ReplyQueue } from "../src/webhook.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const leadId = "22222222-2222-4222-8222-222222222222";
const otherTenantId = "33333333-3333-4333-8333-333333333333";
const instantlyLeadId = "instantly-lead-123";
const leadEmail = "owner@stonebuilders.com.au";

const webhookSecrets = {
  reply: "reply-token",
  bounced: "bounced-token",
  unsubbed: "unsubbed-token",
};

type WebhookQueries = NonNullable<Parameters<typeof buildServer>[0]["queries"]>;

function createQueue(): ReplyQueue {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** Our own database, standing in for one lead we handed to Instantly once.
 *
 * The lookups behave the way the SQL behaves: the Instantly lead id is unique
 * across the table and may be read unscoped, the email address is only ever
 * matched inside one tenant.
 */
function createQueries(overrides: Partial<WebhookQueries> = {}): WebhookQueries {
  const target = { tenant_id: tenantId, lead_id: leadId, instantly_lead_id: instantlyLeadId };

  return {
    recordInstantlyBounce: vi.fn().mockResolvedValue(undefined),
    recordInstantlyUnsubscribe: vi.fn().mockResolvedValue(undefined),
    findOutreachTargetByInstantlyLeadId: vi.fn(
      async (candidate: string, scopedTenantId: string | null = null) =>
        candidate === instantlyLeadId && (scopedTenantId === null || scopedTenantId === tenantId)
          ? target
          : null,
    ),
    findOutreachTargetByEmail: vi.fn(async (scopedTenantId: string, email: string) =>
      scopedTenantId === tenantId && email.toLowerCase() === leadEmail ? target : null,
    ),
    findOutreachTargetByLeadId: vi.fn(async (scopedTenantId: string, candidateLeadId: string) =>
      scopedTenantId === tenantId && candidateLeadId === leadId ? target : null,
    ),
    ...overrides,
  };
}

function createServer(options: Partial<Parameters<typeof buildServer>[0]> = {}) {
  return buildServer({
    instantlyWebhookSecrets: webhookSecrets,
    queue: createQueue(),
    queries: createQueries(),
    tenantId,
    ...options,
  });
}

describe("Instantly webhook", () => {
  it("rejects the legacy /instantly endpoint with a clear 400", async () => {
    const queue = createQueue();
    const queries = createQueries();
    const server = createServer({ queue, queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly",
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid instantly webhook route" });
    expect(queue.add).not.toHaveBeenCalled();
    expect(queries.recordInstantlyBounce).not.toHaveBeenCalled();
    expect(queries.recordInstantlyUnsubscribe).not.toHaveBeenCalled();
  });

  it("rejects the legacy /instantly/ endpoint with a clear 400", async () => {
    const queue = createQueue();
    const queries = createQueries();
    const server = createServer({ queue, queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/",
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid instantly webhook route" });
    expect(queue.add).not.toHaveBeenCalled();
    expect(queries.recordInstantlyBounce).not.toHaveBeenCalled();
    expect(queries.recordInstantlyUnsubscribe).not.toHaveBeenCalled();
  });

  it("rejects reply webhooks without the Instantly secret header", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply",
      payload: {
        tenant_id: tenantId,
        lead_id: leadId,
        body: "Hi",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid webhook secret" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("rejects an invalid reply webhook secret before parsing the request body", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply",
      headers: {
        "content-type": "application/json",
        "x-instantly-secret": "wrong-token",
      },
      payload: "{",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid webhook secret" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  // Replaces "rejects legacy reply path-secret routes...".
  //
  // #104 hardened these routes to header-only auth and rejected the path
  // form outright. Instantly cannot satisfy that: its webhook object exposes
  // only target_hook_url, name, event_type and status, with no way to attach
  // a custom header. The three registered webhooks all POST to
  // /instantly/<event>/<id>, so every delivery 400'd and replies, bounces
  // and unsubscribes were silently dropped in production.
  //
  // The path segment is the UUIDv7 Instantly issues per webhook, stored in
  // INSTANTLY_WEBHOOK_ID_*, which is what the variable naming always implied.
  // Treat it as a bearer secret and compare it timing-safely. Note UUIDv7 is
  // not 128 random bits: 48 are a millisecond timestamp, leaving ~74 random.
  // Ample against guessing, but it is also unrotatable without recreating the
  // webhook, and readable by any holder of an Instantly API key.
  it("accepts a reply webhook authenticated by the path secret", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply/reply-token",
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        reply_text: "Yes, I would like this.",
        lead: { id: "instantly-lead-123" },
        email: { id: "email-uuid-123", eaccount: "sender@presciaiq.com" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queue.add).toHaveBeenCalledWith(
      "process_reply",
      expect.objectContaining({
        job_type: "process_reply",
        tenant_id: tenantId,
        lead_id: leadId,
        body: "Yes, I would like this.",
      }),
    );
  });

  it("logs a rejected webhook without leaking the secret or the payload", async () => {
    // #104 dropped every reply, bounce and unsubscribe for two months and
    // nothing noticed, because Fastify runs with logger: false and nginx sets
    // access_log off on /instantly/. A 400 storm produced no signal anywhere.
    // One warn line per rejection is what makes a repeat visible.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const server = createServer();

      await server.inject({
        method: "POST",
        url: "/instantly/reply/wrong-token",
        payload: {
          metadata: { tenant_id: tenantId, lead_id: leadId },
          reply_text: "sensitive lead reply body",
        },
      });

      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.map((args) => args.join(" ")).join(" ");
      expect(logged).toContain("reply");
      expect(logged).not.toContain("wrong-token");
      expect(logged).not.toContain("reply-token");
      expect(logged).not.toContain("sensitive lead reply body");
      expect(logged).not.toContain(leadId);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not log a warning when a webhook authenticates", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const server = createServer();

      const response = await server.inject({
        method: "POST",
        url: "/instantly/reply/reply-token",
        payload: {
          metadata: { tenant_id: tenantId, lead_id: leadId },
          reply_text: "Yes, I would like this.",
          lead: { id: "instantly-lead-123" },
          email: { id: "email-uuid-123", eaccount: "sender@presciaiq.com" },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects a reply webhook whose path secret is wrong", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply/not-the-token",
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        reply_text: "Yes, I would like this.",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid webhook secret" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("rejects a wrong path secret before parsing the request body", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply/not-the-token",
      headers: { "content-type": "application/json" },
      payload: "{",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid webhook secret" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does not accept another route's secret on the reply path", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply/bounced-token",
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        reply_text: "Yes, I would like this.",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid webhook secret" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("accepts a bounced webhook authenticated by the path secret", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        lead: { id: "instantly-lead-123" },
        email: { id: "email-uuid-123", eaccount: "sender@presciaiq.com" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queries.recordInstantlyBounce).toHaveBeenCalled();
  });

  it("accepts an unsubscribed webhook authenticated by the path secret", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/unsubbed/unsubbed-token",
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        lead: { id: "instantly-lead-123" },
        email: { id: "email-uuid-123", eaccount: "sender@presciaiq.com" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queries.recordInstantlyUnsubscribe).toHaveBeenCalled();
  });

  it("queues a process_reply job and returns 200 for a valid reply webhook secret", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply",
      headers: {
        "x-instantly-secret": "reply-token",
      },
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        reply_text: "Yeah mate how much is it?",
        lead: { id: "instantly-lead-123" },
        email: { id: "email-uuid-123", eaccount: "sender@presciaiq.com" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queue.add).toHaveBeenCalledWith(
      "process_reply",
      expect.objectContaining({
        job_type: "process_reply",
        tenant_id: tenantId,
        lead_id: leadId,
        channel: "email",
        direction: "inbound",
        body: "Yeah mate how much is it?",
      }),
    );
  });

  it("queues Instantly reply metadata when the webhook includes it", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply",
      headers: {
        "x-instantly-secret": "reply-token",
      },
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        reply_text: "Send me the details",
        lead: { id: "instantly-lead-123" },
        email: { id: "email-uuid-123", eaccount: "sender@presciaiq.com" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queue.add).toHaveBeenCalledWith(
      "process_reply",
      expect.objectContaining({
        instantly_lead_id: "instantly-lead-123",
        instantly_email_id: "email-uuid-123",
        instantly_account_id: "sender@presciaiq.com",
      }),
    );
  });

  it("does not need DB or Claude dependencies to accept a webhook", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply",
      headers: {
        "x-instantly-secret": "reply-token",
      },
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        text: "Interested",
        lead: { id: "instantly-lead-123" },
        email: { id: "email-uuid-123", eaccount: "sender@presciaiq.com" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queue.add).toHaveBeenCalledOnce();
  });

  // Was "rejects payloads without canonical lead metadata".
  //
  // metadata.tenant_id and metadata.lead_id were treated as mandatory, and
  // the pipeline has never sent them: schedule_outreach puts lead_id in
  // custom_variables. Every reply, bounce and unsubscribe therefore failed
  // the mapper and 400'd, unlogged. Rejecting this payload was the bug.
  it("accepts a reply whose identifiers arrive in custom_variables", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply",
      headers: {
        "x-instantly-secret": "reply-token",
      },
      payload: {
        custom_variables: { tenant_id: tenantId, lead_id: leadId },
        text: "Interested",
        lead: { id: instantlyLeadId },
        email: { id: "email-uuid-123", eaccount: "sender@presciaiq.com" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queue.add).toHaveBeenCalledWith(
      "process_reply",
      expect.objectContaining({
        tenant_id: tenantId,
        lead_id: leadId,
        body: "Interested",
        instantly_lead_id: instantlyLeadId,
      }),
    );
  });

  it("returns a generic error when queueing fails", async () => {
    const queue: ReplyQueue = {
      add: vi.fn().mockRejectedValue(new Error("redis://internal-host failed")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply",
      headers: {
        "x-instantly-secret": "reply-token",
      },
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        text: "Interested",
        lead: { id: "instantly-lead-123" },
        email: { id: "email-uuid-123", eaccount: "sender@presciaiq.com" },
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "webhook processing failed" });
  });

  it("records bounced Instantly events through tenant-scoped DB handling", async () => {
    const queue = createQueue();
    const queries = createQueries();
    const server = createServer({ queue, queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced",
      headers: {
        "x-instantly-secret": "bounced-token",
      },
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        lead: { id: "instantly-lead-123" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(queries.recordInstantlyBounce).toHaveBeenCalledWith(tenantId, leadId, "instantly-lead-123");
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("records unsubscribed Instantly events through tenant-scoped DB handling", async () => {
    const queue = createQueue();
    const queries = createQueries();
    const server = createServer({ queue, queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/unsubbed",
      headers: {
        "x-instantly-secret": "unsubbed-token",
      },
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        lead: { id: "instantly-lead-123" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(queries.recordInstantlyUnsubscribe).toHaveBeenCalledWith(tenantId, leadId, "instantly-lead-123");
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("rejects an invalid bounced webhook secret before parsing the request body", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced",
      headers: {
        "content-type": "application/json",
        "x-instantly-secret": "wrong-token",
      },
      payload: "{",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid webhook secret" });
    expect(queries.recordInstantlyBounce).not.toHaveBeenCalled();
  });

  // Was "rejects bounced or unsubscribed payloads without canonical lead
  // metadata". Same inversion as the reply case above: this is the shape the
  // pipeline produces, and dropping it lost three real bounces.
  it("accepts an unsubscribe whose identifiers arrive in custom_variables", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/unsubbed",
      headers: {
        "x-instantly-secret": "unsubbed-token",
      },
      payload: {
        custom_variables: { tenant_id: tenantId, lead_id: leadId },
        lead: { id: instantlyLeadId },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queries.recordInstantlyUnsubscribe).toHaveBeenCalledWith(tenantId, leadId, instantlyLeadId);
  });
});

describe("webhook server startup", () => {
  it("starts when launched by PM2 even though process.argv points at the PM2 wrapper", () => {
    const moduleUrl = pathToFileURL("/root/printeriq/services/reply-agent/dist/webhook.js").href;

    expect(shouldStartWebhookServer("/usr/lib/node_modules/pm2/lib/ProcessContainerFork.js", "0", moduleUrl)).toBe(
      true,
    );
  });
});

/** Resolution of a webhook to one of our leads.
 *
 * Instantly's docs do not publish exhaustive payload examples and tell
 * integrators to log the real JSON, so nothing here may depend on a payload
 * shape being echoed back. The two identifiers that must be there are the
 * Instantly lead id, which we stored on every send, and the lead's own email
 * address, which is the thing the event happened to.
 */
describe("Instantly webhook lead resolution", () => {
  it("resolves a bounce from the Instantly lead id when the payload carries no ids of ours", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: {
        event_type: "email_bounced",
        campaign_id: "campaign-456",
        lead_id: instantlyLeadId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queries.findOutreachTargetByInstantlyLeadId).toHaveBeenCalledWith(instantlyLeadId, null);
    expect(queries.recordInstantlyBounce).toHaveBeenCalledWith(tenantId, leadId, instantlyLeadId);
  });

  it("resolves an Instantly lead id nested under lead", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: {
        event_type: "email_bounced",
        lead: { id: instantlyLeadId, first_name: "Brett" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queries.recordInstantlyBounce).toHaveBeenCalledWith(tenantId, leadId, instantlyLeadId);
  });

  it("resolves an Instantly lead id sent at the top level as id", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/unsubbed/unsubbed-token",
      payload: { event_type: "lead_unsubscribed", id: instantlyLeadId },
    });

    expect(response.statusCode).toBe(200);
    expect(queries.recordInstantlyUnsubscribe).toHaveBeenCalledWith(tenantId, leadId, instantlyLeadId);
  });

  // The fallback that has to hold when every id assumption fails. Whatever
  // else an Instantly bounce, unsubscribe or reply carries, it is about an
  // email address.
  it("resolves a bounce from the lead email when no id in the payload matches", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: {
        event_type: "email_bounced",
        lead_email: leadEmail,
        campaign_name: "Tradies May",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queries.findOutreachTargetByEmail).toHaveBeenCalledWith(tenantId, leadEmail);
    expect(queries.recordInstantlyBounce).toHaveBeenCalledWith(tenantId, leadId, instantlyLeadId);
  });

  it("resolves a lead email nested under lead", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: {
        event_type: "email_bounced",
        lead: { email: leadEmail.toUpperCase(), company_name: "Stone Builders" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queries.recordInstantlyBounce).toHaveBeenCalledWith(tenantId, leadId, instantlyLeadId);
  });

  // Our own sending address is in the reply payload too, under eaccount. It
  // is not a lead and must never be used to resolve one.
  it("never resolves a lead from our own sending address", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: {
        event_type: "email_bounced",
        email: { eaccount: "sender@presciaiq.com", from: "sender@presciaiq.com" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(queries.findOutreachTargetByEmail).not.toHaveBeenCalled();
  });

  // Instantly may one day start echoing metadata. The old fast path stays,
  // and it stays a fast path: it answers without touching the database.
  it("keeps the metadata fast path and does not query the database for it", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        lead: { id: instantlyLeadId },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queries.recordInstantlyBounce).toHaveBeenCalledWith(tenantId, leadId, instantlyLeadId);
    expect(queries.findOutreachTargetByInstantlyLeadId).not.toHaveBeenCalled();
    expect(queries.findOutreachTargetByEmail).not.toHaveBeenCalled();
    expect(queries.findOutreachTargetByLeadId).not.toHaveBeenCalled();
  });

  // Our own ids echoed back without an Instantly lead id still have to be
  // turned into a send row, because both suppression writes match on
  // outreach_sends.instantly_lead_id.
  it("resolves our own echoed ids through the send row when no Instantly lead id is present", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: { metadata: { tenant_id: tenantId, lead_id: leadId } },
    });

    expect(response.statusCode).toBe(200);
    expect(queries.findOutreachTargetByLeadId).toHaveBeenCalledWith(tenantId, leadId);
    expect(queries.recordInstantlyBounce).toHaveBeenCalledWith(tenantId, leadId, instantlyLeadId);
  });

  // The mutation this whole suite exists to kill: a handler that answers 200
  // and writes nothing looks healthy in every log and dashboard we have.
  it("answers 404 and records nothing when the payload resolves to no lead", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: {
        event_type: "email_bounced",
        lead_id: "instantly-lead-we-never-sent",
        lead_email: "stranger@example.com",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "lead not found" });
    expect(queries.recordInstantlyBounce).not.toHaveBeenCalled();
  });

  it("answers 404 and queues nothing when a reply resolves to no lead", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply/reply-token",
      payload: {
        event_type: "reply_received",
        lead_id: "instantly-lead-we-never-sent",
        reply_text: "Yeah go on then",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "lead not found" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  // "We cannot read this" and "this is about a lead we do not have" call for
  // different responses from us: one is a code change, the other is data.
  // Collapsing them into one status hides whichever is rarer.
  it("distinguishes a payload it cannot read from a lead it cannot find", async () => {
    const server = createServer();

    const unreadable = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: { event_type: "email_bounced", campaign_id: "campaign-456" },
    });

    const notFound = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: { event_type: "email_bounced", lead_id: "instantly-lead-we-never-sent" },
    });

    expect(unreadable.statusCode).toBe(400);
    expect(unreadable.json()).toEqual({ error: "invalid webhook payload" });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({ error: "lead not found" });
    expect(unreadable.statusCode).not.toBe(notFound.statusCode);
  });

  it("answers 400 for a payload that is not an object", async () => {
    const queries = createQueries();
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify("email_bounced"),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid webhook payload" });
    expect(queries.recordInstantlyBounce).not.toHaveBeenCalled();
  });

  it("answers 400 when a resolvable reply carries no reply body", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply/reply-token",
      payload: { event_type: "reply_received", lead_id: instantlyLeadId },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid webhook payload" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  // A lookup that throws is our outage, not an unknown lead. Reporting it as
  // 404 would tell Instantly the delivery was handled.
  it("answers 500, not 404, when a resolution lookup fails", async () => {
    const queries = createQueries({
      findOutreachTargetByInstantlyLeadId: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const server = createServer({ queries });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: { event_type: "email_bounced", lead_id: instantlyLeadId },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "webhook processing failed" });
    expect(queries.recordInstantlyBounce).not.toHaveBeenCalled();
  });

  // Two tenants in the same trade will hold the same lead. An email lookup
  // that escaped its tenant would archive, or reply to, the wrong company's
  // lead.
  it("does not resolve an email belonging to another tenant", async () => {
    const queries = createQueries();
    const server = createServer({ queries, tenantId: otherTenantId });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: { event_type: "email_bounced", lead_email: leadEmail },
    });

    expect(response.statusCode).toBe(404);
    expect(queries.findOutreachTargetByEmail).toHaveBeenCalledWith(otherTenantId, leadEmail);
    expect(queries.findOutreachTargetByEmail).not.toHaveBeenCalledWith(tenantId, leadEmail);
    expect(queries.recordInstantlyBounce).not.toHaveBeenCalled();
  });

  it("scopes the email lookup to the tenant the payload names, not the configured one", async () => {
    const queries = createQueries();
    const server = createServer({ queries, tenantId: otherTenantId });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: {
        custom_variables: { tenant_id: tenantId },
        lead_email: leadEmail,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queries.findOutreachTargetByEmail).toHaveBeenCalledWith(tenantId, leadEmail);
  });

  // With no tenant from the payload and none configured, an email lookup
  // would have to search every tenant. Not resolving is the correct answer.
  it("does not attempt an email lookup when no tenant is known", async () => {
    const queries = createQueries();
    const server = createServer({ queries, tenantId: undefined });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/bounced/bounced-token",
      payload: { event_type: "email_bounced", lead_email: leadEmail },
    });

    expect(response.statusCode).toBe(404);
    expect(queries.findOutreachTargetByEmail).not.toHaveBeenCalled();
    expect(queries.recordInstantlyBounce).not.toHaveBeenCalled();
  });

  // The reason this ran undetected for a whole campaign is that the payload
  // failure path logged nothing at all. A 400 storm produced no signal.
  it("warns with the route and the payload shape, and no payload values, when it cannot resolve", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const server = createServer();

      const response = await server.inject({
        method: "POST",
        url: "/instantly/bounced/bounced-token",
        payload: {
          event_type: "email_bounced",
          lead_email: "stranger@example.com",
          lead: { first_name: "Brett", company_name: "Stone Builders" },
          reply_text: "please take me off your list",
        },
      });

      expect(response.statusCode).toBe(404);
      expect(warn).toHaveBeenCalled();

      const logged = warn.mock.calls.map((args) => args.join(" ")).join(" ");
      // Names the route, so the line says which of the three hooks broke.
      expect(logged).toContain("bounced");
      // Describes the shape: top level key names, and which lookups missed.
      expect(logged).toContain("event_type");
      expect(logged).toContain("lead_email");
      // Carries no values: no addresses, no names, no reply text, no ids.
      expect(logged).not.toContain("stranger@example.com");
      expect(logged).not.toContain("stranger");
      expect(logged).not.toContain("Brett");
      expect(logged).not.toContain("Stone Builders");
      expect(logged).not.toContain("please take me off your list");
      expect(logged).not.toContain(tenantId);
      expect(logged).not.toContain(leadId);
      expect(logged).not.toContain(instantlyLeadId);
    } finally {
      warn.mockRestore();
    }
  });

  it("names the lookups it tried and missed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const server = createServer();

      await server.inject({
        method: "POST",
        url: "/instantly/unsubbed/unsubbed-token",
        payload: {
          event_type: "lead_unsubscribed",
          lead_id: "instantly-lead-we-never-sent",
          lead_email: "stranger@example.com",
        },
      });

      const logged = warn.mock.calls.map((args) => args.join(" ")).join(" ");
      expect(logged).toContain("unsubbed");
      expect(logged).toContain("instantly_lead_id");
      expect(logged).toContain("email");
      expect(logged).toContain("missed");
    } finally {
      warn.mockRestore();
    }
  });

  it("warns when a payload carries no identifier it could look anything up by", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const server = createServer();

      await server.inject({
        method: "POST",
        url: "/instantly/bounced/bounced-token",
        payload: { event_type: "email_bounced", campaign_id: "campaign-456" },
      });

      const logged = warn.mock.calls.map((args) => args.join(" ")).join(" ");
      expect(logged).toContain("bounced");
      expect(logged).toContain("no_lead_identifier");
      expect(logged).not.toContain("campaign-456");
    } finally {
      warn.mockRestore();
    }
  });

  it("queues a reply resolved by email alone with the ids read from our own send row", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply/reply-token",
      payload: {
        event_type: "reply_received",
        lead_email: leadEmail,
        reply_text: "Yeah mate how much is it?",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queue.add).toHaveBeenCalledWith(
      "process_reply",
      expect.objectContaining({
        job_type: "process_reply",
        tenant_id: tenantId,
        lead_id: leadId,
        channel: "email",
        direction: "inbound",
        body: "Yeah mate how much is it?",
        instantly_lead_id: instantlyLeadId,
      }),
    );
  });

  // The Instantly email id and sending account are stored as nullable
  // metadata on the conversation. Requiring them cost us whole replies.
  it("queues a reply that carries no Instantly email id or sending account", async () => {
    const queue = createQueue();
    const server = createServer({ queue });

    const response = await server.inject({
      method: "POST",
      url: "/instantly/reply/reply-token",
      payload: {
        event_type: "reply_received",
        lead_id: instantlyLeadId,
        reply_text: "Sounds good",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queue.add).toHaveBeenCalledWith(
      "process_reply",
      expect.objectContaining({
        body: "Sounds good",
        instantly_lead_id: instantlyLeadId,
        instantly_email_id: null,
        instantly_account_id: null,
      }),
    );
  });
});
