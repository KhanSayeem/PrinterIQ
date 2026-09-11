import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InstantlyAccount,
  InstantlyDailyAccountAnalytics,
  InstantlySentEmail,
  InstantlySentEmailsQuery,
} from "@/clients/instantly";

const { fakeClient } = vi.hoisted(() => ({
  fakeClient: {
    listAccounts: vi.fn(),
    getDailyAccountAnalytics: vi.fn(),
    listSentEmails: vi.fn(),
  },
}));

/**
 * Only the network is faked. The page, the per email loader and the report
 * model all run for real, so this pins what the operator actually sees rather
 * than what one layer hands the next.
 */
vi.mock("@/clients/instantly", () => ({
  InstantlyHttpClient: class {
    constructor() {
      return fakeClient;
    }
  },
}));

import DeliverabilityPage from "./page";

/** 16:15 on Friday 11 September 2026 in Sydney, when Instantly was checked for this bug. */
const NOW = new Date("2026-09-11T06:15:43.000Z");

function account(email: string, dailyLimit: number): InstantlyAccount {
  return {
    email,
    timestamp_created: "2026-06-17T00:00:00.000Z",
    warmup_status: 1,
    status: 1,
    daily_limit: dailyLimit,
    stat_warmup_score: 100,
  };
}

function sent(instant: string, eaccount: string): InstantlySentEmail {
  return { sentAt: new Date(instant), eaccount };
}

/**
 * The production shape on 2026-09-11. Every send goes out in the first hour of
 * the 09:00 to 17:00 Melbourne window, which is 23:00Z to 00:00Z on the
 * previous UTC date.
 */
const SENT_EMAILS = [
  // Wednesday 9 September, 09:10 Sydney.
  sent("2026-09-08T23:10:00.000Z", "murphy@presciaweb.com"),
  sent("2026-09-08T23:11:00.000Z", "murphy@presciaweb.com"),
  // Thursday 10 September, 09:xx Sydney.
  sent("2026-09-09T23:10:00.000Z", "murphy@presciaweb.com"),
  sent("2026-09-09T23:20:00.000Z", "murphy@presciaweb.com"),
  sent("2026-09-09T23:30:00.000Z", "murphy@presciaweb.com"),
  sent("2026-09-09T23:40:00.000Z", "murphy@presciaweb.com"),
  sent("2026-09-09T23:15:00.000Z", "daniel@presciaweb.com"),
  // Friday 11 September, today, 09:xx Sydney.
  sent("2026-09-10T23:05:00.000Z", "murphy@presciaweb.com"),
  sent("2026-09-10T23:25:00.000Z", "murphy@presciaweb.com"),
  sent("2026-09-10T23:45:00.000Z", "murphy@presciaweb.com"),
  sent("2026-09-10T23:55:00.000Z", "murphy@presciaweb.com"),
  sent("2026-09-10T23:06:00.000Z", "daniel@presciaweb.com"),
  sent("2026-09-10T23:26:00.000Z", "daniel@presciaweb.com"),
  sent("2026-09-10T23:46:00.000Z", "daniel@presciaweb.com"),
];

/**
 * What GET /api/v2/accounts/analytics/daily returns for the same sends: UTC
 * calendar days, and no row at all dated the 11th because nothing was sent
 * after 00:00Z on the 11th.
 */
const ANALYTICS: InstantlyDailyAccountAnalytics[] = [
  { date: "2026-09-08", email_account: "murphy@presciaweb.com", sent: 2, bounced: 0 },
  { date: "2026-09-09", email_account: "murphy@presciaweb.com", sent: 4, bounced: 0 },
  { date: "2026-09-09", email_account: "daniel@presciaweb.com", sent: 1, bounced: 0 },
  { date: "2026-09-10", email_account: "murphy@presciaweb.com", sent: 4, bounced: 0 },
  { date: "2026-09-10", email_account: "daniel@presciaweb.com", sent: 3, bounced: 0 },
];

function windowed(query: InstantlySentEmailsQuery) {
  return {
    emails: SENT_EMAILS.filter(
      (row) =>
        query.emails.includes(row.eaccount) &&
        row.sentAt.getTime() >= query.createdAtOrAfter.getTime() &&
        row.sentAt.getTime() < query.createdBefore.getTime(),
    ),
    complete: true,
  };
}

function estateCard(label: string): HTMLElement {
  const heading = [...document.querySelectorAll(".metric-card > .metric-label")].find(
    (node) => node.textContent === label,
  );
  const card = heading?.closest(".metric-card");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`No estate card labelled ${label}`);
  }
  return card;
}

