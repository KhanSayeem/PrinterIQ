import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstantlyAccount, InstantlyDailyAccountAnalytics } from "@/clients/instantly";
import {
  loadTodayInstantlySendTotals,
  totalsFromDailyAnalytics,
  type TodaySendsClient,
} from "./today-sends";

function account(email: string): InstantlyAccount {
  return { email, timestamp_created: "2026-01-01T00:00:00.000Z", warmup_status: 1 };
}

function row(
  email: string,
  date: string,
  sent: number,
  bounced: number,
): InstantlyDailyAccountAnalytics {
  return { email_account: email, date, sent, bounced };
}

function fakeClient(overrides: Partial<TodaySendsClient> = {}): TodaySendsClient {
  return {
    listAccounts: vi.fn(async () => [account("mac@printeriq-mail.com")]),
    getDailyAccountAnalytics: vi.fn(async () => [
      row("mac@printeriq-mail.com", "2026-06-16", 40, 2),
    ]),
    ...overrides,
  };
}

const NOW = new Date("2026-06-15T23:00:00.000Z"); // 09:00 on 16 June in Sydney.

describe("totalsFromDailyAnalytics", () => {
  it("sums today's sends and bounces across every mailbox", () => {
    const totals = totalsFromDailyAnalytics(
      [
        row("a@printeriq-mail.com", "2026-06-16", 40, 2),
        row("b@printeriq-mail.com", "2026-06-16", 35, 1),
      ],
      "2026-06-16",
    );

    expect(totals.sent).toEqual({ available: true, value: 75 });
    expect(totals.bounces).toEqual({ available: true, value: 3 });
  });

  it("ignores rows from other days", () => {
    const totals = totalsFromDailyAnalytics(
      [
        row("a@printeriq-mail.com", "2026-06-15", 400, 20),
        row("a@printeriq-mail.com", "2026-06-16", 40, 2),
        row("a@printeriq-mail.com", "2026-06-17", 999, 99),
      ],
      "2026-06-16",
    );

    expect(totals.sent).toEqual({ available: true, value: 40 });
    expect(totals.bounces).toEqual({ available: true, value: 2 });
  });

  it("reports a real zero when Instantly answered and today has no rows yet", () => {
    const totals = totalsFromDailyAnalytics([row("a@printeriq-mail.com", "2026-06-15", 400, 20)], "2026-06-16");

    expect(totals.sent).toEqual({ available: true, value: 0 });
    expect(totals.bounces).toEqual({ available: true, value: 0 });
  });
});

describe("loadTodayInstantlySendTotals", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reads today's sends from Instantly rather than from the database", async () => {
    const client = fakeClient();

    const totals = await loadTodayInstantlySendTotals({
      now: NOW,
      client,
      apiKey: "test-key",
      sendingDomains: ["printeriq-mail.com"],
    });

    expect(totals.sent).toEqual({ available: true, value: 40 });
    expect(totals.bounces).toEqual({ available: true, value: 2 });
  });

  it("asks Instantly for the Sydney day, not the UTC day", async () => {
    const client = fakeClient();

    await loadTodayInstantlySendTotals({
      now: NOW,
      client,
      apiKey: "test-key",
      sendingDomains: ["printeriq-mail.com"],
    });

    expect(client.getDailyAccountAnalytics).toHaveBeenCalledWith({
      emails: ["mac@printeriq-mail.com"],
      startDate: "2026-06-16",
      endDate: "2026-06-16",
    });
  });

  it("scopes the mailboxes to the configured PrinterIQ sending domains", async () => {
    const client = fakeClient({
      listAccounts: vi.fn(async () => [
        account("mac@printeriq-mail.com"),
        account("someone@another-project.com"),
      ]),
    });

    await loadTodayInstantlySendTotals({
      now: NOW,
      client,
      apiKey: "test-key",
      sendingDomains: ["printeriq-mail.com"],
    });

    expect(client.getDailyAccountAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ emails: ["mac@printeriq-mail.com"] }),
    );
  });

  it("reports unavailable, never zero, when the analytics call fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = fakeClient({
      getDailyAccountAnalytics: vi.fn(async () => {
        throw new Error("Instantly API GET /api/v2/accounts/analytics/daily failed with 500");
      }),
    });

    const totals = await loadTodayInstantlySendTotals({
      now: NOW,
      client,
      apiKey: "test-key",
      sendingDomains: ["printeriq-mail.com"],
    });

    expect(totals.sent.available).toBe(false);
    expect(totals.bounces.available).toBe(false);
    expect(totals.sent.available ? null : totals.sent.reason).toMatch(/Instantly/);
    expect(JSON.stringify(totals)).not.toContain('"value"');
  });

  it("reports unavailable when the sending accounts cannot be listed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = fakeClient({
      listAccounts: vi.fn(async () => {
        throw new Error("Instantly API GET /api/v2/accounts failed with 401");
      }),
    });

    const totals = await loadTodayInstantlySendTotals({
      now: NOW,
      client,
      apiKey: "test-key",
      sendingDomains: ["printeriq-mail.com"],
    });

    expect(totals.sent.available).toBe(false);
    expect(totals.bounces.available).toBe(false);
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
    expect(client.getDailyAccountAnalytics).not.toHaveBeenCalled();
  });

  it("reports unavailable when no mailbox matches the configured domains", async () => {
    const client = fakeClient({
      listAccounts: vi.fn(async () => [account("someone@another-project.com")]),
    });

    const totals = await loadTodayInstantlySendTotals({
      now: NOW,
      client,
      apiKey: "test-key",
      sendingDomains: ["printeriq-mail.com"],
    });

    expect(totals.sent.available).toBe(false);
    expect(client.getDailyAccountAnalytics).not.toHaveBeenCalled();
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

    const totals = await loadTodayInstantlySendTotals({
      now: NOW,
      client,
      apiKey: "test-key",
      sendingDomains: ["printeriq-mail.com"],
    });

    expect(totals.sent).toEqual({ available: true, value: 40 });
    expect(pauseLead).not.toHaveBeenCalled();
    expect(pauseCampaign).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });
});
