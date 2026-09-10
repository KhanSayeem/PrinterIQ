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

  it("reads a campaign state from the Instantly v2 campaigns endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "campaign-1", name: "Website preview", status: 1 }),
    });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await expect(client.getCampaign("campaign-1")).resolves.toEqual({
      id: "campaign-1",
      name: "Website preview",
      status: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.instantly.test/api/v2/campaigns/campaign-1", {
      method: "GET",
      headers: {
        Authorization: "Bearer api-key",
        "Content-Type": "application/json",
      },
      body: undefined,
    });
  });

  it("throws instead of guessing when the campaign read fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await expect(client.getCampaign("campaign-1")).rejects.toThrow(
      "Instantly API GET /api/v2/campaigns/campaign-1 failed with 503",
    );
  });

  it("throws when the campaign read returns a body that is not an object", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => "nope" });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await expect(client.getCampaign("campaign-1")).rejects.toThrow(
      "Instantly API GET /api/v2/campaigns/campaign-1 returned a non-object response",
    );
  });

  it("pauses a campaign through the Instantly v2 campaign pause endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await client.pauseCampaign("campaign-1");

    expect(fetchMock).toHaveBeenCalledWith("https://api.instantly.test/api/v2/campaigns/campaign-1/pause", {
      method: "POST",
      headers: {
        Authorization: "Bearer api-key",
        "Content-Type": "application/json",
      },
      body: undefined,
    });
  });

  it("activates a campaign through the Instantly v2 campaign activate endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await client.activateCampaign("campaign-1");

    expect(fetchMock).toHaveBeenCalledWith("https://api.instantly.test/api/v2/campaigns/campaign-1/activate", {
      method: "POST",
      headers: {
        Authorization: "Bearer api-key",
        "Content-Type": "application/json",
      },
      body: undefined,
    });
  });

  it("throws when a campaign pause is rejected by Instantly", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const client = new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await expect(client.pauseCampaign("campaign-1")).rejects.toThrow(
      "Instantly API POST /api/v2/campaigns/campaign-1/pause failed with 500",
    );
  });

  it("fails before calling fetch when the API key is missing for a campaign pause", async () => {
    const fetchMock = vi.fn();
    const client = new InstantlyHttpClient({
      apiKey: undefined,
      fetchFn: fetchMock,
      baseUrl: "https://api.instantly.test",
    });

    await expect(client.pauseCampaign("campaign-1")).rejects.toThrow(
      "Missing env var: INSTANTLY_API_KEY",
    );
    expect(fetchMock).not.toHaveBeenCalled();
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
});

/**
 * GET /api/v2/emails is the only Instantly endpoint that hands back a per email
 * UTC instant. Everything else is pre-aggregated into UTC calendar buckets,
 * which cannot be split at an Australian day boundary.
 */
