import { describe, expect, it, vi } from "vitest";
import {
  escalate,
  TwilioSmsClient,
  type EscalationQueries,
  type InstantlyClient,
  type SmsClient,
} from "../src/escalation.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const leadId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";

function createQueries(overrides: Partial<EscalationQueries> = {}): EscalationQueries {
  return {
    fetchEscalationContext: vi.fn().mockResolvedValue({
      tenant_id: tenantId,
      lead_id: leadId,
      first_name: "Brett",
      last_name: "Stone",
      business_name: "Stone Builders",
      city: "Newcastle",
      email: "brett@stonebuilders.com.au",
      instantly_lead_id: "instantly-lead-123",
    }),
    ...overrides,
  };
}

function createSms(): SmsClient {
  return {
    sendSms: vi.fn().mockResolvedValue(undefined),
  };
}

function createInstantly(): InstantlyClient {
  return {
    pauseLead: vi.fn().mockResolvedValue(undefined),
  };
}

describe("escalation", () => {
  it("sends an operator SMS with lead details, reason, truncated body, and dashboard URL before pausing Instantly", async () => {
    const sms = createSms();
    const instantly = createInstantly();

    await escalate(
      {
        tenant_id: tenantId,
        lead_id: leadId,
        conversation_id: conversationId,
        reason: "low_confidence",
        inbound_body: `${"x".repeat(120)} trailing text`,
      },
      {
        queries: createQueries(),
        sms,
        instantly,
        dashboardUrl: "https://dashboard.printeriq.com",
      },
    );

    expect(sms.sendSms).toHaveBeenCalledWith({
      to: "+61400457006",
      body: expect.stringContaining("Reply from Stone Builders (Newcastle) needs attention"),
    });
    const smsBody = vi.mocked(sms.sendSms).mock.calls[0]![0].body;
    expect(smsBody).toContain("Brett Stone");
    expect(smsBody).toContain(`"${"x".repeat(100)}"`);
    expect(smsBody).toContain("Reason: low_confidence.");
    expect(smsBody).toContain(`View: https://dashboard.printeriq.com/leads/${leadId}`);
    expect(smsBody).not.toContain("trailing text");
    expect(vi.mocked(instantly.pauseLead).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(sms.sendSms).mock.invocationCallOrder[0]!,
    );
    expect(instantly.pauseLead).toHaveBeenCalledWith("instantly-lead-123");
  });

  it("uses the fixed operator escalation number", async () => {
    const sms = createSms();

    await escalate(
      {
        tenant_id: tenantId,
        lead_id: leadId,
        conversation_id: conversationId,
        reason: "hardcoded_escalation_phrase",
        inbound_body: "Can you call me?",
      },
      { queries: createQueries(), sms, instantly: createInstantly() },
    );

    expect(sms.sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: "+61400457006" }));
  });

  it("throws and does not pause Instantly when Twilio fails", async () => {
    const sms: SmsClient = {
      sendSms: vi.fn().mockRejectedValue(new Error("Twilio unavailable")),
    };
    const instantly = createInstantly();

    await expect(
      escalate(
        {
          tenant_id: tenantId,
          lead_id: leadId,
          conversation_id: conversationId,
          reason: "hardcoded_escalation_phrase",
          inbound_body: "Can you call me?",
        },
        { queries: createQueries(), sms, instantly },
      ),
    ).rejects.toThrow("Twilio unavailable");

    expect(instantly.pauseLead).not.toHaveBeenCalled();
  });

  it("throws for retry and logs no PII when Instantly pause fails after SMS succeeds", async () => {
    const instantly: InstantlyClient = {
      pauseLead: vi.fn().mockRejectedValue(new Error("Instantly unavailable for brett@stonebuilders.com.au")),
    };
    const logger = {
      error: vi.fn(),
    };

    await expect(
      escalate(
        {
          tenant_id: tenantId,
          lead_id: leadId,
          conversation_id: conversationId,
          reason: "three_inbound_replies_without_checkout",
          inbound_body: "Following up again",
        },
        { queries: createQueries(), sms: createSms(), instantly, logger },
      ),
    ).rejects.toThrow("Instantly unavailable");

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: tenantId,
        lead_id: leadId,
        conversation_id: conversationId,
      }),
      "Instantly lead pause failed after escalation SMS succeeded",
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("brett@stonebuilders.com.au");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("Stone Builders");
  });

  it("masks obvious email addresses and phone numbers in the inbound body snippet", async () => {
    const sms = createSms();

    await escalate(
      {
        tenant_id: tenantId,
        lead_id: leadId,
        conversation_id: conversationId,
        reason: "low_confidence",
        inbound_body: "Email me at customer@example.com or call +61 400 000 001 today",
      },
      { queries: createQueries(), sms, instantly: createInstantly() },
    );

    const smsBody = vi.mocked(sms.sendSms).mock.calls[0]![0].body;
    expect(smsBody).toContain("[email]");
    expect(smsBody).toContain("[phone]");
    expect(smsBody).not.toContain("customer@example.com");
    expect(smsBody).not.toContain("+61 400 000 001");
  });

  it("masks PII before truncating the inbound body snippet", async () => {
    const sms = createSms();
    const prefix = "x".repeat(95);

    await escalate(
      {
        tenant_id: tenantId,
        lead_id: leadId,
        conversation_id: conversationId,
        reason: "low_confidence",
        inbound_body: `${prefix}customer@example.com`,
      },
      { queries: createQueries(), sms, instantly: createInstantly() },
    );

    const smsBody = vi.mocked(sms.sendSms).mock.calls[0]![0].body;
    expect(smsBody).toContain("[email]");
    expect(smsBody).not.toContain("customer");
    expect(smsBody).not.toContain("@example");
  });
});

describe("Twilio SMS client", () => {
  it("posts URL-encoded SMS payloads to the Twilio Messages API with Basic Auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal("fetch", fetchMock);
    const client = new TwilioSmsClient(
      "AC_test",
      "auth-token",
      "+61411111111",
      "https://api.twilio.test",
    );

    await client.sendSms({ to: "+61400457006", body: "Escalation body" });

    expect(fetchMock).toHaveBeenCalledWith("https://api.twilio.test/2010-04-01/Accounts/AC_test/Messages.json", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("AC_test:auth-token").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: expect.any(URLSearchParams),
    });
    const body = fetchMock.mock.calls[0]![1].body as URLSearchParams;
    expect(body.get("To")).toBe("+61400457006");
    expect(body.get("From")).toBe("+61411111111");
    expect(body.get("Body")).toBe("Escalation body");
    vi.unstubAllGlobals();
  });

  it("fails before calling Twilio when TWILIO_FROM_NUMBER is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new TwilioSmsClient("AC_test", "auth-token", undefined, "https://api.twilio.test");

    await expect(client.sendSms({ to: "+61400457006", body: "Escalation body" })).rejects.toThrow(
      "Missing env var: TWILIO_FROM_NUMBER",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
