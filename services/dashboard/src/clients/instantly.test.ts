import { describe, expect, it, vi } from "vitest";
import { InstantlyHttpClient } from "./instantly";

describe("InstantlyHttpClient", () => {
  it("fails before calling fetch when the API key is missing", async () => {
    const fetchMock = vi.fn();
    const client = new InstantlyHttpClient({
      apiKey: undefined,
      pausedListId: "paused-list-1",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await expect(client.pauseLead("instantly-lead-1", "campaign-1")).rejects.toThrow(
      "Missing env var: INSTANTLY_API_KEY",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails before calling fetch when INSTANTLY_PAUSED_LIST_ID is missing", async () => {
    const fetchMock = vi.fn();
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      pausedListId: undefined,
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await expect(client.pauseLead("instantly-lead-1", "campaign-1")).rejects.toThrow(
      "Missing env var: INSTANTLY_PAUSED_LIST_ID",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("moves a lead to the paused holding list via the Instantly v2 leads/move endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      pausedListId: "paused-list-1",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await client.pauseLead("instantly-lead-1", "campaign-1");

    expect(fetchMock).toHaveBeenCalledWith("https://api.instantly.test/api/v2/leads/move", {
      method: "POST",
      headers: {
        Authorization: "Bearer api-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ids: ["instantly-lead-1"],
        campaign: "campaign-1",
        to_list_id: "paused-list-1",
      }),
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

  it("reads sending accounts and their daily limits from the Instantly v2 accounts endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          { email: "murphy@presciaweb.com", daily_limit: 19, status: 1 },
          { email: "dana@presciaweb.com", daily_limit: 20, status: 1 },
        ],
        next_starting_after: null,
      }),
    });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    const accounts = await client.listSendingAccounts();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.instantly.test/api/v2/accounts?limit=100",
    );
    expect(fetchMock.mock.calls[0]![1].method).toBe("GET");
    expect(accounts).toEqual([
      { email: "murphy@presciaweb.com", dailyLimit: 19, status: 1 },
      { email: "dana@presciaweb.com", dailyLimit: 20, status: 1 },
    ]);
  });

  it("follows the accounts cursor until Instantly stops returning one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ email: "one@presciaweb.com", daily_limit: 19, status: 1 }],
          next_starting_after: "cursor-2",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ email: "two@presciaweb.com", daily_limit: 19, status: 1 }],
          next_starting_after: null,
        }),
      });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    const accounts = await client.listSendingAccounts();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://api.instantly.test/api/v2/accounts?limit=100&starting_after=cursor-2",
    );
    expect(accounts.map((account) => account.email)).toEqual([
      "one@presciaweb.com",
      "two@presciaweb.com",
    ]);
  });

  it("throws when the accounts listing fails rather than reporting an empty estate", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await expect(client.listSendingAccounts()).rejects.toThrow(
      "Instantly API GET /api/v2/accounts failed with 503",
    );
  });

  it("updates one account daily limit through the Instantly v2 account patch endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await client.updateAccountDailyLimit("murphy+ramp@presciaweb.com", 6);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.instantly.test/api/v2/accounts/murphy%2Bramp%40presciaweb.com",
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer api-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ daily_limit: 6 }),
      },
    );
  });

  it("keeps the mailbox address out of the daily limit failure message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    const error = await client
      .updateAccountDailyLimit("murphy@presciaweb.com", 6)
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Instantly API PATCH /api/v2/accounts/{email} failed with 429; response body omitted",
    );
    expect((error as Error).message).not.toContain("murphy@presciaweb.com");
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
