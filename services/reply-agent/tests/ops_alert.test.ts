import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer, type ReplyQueue } from "../src/webhook.js";
import { buildOpsAlertConfig } from "../src/ops_alert.js";
import { TwilioBalanceClient, type BalanceClient, type SmsClient } from "../src/escalation.js";

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

// Every alarm in this system reaches the operator as a Twilio SMS, and the
// Twilio account is on a trial plan with 10.90 USD on it. At Australian SMS
// rates that is a finite and fairly small number of messages, and when it
// runs out every alert goes silent with nothing on any screen saying so.
// That is the exact silent-failure class this project keeps hitting, so the
// warning has to arrive while there is still credit to send it with.
describe("low Twilio balance warning", () => {
  function createBalance(balanceUsd: number | null) {
    return { readBalanceUsd: vi.fn().mockResolvedValue(balanceUsd) };
  }

  function serverWithBalance(sms: SmsClient, balance: BalanceClient) {
    return buildServer({
      instantlyWebhookSecrets: webhookSecrets,
      queue: createQueue(),
      opsAlert: { secret: opsAlertSecret, sms, balance },
    });
  }

  async function postAlert(server: ReturnType<typeof serverWithBalance>, body = stallBody) {
    return server.inject({
      method: "POST",
      url: "/internal/ops-alert",
      headers: { "x-ops-alert-secret": opsAlertSecret },
      payload: { source: "pipeline-bounce-monitor", subject: "PrinterIQ bounce alarm", body },
    });
  }

  it("appends the remaining credit to an alert when the balance is low", async () => {
    const sms = createSms();
    const response = await postAlert(serverWithBalance(sms, createBalance(1.85)));

    expect(response.statusCode).toBe(202);
    const sent = vi.mocked(sms.sendSms).mock.calls[0][0];
    expect(sent.body).toContain("1.85");
    expect(sent.body).toContain("Twilio");
  });

  // Piggybacking on a message already going out is the point. Sending the
  // warning as its own SMS would spend the credit it is warning about.
  it("sends one message, not a separate balance text", async () => {
    const sms = createSms();
    await postAlert(serverWithBalance(sms, createBalance(0.4)));

    expect(sms.sendSms).toHaveBeenCalledTimes(1);
  });

  it("says nothing about the balance while there is plenty of credit", async () => {
    const sms = createSms();
    await postAlert(serverWithBalance(sms, createBalance(9.5)));

    const sent = vi.mocked(sms.sendSms).mock.calls[0][0];
    expect(sent.body).not.toContain("Twilio");
    expect(sent.body).toBe(`PrinterIQ bounce alarm: ${stallBody}`);
  });

  // The alarm is the product. The balance check is a courtesy attached to it,
  // so a Twilio API that is down, slow or has changed shape must cost the
  // operator the suffix and never the alert.
  it("still delivers the alert when the balance read throws", async () => {
    const sms = createSms();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const balance = { readBalanceUsd: vi.fn().mockRejectedValue(new Error("Twilio 500")) };

    const response = await postAlert(serverWithBalance(sms, balance));

    expect(response.statusCode).toBe(202);
    const sent = vi.mocked(sms.sendSms).mock.calls[0][0];
    expect(sent.body).toContain("3321 waiting");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("balance"));

    warn.mockRestore();
  });

  it("still delivers the alert when the balance is unreadable", async () => {
    const sms = createSms();
    const response = await postAlert(serverWithBalance(sms, createBalance(null)));

    expect(response.statusCode).toBe(202);
    const sent = vi.mocked(sms.sendSms).mock.calls[0][0];
    expect(sent.body).not.toContain("Twilio");
  });

  // The cap truncates from the tail, and the tail of a bounce alert is the
  // approved action. A warning that pushed the instruction off the end would
  // trade the useful half of the message for the courtesy half.
  it("keeps the whole alert and the warning inside the segment cap", async () => {
    const sms = createSms();
    const bounceBody =
      "Bounce rate CRITICAL 42.0% today, above 15%. 21 bounced of 50 sent across 2 campaigns. " +
      "Pause sending now, then pull the remaining unverified email bucket from the campaigns.";

    await postAlert(serverWithBalance(sms, createBalance(1.85)), bounceBody);

    const sent = vi.mocked(sms.sendSms).mock.calls[0][0];
    expect(sent.body.length).toBeLessThanOrEqual(320);
    expect(sent.body).toContain("unverified email bucket from the campaigns.");
    expect(sent.body).toContain("1.85");
  });

  it("truncates the alert rather than the warning when the alert is a novel", async () => {
    const sms = createSms();
    await postAlert(serverWithBalance(sms, createBalance(1.85)), "x".repeat(2000));

    const sent = vi.mocked(sms.sendSms).mock.calls[0][0];
    expect(sent.body.length).toBeLessThanOrEqual(320);
    expect(sent.body).toContain("1.85");
  });

  it("warns in the log as well, because an SMS cannot report its own failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await postAlert(serverWithBalance(createSms(), createBalance(1.85)));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("twilio balance low"));

    warn.mockRestore();
  });
});

describe("Twilio balance client", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads the balance from the free Balance.json endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ account_sid: "AC123", balance: "10.90", currency: "USD" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new TwilioBalanceClient("AC123", "token");

    expect(await client.readBalanceUsd()).toBeCloseTo(10.9);
    expect(calls[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Balance.json");
    expect(calls[0].init?.method ?? "GET").toBe("GET");
  });

  // A balance in another currency compared against a USD threshold would
  // either warn constantly or never, so it declines to guess.
  it("declines to convert a balance that is not in USD", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ balance: "10.90", currency: "AUD" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const client = new TwilioBalanceClient("AC123", "token");

    expect(await client.readBalanceUsd()).toBeNull();
  });

  it("returns null rather than throwing when Twilio refuses the read", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 401 }),
    ) as unknown as typeof fetch;

    const client = new TwilioBalanceClient("AC123", "token");

    expect(await client.readBalanceUsd()).toBeNull();
  });

  it("returns null when there are no Twilio credentials to read with", async () => {
    const client = new TwilioBalanceClient(undefined, undefined);

    expect(await client.readBalanceUsd()).toBeNull();
  });
});
