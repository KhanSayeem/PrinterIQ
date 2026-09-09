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

  it("lists sending accounts from the Instantly v2 accounts endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            email: "murphy@presciaweb.com",
            timestamp_created: "2026-06-17T00:00:00.000Z",
            warmup_status: 1,
            status: 1,
            daily_limit: 20,
            stat_warmup_score: 100,
            setup_pending: false,
          },
        ],
      }),
    });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    const accounts = await client.listAccounts();

    expect(fetchMock).toHaveBeenCalledWith("https://api.instantly.test/api/v2/accounts?limit=100", {
      method: "GET",
      headers: {
        Authorization: "Bearer api-key",
        "Content-Type": "application/json",
      },
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.email).toBe("murphy@presciaweb.com");
  });

  it("follows the accounts cursor so a second page is not silently dropped", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ email: "one@presciaweb.com", warmup_status: 1 }],
          next_starting_after: "cursor-1",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [{ email: "two@presciaweb.com", warmup_status: 1 }] }),
      });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    const accounts = await client.listAccounts();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://api.instantly.test/api/v2/accounts?limit=100&starting_after=cursor-1",
    );
    expect(accounts.map((account) => account.email)).toEqual([
      "one@presciaweb.com",
      "two@presciaweb.com",
    ]);
  });

  it("requests daily account analytics for the given mailboxes and date window", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { date: "2026-09-09", email_account: "murphy@presciaweb.com", sent: 12, bounced: 0 },
      ],
    });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    const rows = await client.getDailyAccountAnalytics({
      emails: ["murphy@presciaweb.com", "jo@presciaweb.com"],
      startDate: "2026-08-11",
      endDate: "2026-09-09",
    });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.instantly.test/api/v2/accounts/analytics/daily?start_date=2026-08-11&end_date=2026-09-09&emails=murphy%40presciaweb.com&emails=jo%40presciaweb.com",
    );
    expect(rows[0]!.sent).toBe(12);
  });

  it("does not call Instantly for daily analytics when there are no mailboxes", async () => {
    const fetchMock = vi.fn();
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await expect(
      client.getDailyAccountAnalytics({ emails: [], startDate: "2026-08-11", endDate: "2026-09-09" }),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws rather than returning an empty account list when Instantly errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await expect(client.listAccounts()).rejects.toThrow("failed with 500");
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
