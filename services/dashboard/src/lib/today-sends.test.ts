import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstantlyAccount, InstantlySentEmail } from "@/clients/instantly";
import { getSydneyDayRange } from "@/lib/sydney-day";
import {
  RAMP_LOOKBACK_DAYS,
  countSendsByMailbox,
  countSendsInSydneyDay,
  loadMailboxSendsBySydneyDay,
  loadTodayInstantlySendTotals,
  type SentEmailsClient,
  type TodaySendsClient,
} from "./today-sends";

function account(email: string): InstantlyAccount {
  return { email, timestamp_created: "2026-01-01T00:00:00.000Z", warmup_status: 1 };
}

function sentEmail(instant: string, email = "mac@printeriq-mail.com"): InstantlySentEmail {
  return { sentAt: new Date(instant), eaccount: email };
}

/**
 * Thursday 10 September 2026 in Sydney, which is AEST, so the day runs from
 * 14:00Z on the 9th to 14:00Z on the 10th. The campaigns send between 09:00 and
 * 17:00, which is 23:00Z to 07:00Z, so this one Australian day sits across two
 * UTC dates. That is the whole reason a UTC calendar bucket cannot answer it.
 */
const SYDNEY_DAY_START = new Date("2026-09-09T14:00:00.000Z");
const SYDNEY_DAY_END = new Date("2026-09-10T14:00:00.000Z");
/** Midday on that Sydney day, so the sending window is part way through. */
const NOW = new Date("2026-09-10T02:00:00.000Z");

function fakeClient(overrides: Partial<TodaySendsClient> = {}): TodaySendsClient {
  return {
    listAccounts: vi.fn(async () => [account("mac@printeriq-mail.com")]),
    listSentEmails: vi.fn(async () => ({
      emails: [sentEmail("2026-09-09T23:47:25.000Z")],
      complete: true,
    })),
    ...overrides,
  };
}

async function load(client: TodaySendsClient, now: Date = NOW) {
  return loadTodayInstantlySendTotals({
    now,
    client,
    apiKey: "test-key",
    sendingDomains: ["printeriq-mail.com"],
  });
}

const MAILBOXES = ["mac@printeriq-mail.com"];

describe("countSendsInSydneyDay", () => {
  const day = { start: SYDNEY_DAY_START, end: SYDNEY_DAY_END };

  it("counts a send at 23:47 UTC as the Sydney day that contains it", () => {
    // 23:47:25Z on 9 September is 09:47:25 on 10 September in Sydney.
    expect(countSendsInSydneyDay([sentEmail("2026-09-09T23:47:25.000Z")], day, MAILBOXES)).toBe(1);
  });

  it("counts a send at 00:04 UTC as that same Sydney day", () => {
    // 00:04:26Z on 10 September is 10:04:26 on 10 September in Sydney, the same
    // Australian morning as the 23:47Z send above.
    expect(countSendsInSydneyDay([sentEmail("2026-09-10T00:04:26.000Z")], day, MAILBOXES)).toBe(1);
  });

  /**
   * The four instants recorded against the live campaign. Instantly's daily
   * endpoint splits them 2 and 2 across the 9th and the 10th. They are one
   * Australian sending morning and this has to report 4.
   */
  it("keeps one Australian sending morning together across UTC midnight", () => {
    const morning = [
      sentEmail("2026-09-09T23:47:25.000Z"),
      sentEmail("2026-09-09T23:56:26.000Z"),
      sentEmail("2026-09-10T00:04:26.000Z"),
      sentEmail("2026-09-10T00:05:27.000Z"),
    ];

    expect(countSendsInSydneyDay(morning, day, MAILBOXES)).toBe(4);
  });

  it("excludes a send that belongs to the previous Sydney day", () => {
    // 23:47:25Z on 8 September is 09:47:25 on 9 September in Sydney.
    const rows = [
      sentEmail("2026-09-08T23:47:25.000Z"),
      sentEmail("2026-09-09T23:47:25.000Z"),
    ];

    expect(countSendsInSydneyDay(rows, day, MAILBOXES)).toBe(1);
  });

  it("counts the opening instant of the Sydney day and not the instant before it", () => {
    expect(countSendsInSydneyDay([sentEmail("2026-09-09T14:00:00.000Z")], day, MAILBOXES)).toBe(1);
    expect(countSendsInSydneyDay([sentEmail("2026-09-09T13:59:59.999Z")], day, MAILBOXES)).toBe(0);
  });

  it("counts the last instant of the Sydney day and not the next day's midnight", () => {
    expect(countSendsInSydneyDay([sentEmail("2026-09-10T13:59:59.999Z")], day, MAILBOXES)).toBe(1);
    expect(countSendsInSydneyDay([sentEmail("2026-09-10T14:00:00.000Z")], day, MAILBOXES)).toBe(0);
  });

  /**
   * The Instantly workspace is shared with other projects. A row from a mailbox
   * outside the configured PrinterIQ domains is dropped here even though the
   * request already asked Instantly to filter, so a filter that stopped working
   * cannot inflate this figure with someone else's sends.
   */
  it("drops a row from a mailbox outside the configured list", () => {
    const rows = [
      sentEmail("2026-09-09T23:47:25.000Z"),
      sentEmail("2026-09-09T23:48:25.000Z", "someone@another-project.com"),
    ];

    expect(countSendsInSydneyDay(rows, day, MAILBOXES)).toBe(1);
  });

  it("matches a mailbox address regardless of case", () => {
    const rows = [sentEmail("2026-09-09T23:47:25.000Z", "Mac@PrinterIQ-Mail.com")];

    expect(countSendsInSydneyDay(rows, day, MAILBOXES)).toBe(1);
  });

  /** Daylight saving moves the boundary by an hour. Nothing here may assume +10. */
  it("uses the offset in force, so an AEDT day starts at 13:00Z", () => {
    const summer = getSydneyDayRange(new Date("2027-01-05T02:00:00.000Z"));

    expect(summer.start.toISOString()).toBe("2027-01-04T13:00:00.000Z");
    // 22:47Z on 4 January is 09:47 on 5 January in Sydney.
    expect(countSendsInSydneyDay([sentEmail("2027-01-04T22:47:00.000Z")], summer, MAILBOXES)).toBe(1);
    // 12:47Z on 4 January is 23:47 on 4 January in Sydney, the day before.
    expect(countSendsInSydneyDay([sentEmail("2027-01-04T12:47:00.000Z")], summer, MAILBOXES)).toBe(0);
  });
});