function mailboxMetric(email: string, label: string): HTMLElement {
  const card = screen.getByRole("group", { name: email });
  return within(card).getByRole("group", { name: label });
}

describe("DeliverabilityPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("INSTANTLY_API_KEY", "test-key");
    vi.stubEnv("INSTANTLY_SENDING_DOMAINS", "presciaweb.com");
    vi.stubEnv("DASHBOARD_TIMEZONE", "Australia/Sydney");

    fakeClient.listAccounts.mockReset();
    fakeClient.getDailyAccountAnalytics.mockReset();
    fakeClient.listSentEmails.mockReset();

    fakeClient.listAccounts.mockResolvedValue([
      account("murphy@presciaweb.com", 20),
      account("daniel@presciaweb.com", 19),
      account("sales@adsiqdigital.com", 30),
    ]);
    fakeClient.getDailyAccountAnalytics.mockResolvedValue(ANALYTICS);
    fakeClient.listSentEmails.mockImplementation(async (query: InstantlySentEmailsQuery) =>
      windowed(query),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("shows today's Sydney sends, not the empty UTC row dated today", async () => {
    render(await DeliverabilityPage());

    expect(within(estateCard("Sent today")).getByText("7")).toBeInTheDocument();
    expect(within(mailboxMetric("murphy@presciaweb.com", "Sent today")).getByText("4")).toBeInTheDocument();
    expect(
      within(mailboxMetric("murphy@presciaweb.com", "Limit used today")).getByText("20.0%"),
    ).toBeInTheDocument();
    expect(within(mailboxMetric("daniel@presciaweb.com", "Sent today")).getByText("3")).toBeInTheDocument();
  });

  it("ramps on completed Sydney days, not on the UTC row holding this morning", async () => {
    render(await DeliverabilityPage());

    // Murphy sent 2 on Wednesday and 4 on Thursday: +100%. Read off the UTC
    // rows the latest "completed" day would have been today's 4.
    expect(
      within(mailboxMetric("murphy@presciaweb.com", "Day over day volume")).getByText("+100.0%"),
    ).toBeInTheDocument();
    // Daniel sent only on Thursday among the completed days.
    expect(
      within(mailboxMetric("daniel@presciaweb.com", "Day over day volume")).getByText("Not available"),
    ).toBeInTheDocument();
  });

  it("still reads the 30 day analytics for the bounce window", async () => {
    render(await DeliverabilityPage());

    expect(fakeClient.getDailyAccountAnalytics).toHaveBeenCalledWith({
      emails: ["murphy@presciaweb.com", "daniel@presciaweb.com"],
      startDate: "2026-08-13",
      endDate: "2026-09-11",
    });
  });

  it("asks only about the PrinterIQ mailboxes", async () => {
    render(await DeliverabilityPage());

    // Today, and the completed days behind it for the ramp.
    expect(fakeClient.listSentEmails).toHaveBeenCalledTimes(2);
    for (const [query] of fakeClient.listSentEmails.mock.calls as [InstantlySentEmailsQuery][]) {
      expect(query.emails).toEqual(["murphy@presciaweb.com", "daniel@presciaweb.com"]);
    }
  });

  it("says sent today is not available, never 0, when Instantly's sent email cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fakeClient.listSentEmails.mockRejectedValue(new Error("Instantly API GET /api/v2/emails failed with 429"));

    render(await DeliverabilityPage());

    const estate = estateCard("Sent today");
    expect(within(estate).getByText("Not available")).toBeInTheDocument();
    expect(within(estate).getByText(/Instantly did not return today's sent email/)).toBeInTheDocument();
    expect(within(estate).queryByText("0")).not.toBeInTheDocument();

    for (const email of ["murphy@presciaweb.com", "daniel@presciaweb.com"]) {
      expect(within(mailboxMetric(email, "Sent today")).getByText("Not available")).toBeInTheDocument();
      expect(within(mailboxMetric(email, "Limit used today")).queryByText("0.0%")).not.toBeInTheDocument();
    }
  });

  it("keeps today's sends on screen when only the daily analytics fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fakeClient.getDailyAccountAnalytics.mockRejectedValue(new Error("Instantly API GET failed with 500"));

    render(await DeliverabilityPage());

    expect(within(estateCard("Sent today")).getByText("7")).toBeInTheDocument();
    expect(screen.getByText(/30 day send and bounce counts and the bounce rate are not available/)).toBeInTheDocument();
  });
});