describe("InstantlyHttpClient.listSentEmails", () => {
  /** Sydney midnight either side of Tue 10 September 2026, which is AEST. */
  const DAY_START = new Date("2026-09-09T14:00:00.000Z");
  const DAY_END = new Date("2026-09-10T14:00:00.000Z");

  function client(fetchFn: typeof fetch) {
    return new InstantlyHttpClient({
      apiKey: "api-key",
      fetchFn,
      baseUrl: "https://api.instantly.test",
    });
  }

  it("asks only for sent campaign email from the given mailboxes inside the window", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          { timestamp_created: "2026-09-09T23:47:25.000Z", eaccount: "murphy@presciaweb.com" },
        ],
      }),
    });

    const result = await client(fetchMock).listSentEmails({
      emails: ["murphy@presciaweb.com", "jo@presciaweb.com"],
      createdAtOrAfter: DAY_START,
      createdBefore: DAY_END,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url.startsWith("https://api.instantly.test/api/v2/emails?")).toBe(true);
    const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(query.get("email_type")).toBe("sent");
    expect(query.get("limit")).toBe("100");
    expect(query.get("eaccount")).toBe("murphy@presciaweb.com,jo@presciaweb.com");
    expect(result.complete).toBe(true);
    expect(result.emails).toEqual([
      {
        sentAt: new Date("2026-09-09T23:47:25.000Z"),
        eaccount: "murphy@presciaweb.com",
      },
    ]);
  });

  /**
   * The spec says min_timestamp_created filters emails created "after" the
   * value and max "before" it, without saying whether either end is inclusive.
   * Widening both ends by a second keeps that undocumented boundary out of the
   * answer: the day is decided by the caller comparing the instants it gets
   * back, not by Instantly's comparison operator.
   */
  it("widens the server side window by a second so its boundary cannot decide the day", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    });

    await client(fetchMock).listSentEmails({
      emails: ["murphy@presciaweb.com"],
      createdAtOrAfter: DAY_START,
      createdBefore: DAY_END,
    });

    const url = String(fetchMock.mock.calls[0]![0]);
    const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(query.get("min_timestamp_created")).toBe("2026-09-09T13:59:59.000Z");
    expect(query.get("max_timestamp_created")).toBe("2026-09-10T14:00:01.000Z");
  });

  it("walks every page and returns the rows from all of them", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { timestamp_created: "2026-09-09T23:47:25.000Z", eaccount: "murphy@presciaweb.com" },
          ],
          next_starting_after: "cursor-1",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { timestamp_created: "2026-09-10T00:04:26.000Z", eaccount: "jo@presciaweb.com" },
          ],
        }),
      });

    const result = await client(fetchMock).listSentEmails({
      emails: ["murphy@presciaweb.com", "jo@presciaweb.com"],
      createdAtOrAfter: DAY_START,
      createdBefore: DAY_END,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("starting_after=cursor-1");
    expect(result.complete).toBe(true);
    expect(result.emails.map((email) => email.eaccount)).toEqual([
      "murphy@presciaweb.com",
      "jo@presciaweb.com",
    ]);
  });

  /**
   * A truncated walk must be visible to the caller. Returning the short list as
   * though it were the whole day is the failure mode this whole branch exists
   * to remove.
   */
  it("reports the walk as incomplete rather than silently truncating at the page cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          { timestamp_created: "2026-09-09T23:47:25.000Z", eaccount: "murphy@presciaweb.com" },
        ],
        next_starting_after: "always-more",
      }),
    });

    const result = await client(fetchMock).listSentEmails({
      emails: ["murphy@presciaweb.com"],
      createdAtOrAfter: DAY_START,
      createdBefore: DAY_END,
    });

    expect(result.complete).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("does not call Instantly at all when there are no mailboxes to ask about", async () => {
    const fetchMock = vi.fn();

    await expect(
      client(fetchMock).listSentEmails({
        emails: [],
        createdAtOrAfter: DAY_START,
        createdBefore: DAY_END,
      }),
    ).resolves.toEqual({ emails: [], complete: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * Skipping an unreadable row would shorten the count without saying so. The
   * caller turns this throw into a stated "not available".
   */
  it("throws rather than skipping a row it cannot read a timestamp from", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          { timestamp_created: "2026-09-09T23:47:25.000Z", eaccount: "murphy@presciaweb.com" },
          { eaccount: "murphy@presciaweb.com" },
        ],
      }),
    });

    await expect(
      client(fetchMock).listSentEmails({
        emails: ["murphy@presciaweb.com"],
        createdAtOrAfter: DAY_START,
        createdBefore: DAY_END,
      }),
    ).rejects.toThrow(/timestamp_created/);
  });

  it("keeps the mailbox addresses out of the failure message even though they are in the query", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 });

    const error = await client(fetchMock)
      .listSentEmails({
        emails: ["murphy@presciaweb.com"],
        createdAtOrAfter: DAY_START,
        createdBefore: DAY_END,
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Instantly API GET /api/v2/emails failed with 429; response body omitted",
    );
    expect((error as Error).message).not.toContain("murphy@presciaweb.com");
  });
});