describe("countSendsByMailbox", () => {
  const day = { start: SYDNEY_DAY_START, end: SYDNEY_DAY_END };
  const ESTATE = ["mac@printeriq-mail.com", "murphy@printeriq-mail.com"];

  /**
   * /deliverability shows one card per mailbox, so a send has to land on the
   * mailbox that sent it. A count that is right in total but on the wrong card
   * would put one mailbox over its limit and show another as idle.
   */
  it("attributes each send to the mailbox that sent it", () => {
    const rows = [
      sentEmail("2026-09-09T23:47:25.000Z", "mac@printeriq-mail.com"),
      sentEmail("2026-09-09T23:48:25.000Z", "murphy@printeriq-mail.com"),
      sentEmail("2026-09-09T23:49:25.000Z", "murphy@printeriq-mail.com"),
    ];

    const counts = countSendsByMailbox(rows, day, ESTATE);

    expect(counts.get("mac@printeriq-mail.com")).toBe(1);
    expect(counts.get("murphy@printeriq-mail.com")).toBe(2);
  });

  it("gives a mailbox that sent nothing a real zero rather than no entry", () => {
    const counts = countSendsByMailbox(
      [sentEmail("2026-09-09T23:47:25.000Z", "mac@printeriq-mail.com")],
      day,
      ESTATE,
    );

    expect(counts.get("murphy@printeriq-mail.com")).toBe(0);
    expect([...counts.keys()].sort()).toEqual([...ESTATE].sort());
  });

  it("keys the counts by lowercased mailbox, whatever case Instantly returned", () => {
    const counts = countSendsByMailbox(
      [sentEmail("2026-09-09T23:47:25.000Z", "Murphy@PrinterIQ-Mail.com")],
      day,
      ["MURPHY@printeriq-mail.com"],
    );

    expect([...counts.entries()]).toEqual([["murphy@printeriq-mail.com", 1]]);
  });

  it("uses the same half open Sydney day as the today bar", () => {
    const rows = [
      sentEmail("2026-09-09T13:59:59.999Z", "mac@printeriq-mail.com"),
      sentEmail("2026-09-09T14:00:00.000Z", "mac@printeriq-mail.com"),
      sentEmail("2026-09-10T13:59:59.999Z", "mac@printeriq-mail.com"),
      sentEmail("2026-09-10T14:00:00.000Z", "mac@printeriq-mail.com"),
    ];

    expect(countSendsByMailbox(rows, day, ESTATE).get("mac@printeriq-mail.com")).toBe(2);
  });

  it("drops a row from a mailbox outside the configured list", () => {
    const counts = countSendsByMailbox(
      [sentEmail("2026-09-09T23:47:25.000Z", "someone@another-project.com")],
      day,
      ESTATE,
    );

    expect(counts.has("someone@another-project.com")).toBe(false);
    expect([...counts.values()]).toEqual([0, 0]);
  });
});

