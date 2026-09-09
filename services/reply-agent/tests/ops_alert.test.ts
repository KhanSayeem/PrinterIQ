import { describe, expect, it, vi } from "vitest";
import { buildServer, type ReplyQueue } from "../src/webhook.js";
import { buildOpsAlertConfig } from "../src/ops_alert.js";
import type { SmsClient } from "../src/escalation.js";

const opsAlertSecret = "ops-alert-token";

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

function createSms(overrides: Partial<SmsClient> = {}): SmsClient {
  return {
    sendSms: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createServer(sms: SmsClient) {
  return buildServer({
    instantlyWebhookSecrets: webhookSecrets,
    queue: createQueue(),
    opsAlert: { secret: opsAlertSecret, sms },
  });
}

const stallBody =
  "PrinterIQ pipeline STALLED: nothing has completed for 14d 0h. 3321 waiting, 5/5 slots busy, 0 delayed.";

describe("ops alert route", () => {
  // The pipeline is not allowed to call an SMS provider itself, so the stall
  // monitor hands the message here and this service sends it with the same
  // client escalate() already uses. A route that accepted the post and sent
  // nothing would leave the alarm looking healthy while nobody is paged.
  it("sends the operator an SMS carrying the stall summary", async () => {
    const sms = createSms();
    const server = createServer(sms);

    const response = await server.inject({
      method: "POST",
      url: "/internal/ops-alert",
      headers: { "x-ops-alert-secret": opsAlertSecret },
      payload: { source: "pipeline-stall-monitor", subject: "PrinterIQ pipeline stalled", body: stallBody },
    });

    expect(response.statusCode).toBe(202);
    expect(sms.sendSms).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(sms.sendSms).mock.calls[0][0];
    expect(sent.body).toContain("3321 waiting");
    expect(sent.to).toMatch(/^\+/);
  });

  // webhooks.presciaiq.com proxies every path to this process, so this route
  // is publicly reachable. Without the secret anyone could page the operator
  // at 3am, which is how an alarm gets muted.
  it("refuses a request with the wrong secret", async () => {
    const sms = createSms();
    const server = createServer(sms);

    const response = await server.inject({
      method: "POST",
      url: "/internal/ops-alert",
      headers: { "x-ops-alert-secret": "wrong-token" },
      payload: { source: "pipeline-stall-monitor", subject: "s", body: stallBody },
    });

    expect(response.statusCode).toBe(403);
    expect(sms.sendSms).not.toHaveBeenCalled();
  });

  it("refuses a request with no secret at all", async () => {
    const sms = createSms();
    const server = createServer(sms);

    const response = await server.inject({
      method: "POST",
      url: "/internal/ops-alert",
      payload: { source: "pipeline-stall-monitor", subject: "s", body: stallBody },
    });

    expect(response.statusCode).toBe(403);
    expect(sms.sendSms).not.toHaveBeenCalled();
  });

  // The monitor releases its Redis cooldown when delivery fails, so that it
  // retries on the next check instead of going quiet for an hour. It can only
  // do that if a failed send is reported as a failure.
  it("answers 502 when the SMS provider rejects the send", async () => {
    const sms = createSms({
      sendSms: vi.fn().mockRejectedValue(new Error("Twilio SMS send failed with 500")),
    });
    const server = createServer(sms);

    const response = await server.inject({
      method: "POST",
      url: "/internal/ops-alert",
      headers: { "x-ops-alert-secret": opsAlertSecret },
      payload: { source: "pipeline-stall-monitor", subject: "s", body: stallBody },
    });

    expect(response.statusCode).toBe(502);
  });

  it("rejects a payload with no body to send", async () => {
    const sms = createSms();
    const server = createServer(sms);

    const response = await server.inject({
      method: "POST",
      url: "/internal/ops-alert",
      headers: { "x-ops-alert-secret": opsAlertSecret },
      payload: { source: "pipeline-stall-monitor", subject: "s" },
    });

    expect(response.statusCode).toBe(400);
    expect(sms.sendSms).not.toHaveBeenCalled();
  });

  // Long messages cost per segment and get truncated by the carrier anyway.
  it("truncates a runaway body rather than sending a novel", async () => {
    const sms = createSms();
    const server = createServer(sms);

    await server.inject({
      method: "POST",
      url: "/internal/ops-alert",
      headers: { "x-ops-alert-secret": opsAlertSecret },
      payload: { source: "pipeline-stall-monitor", subject: "s", body: "x".repeat(2000) },
    });

    const sent = vi.mocked(sms.sendSms).mock.calls[0][0];
    expect(sent.body.length).toBeLessThanOrEqual(320);
  });

  // An unregistered route 404s rather than accepting alerts it cannot deliver.
  it("is not registered when the service has no ops alert secret", async () => {
    const server = buildServer({
      instantlyWebhookSecrets: webhookSecrets,
      queue: createQueue(),
    });

    const response = await server.inject({
      method: "POST",
      url: "/internal/ops-alert",
      payload: { source: "pipeline-stall-monitor", subject: "s", body: stallBody },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("ops alert configuration", () => {
  it("is disabled, loudly, when the secret is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(buildOpsAlertConfig({})).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("OPS_ALERT_SECRET"));

    warn.mockRestore();
  });

  it("is enabled when the secret is set", () => {
    const config = buildOpsAlertConfig({ OPS_ALERT_SECRET: opsAlertSecret });

    expect(config?.secret).toBe(opsAlertSecret);
  });
});
