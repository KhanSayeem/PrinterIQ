import { describe, expect, it, vi } from "vitest";
import { InstantlyHttpClient } from "./instantly";

describe("InstantlyHttpClient", () => {
  it("fails before calling fetch when the API key is missing", async () => {
    const fetchMock = vi.fn();
    const client = new InstantlyHttpClient({
      apiKey: undefined,
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await expect(client.pauseLead("instantly-lead-1")).rejects.toThrow("Missing env var: INSTANTLY_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pauses a lead with the Instantly v2 lead status patch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await client.pauseLead("instantly-lead-1");

    expect(fetchMock).toHaveBeenCalledWith("https://api.instantly.test/api/v2/leads/instantly-lead-1", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer api-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: -1 }),
    });
  });

  it("sends an override reply through the Instantly email reply endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await client.sendReply({
      instantlyEmailId: "email-uuid-123",
      instantlyAccountId: "sender@printeriq.com",
      subject: "Re: Your website",
      body: "Happy to send the details.",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.instantly.test/api/v2/emails/reply", {
      method: "POST",
      headers: {
        Authorization: "Bearer api-key",
        "Content-Type": "application/json",
      },
      body: expect.any(String),
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      eaccount: "sender@printeriq.com",
      reply_to_uuid: "email-uuid-123",
      subject: "Re: Your website",
      body: {
        text: "Happy to send the details.",
      },
    });
  });

  it("omits empty reply subjects so Instantly can infer the thread subject", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await client.sendReply({
      instantlyEmailId: "email-uuid-123",
      instantlyAccountId: "sender@printeriq.com",
      subject: "",
      body: "Happy to send the details.",
    });

    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload).not.toHaveProperty("subject");
  });
});