describe("loadMailboxSendsBySydneyDay", () => {
  const ESTATE = ["mac@printeriq-mail.com", "murphy@printeriq-mail.com"];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Answers each window the way Instantly does: every row whose instant falls
   * inside the window asked for. Two calls with two windows therefore see two
   * different slices of the same history.
   */
  function windowedClient(rows: readonly InstantlySentEmail[]): SentEmailsClient {
    return {
      listSentEmails: vi.fn(async (query) => ({
        emails: rows.filter(
          (row) =>
            row.sentAt.getTime() >= query.createdAtOrAfter.getTime() &&
            row.sentAt.getTime() < query.createdBefore.getTime(),
        ),
        complete: true,
      })),
    };
  }

  it("looks back four completed Sydney days, so Monday still sees Friday and Thursday", () => {
    expect(RAMP_LOOKBACK_DAYS).toBe(4);
  });

  it("asks for today's Sydney day and the completed days before it as instants, never a UTC date", async () => {
    const client = windowedClient([]);

    await loadMailboxSendsBySydneyDay({ client, mailboxes: ESTATE, now: NOW });

    expect(client.listSentEmails).toHaveBeenCalledWith({
      emails: ESTATE,
      createdAtOrAfter: SYDNEY_DAY_START,
      createdBefore: SYDNEY_DAY_END,
    });
    expect(client.listSentEmails).toHaveBeenCalledWith({
      emails: ESTATE,
      // Sydney midnight opening 6 September, four days before the 10th.
      createdAtOrAfter: new Date("2026-09-05T14:00:00.000Z"),
      createdBefore: SYDNEY_DAY_START,
    });
  });

  /**
   * The production shape on 2026-09-11. All 30 of the day's sends went out
   * between 09:00 and 10:00 Sydney, which is 23:00Z to 00:00Z on the previous
   * UTC date, so Instantly's daily row for the 11th did not exist and the row
   * for the 10th read 32. Counted here per email, the 11th reads 30.
   */
  it("counts a 09:47 Sydney send into today on the mailbox that sent it", async () => {
    const client = windowedClient([
      sentEmail("2026-09-09T23:47:25.000Z", "murphy@printeriq-mail.com"),
      sentEmail("2026-09-09T23:52:25.000Z", "murphy@printeriq-mail.com"),
      sentEmail("2026-09-09T23:58:25.000Z", "mac@printeriq-mail.com"),
    ]);

    const sends = await loadMailboxSendsBySydneyDay({ client, mailboxes: ESTATE, now: NOW });

    expect(sends.today.available).toBe(true);
    if (sends.today.available) {
      expect(sends.today.value.get("murphy@printeriq-mail.com")).toBe(2);
      expect(sends.today.value.get("mac@printeriq-mail.com")).toBe(1);
    }
  });

  it("splits the completed days per Sydney day, oldest first, and keeps today out of them", async () => {
    const client = windowedClient([
      // 09:10 on Monday 7 September in Sydney, a UTC Sunday.
      sentEmail("2026-09-06T23:10:00.000Z", "mac@printeriq-mail.com"),
      // 09:10 and 10:30 on Wednesday 9 September in Sydney, across UTC midnight.
      sentEmail("2026-09-08T23:10:00.000Z", "mac@printeriq-mail.com"),
      sentEmail("2026-09-09T00:30:00.000Z", "mac@printeriq-mail.com"),
      // 09:47 today, 10 September in Sydney. Belongs to today only.
      sentEmail("2026-09-09T23:47:25.000Z", "mac@printeriq-mail.com"),
    ]);

    const sends = await loadMailboxSendsBySydneyDay({ client, mailboxes: ESTATE, now: NOW });

    expect(sends.completedDays.available).toBe(true);
    if (sends.completedDays.available) {
      expect(
        sends.completedDays.value.map((day) => [day.date, day.byMailbox.get("mac@printeriq-mail.com")]),
      ).toEqual([
        ["2026-09-06", 0],
        ["2026-09-07", 1],
        ["2026-09-08", 0],
        ["2026-09-09", 2],
      ]);
    }
  });

  it("reports today as not available, never 0, when the sent email call failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client: SentEmailsClient = {
      listSentEmails: vi.fn(async (query) => {
        if (query.createdAtOrAfter.getTime() === SYDNEY_DAY_START.getTime()) {
          throw new Error("Instantly API GET /api/v2/emails failed with 429");
        }
        return { emails: [], complete: true };
      }),
    };

    const sends = await loadMailboxSendsBySydneyDay({ client, mailboxes: ESTATE, now: NOW });

    expect(sends.today.available).toBe(false);
    expect(sends.today.available ? null : sends.today.reason).toMatch(/Instantly/);
    expect(JSON.stringify(sends.today)).not.toContain('"value"');
    // The other window answered, so its figure stands on its own.
    expect(sends.completedDays.available).toBe(true);
  });

  it("reports the completed days as not available when their call failed, and keeps today", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client: SentEmailsClient = {
      listSentEmails: vi.fn(async (query) => {
        if (query.createdAtOrAfter.getTime() !== SYDNEY_DAY_START.getTime()) {
          throw new Error("Instantly API GET /api/v2/emails failed with 500");
        }
        return { emails: [sentEmail("2026-09-09T23:47:25.000Z")], complete: true };
      }),
    };

    const sends = await loadMailboxSendsBySydneyDay({ client, mailboxes: ESTATE, now: NOW });

    expect(sends.completedDays.available).toBe(false);
    expect(sends.today.available).toBe(true);
  });

  it("reports unavailable, never a short count, when a page walk was truncated", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client: SentEmailsClient = {
      listSentEmails: vi.fn(async () => ({
        emails: [sentEmail("2026-09-09T23:47:25.000Z")],
        complete: false,
      })),
    };

    const sends = await loadMailboxSendsBySydneyDay({ client, mailboxes: ESTATE, now: NOW });

    expect(sends.today.available).toBe(false);
    expect(sends.completedDays.available).toBe(false);
    expect(JSON.stringify(sends)).not.toContain('"value"');
  });

  /**
   * Sunday 4 October 2026 is the AEST to AEDT changeover, a 23 hour Sydney day.
   * Stepping back a fixed 24 hours from Tuesday would land an hour off on every
   * day before it.
   */
  it("steps back across a daylight saving change by Sydney midnights, not by 24 hours", async () => {
    const client = windowedClient([]);

    // Midday Tuesday 6 October in Sydney, AEDT.
    const sends = await loadMailboxSendsBySydneyDay({
      client,
      mailboxes: ESTATE,
      now: new Date("2026-10-06T01:00:00.000Z"),
    });

    expect(client.listSentEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        // Sydney midnight opening Friday 2 October, still AEST.
        createdAtOrAfter: new Date("2026-10-01T14:00:00.000Z"),
        // Sydney midnight opening Tuesday 6 October, AEDT.
        createdBefore: new Date("2026-10-05T13:00:00.000Z"),
      }),
    );
    expect(
      sends.completedDays.available ? sends.completedDays.value.map((day) => day.date) : null,
    ).toEqual(["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
  });

  it("never reads the pre-aggregated daily analytics", async () => {
    const getDailyAccountAnalytics = vi.fn(async () => []);
    const client = {
      ...windowedClient([]),
      getDailyAccountAnalytics,
    } as unknown as SentEmailsClient;

    await loadMailboxSendsBySydneyDay({ client, mailboxes: ESTATE, now: NOW });

    expect(getDailyAccountAnalytics).not.toHaveBeenCalled();
  });
});

