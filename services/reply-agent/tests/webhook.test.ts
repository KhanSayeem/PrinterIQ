import { describe, expect, it, vi } from "vitest";
import { buildServer, type ReplyQueue } from "../src/webhook.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const leadId = "22222222-2222-4222-8222-222222222222";

function createQueue(): ReplyQueue {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Instantly webhook", () => {
  it("rejects an invalid X-Instantly-Secret", async () => {
    const queue = createQueue();
    const server = buildServer({
      instantlySecret: "expected-secret",
      queue,
    });

    const response = await server.inject({
      method: "POST",
      url: "/instantly",
      headers: { "x-instantly-secret": "wrong-secret" },
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

  it("rejects an invalid secret before parsing the request body", async () => {
    const queue = createQueue();
    const server = buildServer({
      instantlySecret: "expected-secret",
      queue,
    });

    const response = await server.inject({
      method: "POST",
      url: "/instantly",
      headers: {
        "content-type": "application/json",
        "x-instantly-secret": "wrong-secret",
      },
      payload: "{",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid webhook secret" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("queues a process_reply job and returns 200 for a valid secret", async () => {
    const queue = createQueue();
    const server = buildServer({
      instantlySecret: "expected-secret",
      queue,
    });

    const response = await server.inject({
      method: "POST",
      url: "/instantly",
      headers: { "x-instantly-secret": "expected-secret" },
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        reply_text: "Yeah mate how much is it?",
        lead: { id: "instantly-lead-123" },
        email: { id: "email-uuid-123", eaccount: "sender@printeriq.com" },
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
    const server = buildServer({
      instantlySecret: "expected-secret",
      queue,
    });

    const response = await server.inject({
      method: "POST",
      url: "/instantly",
      headers: { "x-instantly-secret": "expected-secret" },
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        reply_text: "Send me the details",
        lead: { id: "instantly-lead-123" },
        email: { id: "email-uuid-123", eaccount: "sender@printeriq.com" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queue.add).toHaveBeenCalledWith(
      "process_reply",
      expect.objectContaining({
        instantly_lead_id: "instantly-lead-123",
        instantly_email_id: "email-uuid-123",
        instantly_account_id: "sender@printeriq.com",
      }),
    );
  });

  it("does not need DB or Claude dependencies to accept a webhook", async () => {
    const queue = createQueue();
    const server = buildServer({
      instantlySecret: "expected-secret",
      queue,
    });

    const response = await server.inject({
      method: "POST",
      url: "/instantly",
      headers: { "x-instantly-secret": "expected-secret" },
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        text: "Interested",
        lead: { id: "instantly-lead-123" },
        email: { id: "email-uuid-123", eaccount: "sender@printeriq.com" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it("rejects payloads without canonical lead metadata", async () => {
    const queue = createQueue();
    const server = buildServer({
      instantlySecret: "expected-secret",
      queue,
    });

    const response = await server.inject({
      method: "POST",
      url: "/instantly",
      headers: { "x-instantly-secret": "expected-secret" },
      payload: {
        custom_variables: { tenant_id: tenantId, lead_id: leadId },
        text: "Interested",
        lead: { id: "instantly-lead-123" },
        email: { id: "email-uuid-123", eaccount: "sender@printeriq.com" },
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
    const server = buildServer({
      instantlySecret: "expected-secret",
      queue,
    });

    const response = await server.inject({
      method: "POST",
      url: "/instantly",
      headers: { "x-instantly-secret": "expected-secret" },
      payload: {
        metadata: { tenant_id: tenantId, lead_id: leadId },
        text: "Interested",
        lead: { id: "instantly-lead-123" },
        email: { id: "email-uuid-123", eaccount: "sender@printeriq.com" },
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "webhook processing failed" });
  });
});
