import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { buildServer, shouldStartWebhookServer, type ReplyQueue } from "../src/webhook.js";
import { queries as defaultQueries } from "../src/db/queries.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const leadId = "22222222-2222-4222-8222-222222222222";

const webhookSecrets = {
  reply: "reply-token",
  bounced: "bounced-token",
  unsubbed: "unsubbed-token",
};

function createQueue(): ReplyQueue {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createQueries(): Pick<typeof defaultQueries, "recordInstantlyBounce" | "recordInstantlyUnsubscribe"> {
  return {
    recordInstantlyBounce: vi.fn().mockResolvedValue(undefined),
    recordInstantlyUnsubscribe: vi.fn().mockResolvedValue(undefined),
  };
}

function createServer(options: Partial<Parameters<typeof buildServer>[0]> = {}) {
  return buildServer({
    instantlyWebhookSecrets: webhookSecrets,
    queue: createQueue(),
    queries: createQueries(),
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

  it("rejects payloads without canonical lead metadata", async () => {
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
        lead: { id: "instantly-lead-123" },
        email: { id: "email-uuid-123", eaccount: "sender@presciaiq.com" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid webhook payload" });
    expect(queue.add).not.toHaveBeenCalled();
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

  it("rejects bounced or unsubscribed payloads without canonical lead metadata", async () => {
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
        lead: { id: "instantly-lead-123" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid webhook payload" });
    expect(queries.recordInstantlyUnsubscribe).not.toHaveBeenCalled();
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