describe("loadTodayInstantlySendTotals", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("asks Instantly for the Sydney day as instants, not for a calendar date", async () => {
    const client = fakeClient();

    await load(client);

    expect(client.listSentEmails).toHaveBeenCalledWith({
      emails: ["mac@printeriq-mail.com"],
      createdAtOrAfter: SYDNEY_DAY_START,
      createdBefore: SYDNEY_DAY_END,
    });
  });

  it("counts a 23:47 UTC send into today, which a UTC calendar bucket puts on yesterday", async () => {
    const client = fakeClient({
      listSentEmails: vi.fn(async () => ({
        emails: [
          sentEmail("2026-09-09T23:47:25.000Z"),
          sentEmail("2026-09-09T23:56:26.000Z"),
          sentEmail("2026-09-10T00:04:26.000Z"),
          sentEmail("2026-09-10T00:05:27.000Z"),
        ],
        complete: true,
      })),
    });

    const totals = await load(client);

    expect(totals.sent).toEqual({ available: true, value: 4 });
  });

  it("does not count yesterday's Australian morning, which shares a UTC date with today's", async () => {
    const client = fakeClient({
      listSentEmails: vi.fn(async () => ({
        emails: [
          // 09:47 on 9 September in Sydney: yesterday, same UTC date as below.
          sentEmail("2026-09-08T23:47:25.000Z"),
          // 10:04 on 9 September in Sydney: also yesterday.
          sentEmail("2026-09-09T00:04:26.000Z"),
          // 09:47 on 10 September in Sydney: today.
          sentEmail("2026-09-09T23:47:25.000Z"),
        ],
        complete: true,
      })),
    });

    const totals = await load(client);

    expect(totals.sent).toEqual({ available: true, value: 1 });
  });

  it("reports a real zero when Instantly answered and nothing has gone out yet today", async () => {
    const client = fakeClient({
      listSentEmails: vi.fn(async () => ({ emails: [], complete: true })),
    });

    const totals = await load(client);

    expect(totals.sent).toEqual({ available: true, value: 0 });
  });

  it("never reads the pre-aggregated daily analytics for the send count", async () => {
    const getDailyAccountAnalytics = vi.fn(async () => []);
    const client = {
      ...fakeClient(),
      getDailyAccountAnalytics,
    } as unknown as TodaySendsClient;

    await load(client);

    expect(getDailyAccountAnalytics).not.toHaveBeenCalled();
  });

  /**
   * The page cap exists so one dashboard render cannot walk an unbounded number
   * of pages. Hitting it means the count is short, and a short count published
   * as a day total is the failure this module exists to remove.
   */
  it("reports unavailable, never a short count, when the page walk was truncated", async () => {
    const client = fakeClient({
      listSentEmails: vi.fn(async () => ({
        emails: [sentEmail("2026-09-09T23:47:25.000Z")],
        complete: false,
      })),
    });

    const totals = await load(client);

    expect(totals.sent.available).toBe(false);
    expect(totals.sent.available ? null : totals.sent.reason).toMatch(/more sent email/i);
    expect(JSON.stringify(totals)).not.toContain('"value"');
  });

  it("reports unavailable when the sent email list cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = fakeClient({
      listSentEmails: vi.fn(async () => {
        throw new Error("Instantly API GET /api/v2/emails failed with 500");
      }),
    });

    const totals = await load(client);

    expect(totals.sent.available).toBe(false);
    expect(totals.sent.available ? null : totals.sent.reason).toMatch(/Instantly/);
    expect(JSON.stringify(totals)).not.toContain('"value"');
  });

  /**
   * Instantly publishes no per email bounce marker: the Email schema carries no
   * bounce field, and every bounce figure in the v2 API is pre-aggregated into a
   * UTC calendar day. A UTC day cannot be cut at Sydney midnight, so this is
   * said out loud rather than guessed at.
   */
  it("says why today's bounce count cannot be had, and never prints a number for it", async () => {
    const client = fakeClient();

    const totals = await load(client);

    expect(totals.bounces.available).toBe(false);
    const reason = totals.bounces.available ? "" : totals.bounces.reason;
    expect(reason).toMatch(/UTC calendar day/);
    expect(reason).toMatch(/deliverability/i);
  });

  it("still reports the send count when the bounce count cannot be had", async () => {
    const client = fakeClient();

    const totals = await load(client);

    expect(totals.sent).toEqual({ available: true, value: 1 });
    expect(totals.bounces.available).toBe(false);
  });

  it("scopes the mailboxes to the configured PrinterIQ sending domains", async () => {
    const client = fakeClient({
      listAccounts: vi.fn(async () => [
        account("mac@printeriq-mail.com"),
        account("someone@another-project.com"),
      ]),
    });

    await load(client);

    expect(client.listSentEmails).toHaveBeenCalledWith(
      expect.objectContaining({ emails: ["mac@printeriq-mail.com"] }),
    );
  });

  it("ignores a row for a mailbox it did not ask about", async () => {
    const client = fakeClient({
      listSentEmails: vi.fn(async () => ({
        emails: [
          sentEmail("2026-09-09T23:47:25.000Z"),
          sentEmail("2026-09-09T23:48:25.000Z", "someone@another-project.com"),
        ],
        complete: true,
      })),
    });

    const totals = await load(client);

    expect(totals.sent).toEqual({ available: true, value: 1 });
  });

  it("reports unavailable when the sending accounts cannot be listed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = fakeClient({
      listAccounts: vi.fn(async () => {
        throw new Error("Instantly API GET /api/v2/accounts failed with 401");
      }),
    });

    const totals = await load(client);

    expect(totals.sent.available).toBe(false);
    expect(totals.bounces.available).toBe(false);
    expect(client.listSentEmails).not.toHaveBeenCalled();
  });

  it("reports unavailable when the API key is not configured", async () => {
    const client = fakeClient();

    const totals = await loadTodayInstantlySendTotals({
      now: NOW,
      client,
      apiKey: undefined,
      sendingDomains: ["printeriq-mail.com"],
    });

    expect(totals.sent.available).toBe(false);
    expect(totals.sent.available ? null : totals.sent.reason).toContain("INSTANTLY_API_KEY");
    expect(client.listAccounts).not.toHaveBeenCalled();
  });

  it("reports unavailable when no sending domains are configured, rather than counting another project's sends", async () => {
    const client = fakeClient();

    const totals = await loadTodayInstantlySendTotals({
      now: NOW,
      client,
      apiKey: "test-key",
      sendingDomains: [],
    });

    expect(totals.sent.available).toBe(false);
    expect(totals.sent.available ? null : totals.sent.reason).toContain("SENDING_DOMAINS");
    expect(client.listSentEmails).not.toHaveBeenCalled();
  });

  it("reports unavailable when no mailbox matches the configured domains", async () => {
    const client = fakeClient({
      listAccounts: vi.fn(async () => [account("someone@another-project.com")]),
    });

    const totals = await load(client);

    expect(totals.sent.available).toBe(false);
    expect(client.listSentEmails).not.toHaveBeenCalled();
  });

  it("keeps the reason for each distinct failure distinguishable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const reasonOf = async (client: TodaySendsClient, apiKey: string | undefined = "test-key") => {
      const totals = await loadTodayInstantlySendTotals({
        now: NOW,
        client,
        apiKey,
        sendingDomains: ["printeriq-mail.com"],
      });
      return totals.sent.available ? "available" : totals.sent.reason;
    };

    const reasons = [
      await reasonOf(fakeClient(), undefined),
      await reasonOf(
        fakeClient({
          listAccounts: vi.fn(async () => {
            throw new Error("boom");
          }),
        }),
      ),
      await reasonOf(
        fakeClient({ listAccounts: vi.fn(async () => [account("someone@another-project.com")]) }),
      ),
      await reasonOf(
        fakeClient({
          listSentEmails: vi.fn(async () => {
            throw new Error("boom");
          }),
        }),
      ),
      await reasonOf(
        fakeClient({
          listSentEmails: vi.fn(async () => ({ emails: [], complete: false })),
        }),
      ),
    ];

    expect(new Set(reasons).size).toBe(reasons.length);
  });

  /** A Sydney day inside daylight saving, where the boundary is 13:00Z. */
  it("uses the Sydney offset in force rather than a fixed ten hours", async () => {
    const client = fakeClient({
      listSentEmails: vi.fn(async () => ({
        emails: [
          // 09:47 on 5 January in Sydney, which is AEDT.
          sentEmail("2027-01-04T22:47:00.000Z"),
          // 23:47 on 4 January in Sydney: the previous day.
          sentEmail("2027-01-04T12:47:00.000Z"),
        ],
        complete: true,
      })),
    });

    const totals = await load(client, new Date("2027-01-05T02:00:00.000Z"));

    expect(client.listSentEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAtOrAfter: new Date("2027-01-04T13:00:00.000Z"),
        createdBefore: new Date("2027-01-05T13:00:00.000Z"),
      }),
    );
    expect(totals.sent).toEqual({ available: true, value: 1 });
  });

  /**
   * Two live campaigns are sending while this runs. The loader is handed a
   * client that also carries the mutating methods and must touch none of them,
   * so a later edit cannot quietly turn a read into a pause or a move.
   */
  it("never calls a mutating Instantly method", async () => {
    const pauseLead = vi.fn(async () => {});
    const pauseCampaign = vi.fn(async () => {});
    const sendReply = vi.fn(async () => {});
    const client = {
      ...fakeClient(),
      pauseLead,
      pauseCampaign,
      sendReply,
    } as TodaySendsClient;

    const totals = await load(client);

    expect(totals.sent).toEqual({ available: true, value: 1 });
    expect(pauseLead).not.toHaveBeenCalled();
    expect(pauseCampaign).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });
});
