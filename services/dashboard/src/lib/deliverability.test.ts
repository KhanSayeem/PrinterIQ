import { describe, expect, it } from "vitest";
import {
  BOUNCE_RATE_INVESTIGATE_THRESHOLD,
  GOOGLE_SPAM_RATE_HARD_LIMIT,
  GOOGLE_SPAM_RATE_TARGET,
  MAX_DAILY_RAMP_INCREASE,
  buildDeliverabilityReport,
  filterAccountsBySendingDomains,
  sendingDayIsoDate,
} from "./deliverability";
import type { InstantlyAccount, InstantlyDailyAccountAnalytics } from "@/clients/instantly";

const TODAY = "2026-09-09";

function account(overrides: Partial<InstantlyAccount> = {}): InstantlyAccount {
  return {
    email: "murphy@presciaweb.com",
    timestamp_created: "2026-06-17T00:00:00.000Z",
    warmup_status: 1,
    status: 1,
    daily_limit: 20,
    stat_warmup_score: 100,
    setup_pending: false,
    ...overrides,
  };
}

function day(
  date: string,
  sent: number,
  bounced: number,
  email = "murphy@presciaweb.com",
): InstantlyDailyAccountAnalytics {
  return { date, email_account: email, sent, bounced };
}

describe("published thresholds", () => {
  it("uses the figures Google publishes for spam rate and volume ramp", () => {
    expect(GOOGLE_SPAM_RATE_TARGET).toBe(0.001);
    expect(GOOGLE_SPAM_RATE_HARD_LIMIT).toBe(0.003);
    expect(MAX_DAILY_RAMP_INCREASE).toBe(1);
    expect(BOUNCE_RATE_INVESTIGATE_THRESHOLD).toBe(0.03);
  });
});

describe("sendingDayIsoDate", () => {
  it("reads the sending day in the estate timezone, not UTC", () => {
    // 2026-09-09T22:30Z is already 2026-09-10 in Sydney.
    expect(sendingDayIsoDate(new Date("2026-09-09T22:30:00.000Z"), "Australia/Sydney")).toBe(
      "2026-09-10",
    );
    expect(sendingDayIsoDate(new Date("2026-09-09T01:00:00.000Z"), "Australia/Sydney")).toBe(
      "2026-09-09",
    );
  });
});

describe("filterAccountsBySendingDomains", () => {
  it("keeps only the domains this project sends from", () => {
    const accounts = [
      account({ email: "murphy@presciaweb.com" }),
      account({ email: "sales@adsiqdigital.com" }),
    ];

    const filtered = filterAccountsBySendingDomains(accounts, ["presciaweb.com"]);

    expect(filtered.map((item) => item.email)).toEqual(["murphy@presciaweb.com"]);
  });

  it("returns every account when no domain allowlist is configured", () => {
    const accounts = [
      account({ email: "murphy@presciaweb.com" }),
      account({ email: "sales@adsiqdigital.com" }),
    ];

    expect(filterAccountsBySendingDomains(accounts, [])).toHaveLength(2);
  });
});

describe("buildDeliverabilityReport per mailbox", () => {
  it("renders the mailbox address, its domain, warmup, limit usage and score", () => {
    const report = buildDeliverabilityReport({
      accounts: [account({ email: "murphy@presciaweb.com", daily_limit: 20, stat_warmup_score: 100 })],
      analytics: [day(TODAY, 15, 0)],
      today: TODAY,
    });

    const mailbox = report.mailboxes[0]!;
    expect(mailbox.email).toBe("murphy@presciaweb.com");
    expect(mailbox.domain).toBe("presciaweb.com");
    expect(mailbox.warmupEnabled).toBe(true);
    expect(mailbox.warmupStatusLabel).toBe("Active");
    expect(mailbox.accountStatusLabel).toBe("Active");
    expect(mailbox.isPaused).toBe(false);
    expect(mailbox.dailyLimit).toEqual({ available: true, value: 20 });
    expect(mailbox.sentToday).toEqual({ available: true, value: 15 });
    expect(mailbox.limitUsedPct).toEqual({ available: true, value: 75 });
    expect(mailbox.warmupScore).toEqual({ available: true, value: 100 });
    expect(mailbox.verdict).toBe("ok");
  });

  it("counts today as zero sends when analytics loaded but carry no row for today", () => {
    const report = buildDeliverabilityReport({
      accounts: [account()],
      analytics: [day("2026-09-08", 10, 0)],
      today: TODAY,
    });

    expect(report.mailboxes[0]!.sentToday).toEqual({ available: true, value: 0 });
  });

  it("reports a paused account as paused rather than active", () => {
    const report = buildDeliverabilityReport({
      accounts: [account({ status: 2 })],
      analytics: [],
      today: TODAY,
    });

    const mailbox = report.mailboxes[0]!;
    expect(mailbox.isPaused).toBe(true);
    expect(mailbox.isActive).toBe(false);
    expect(mailbox.accountStatusLabel).toBe("Paused");
  });

  it("treats a sending account error as a critical breach", () => {
    const report = buildDeliverabilityReport({
      accounts: [account({ status: -2 })],
      analytics: [],
      today: TODAY,
    });

    const mailbox = report.mailboxes[0]!;
    expect(mailbox.accountStatusLabel).toBe("Soft Bounce Error");
    expect(mailbox.verdict).toBe("critical");
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("account-status");
  });
});

describe("bounce rate threshold", () => {
  it("stays ok just below the 3% investigate line", () => {
    const report = buildDeliverabilityReport({
      accounts: [account()],
      analytics: [day("2026-09-08", 1000, 29)],
      today: TODAY,
    });

    expect(report.mailboxes[0]!.bounceRate).toEqual({ available: true, value: 0.029 });
    expect(report.mailboxes[0]!.verdict).toBe("ok");
  });

  it("stays ok exactly at 3% because the rule is above the line", () => {
    const report = buildDeliverabilityReport({
      accounts: [account()],
      analytics: [day("2026-09-08", 1000, 30)],
      today: TODAY,
    });

    expect(report.mailboxes[0]!.bounceRate).toEqual({ available: true, value: 0.03 });
    expect(report.mailboxes[0]!.verdict).toBe("ok");
    expect(report.mailboxes[0]!.breaches).toHaveLength(0);
  });

  it("turns critical one bounce above the 3% line", () => {
    const report = buildDeliverabilityReport({
      accounts: [account()],
      analytics: [day("2026-09-08", 1000, 31)],
      today: TODAY,
    });

    const mailbox = report.mailboxes[0]!;
    expect(mailbox.bounceRate).toEqual({ available: true, value: 0.031 });
    expect(mailbox.verdict).toBe("critical");
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("bounce-rate");
  });

  it("shows the bounce rate as unavailable rather than 0% when nothing has been sent", () => {
    const report = buildDeliverabilityReport({
      accounts: [account()],
      analytics: [day("2026-09-08", 0, 0)],
      today: TODAY,
    });

    const mailbox = report.mailboxes[0]!;
    expect(mailbox.bounceRate.available).toBe(false);
    expect(mailbox.verdict).toBe("unknown");
  });
});

describe("volume ramp threshold", () => {
  it("stays ok at a 100% day over day increase, the top of Google's published band", () => {
    const report = buildDeliverabilityReport({
      accounts: [account()],
      analytics: [day("2026-09-07", 40, 0), day("2026-09-08", 80, 0)],
      today: TODAY,
    });

    const mailbox = report.mailboxes[0]!;
    expect(mailbox.dayOverDayIncrease).toEqual({ available: true, value: 1 });
    expect(mailbox.verdict).toBe("ok");
  });

  it("warns one send above a 100% day over day increase", () => {
    const report = buildDeliverabilityReport({
      accounts: [account()],
      analytics: [day("2026-09-07", 40, 0), day("2026-09-08", 81, 0)],
      today: TODAY,
    });

    const mailbox = report.mailboxes[0]!;
    expect(mailbox.verdict).toBe("warning");
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("ramp-speed");
  });

  it("stays ok just below a 100% day over day increase", () => {
    const report = buildDeliverabilityReport({
      accounts: [account()],
      analytics: [day("2026-09-07", 40, 0), day("2026-09-08", 79, 0)],
      today: TODAY,
    });

    expect(report.mailboxes[0]!.verdict).toBe("ok");
  });

  it("shows the ramp as unavailable when only one completed day has data", () => {
    const report = buildDeliverabilityReport({
      accounts: [account()],
      analytics: [day("2026-09-08", 80, 0)],
      today: TODAY,
    });

    expect(report.mailboxes[0]!.dayOverDayIncrease.available).toBe(false);
  });
});

describe("warmup state", () => {
  it("warns when warmup is switched off", () => {
    const report = buildDeliverabilityReport({
      accounts: [account({ warmup_status: 0 })],
      analytics: [day("2026-09-08", 100, 0)],
      today: TODAY,
    });

    const mailbox = report.mailboxes[0]!;
    expect(mailbox.warmupEnabled).toBe(false);
    expect(mailbox.warmupStatusLabel).toBe("Paused");
    expect(mailbox.verdict).toBe("warning");
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("warmup-off");
  });

  it("warns on any warmup state that is not active, not only on a paused one", () => {
    const report = buildDeliverabilityReport({
      accounts: [account({ warmup_status: -2 })],
      analytics: [day("2026-09-08", 100, 0)],
      today: TODAY,
    });

    const mailbox = report.mailboxes[0]!;
    expect(mailbox.warmupEnabled).toBe(false);
    expect(mailbox.warmupStatusLabel).toBe("Spam folder unknown");
    expect(mailbox.verdict).toBe("warning");
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("warmup-off");
  });

  it("treats a banned warmup as critical", () => {
    const report = buildDeliverabilityReport({
      accounts: [account({ warmup_status: -1 })],
      analytics: [day("2026-09-08", 100, 0)],
      today: TODAY,
    });

    const mailbox = report.mailboxes[0]!;
    expect(mailbox.warmupStatusLabel).toBe("Banned");
    expect(mailbox.verdict).toBe("critical");
  });
});

describe("unavailable metrics", () => {
  it("never renders a missing daily limit or warmup score as zero", () => {
    const report = buildDeliverabilityReport({
      accounts: [account({ daily_limit: null, stat_warmup_score: null })],
      analytics: [day(TODAY, 5, 0), day("2026-09-08", 100, 0)],
      today: TODAY,
    });

    const mailbox = report.mailboxes[0]!;
    expect(mailbox.dailyLimit.available).toBe(false);
    expect(mailbox.warmupScore.available).toBe(false);
    expect(mailbox.limitUsedPct.available).toBe(false);
    expect(mailbox.verdict).toBe("unknown");
  });

  it("marks every analytics backed metric unavailable when the analytics call failed", () => {
    const report = buildDeliverabilityReport({
      accounts: [account()],
      analytics: null,
      today: TODAY,
    });

    const mailbox = report.mailboxes[0]!;
    expect(mailbox.sentToday.available).toBe(false);
    expect(mailbox.bounceRate.available).toBe(false);
    expect(mailbox.dayOverDayIncrease.available).toBe(false);
    expect(mailbox.limitUsedPct.available).toBe(false);
    expect(mailbox.verdict).toBe("unknown");
    expect(report.verdict).toBe("unknown");
  });

  it("never exposes a spam complaint rate, because Instantly does not report one", () => {
    const report = buildDeliverabilityReport({
      accounts: [account()],
      analytics: [day("2026-09-08", 100, 0)],
      today: TODAY,
    });

    expect(report.spamComplaintRate.available).toBe(false);
  });
});

describe("over the daily limit", () => {
  it("warns when today's sends exceed the account's own daily limit", () => {
    const report = buildDeliverabilityReport({
      accounts: [account({ daily_limit: 20 })],
      analytics: [day(TODAY, 21, 0), day("2026-09-08", 20, 0)],
      today: TODAY,
    });

    const mailbox = report.mailboxes[0]!;
    expect(mailbox.verdict).toBe("warning");
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("over-daily-limit");
  });

  it("stays ok when today's sends exactly reach the daily limit", () => {
    const report = buildDeliverabilityReport({
      accounts: [account({ daily_limit: 20 })],
      analytics: [day(TODAY, 20, 0), day("2026-09-08", 20, 0)],
      today: TODAY,
    });

    expect(report.mailboxes[0]!.verdict).toBe("ok");
  });
});

describe("overall verdict", () => {
  it("reports the worst mailbox verdict across the estate", () => {
    const report = buildDeliverabilityReport({
      accounts: [
        account({ email: "a@presciaweb.com" }),
        account({ email: "b@presciaweb.com" }),
      ],
      analytics: [
        day("2026-09-08", 100, 0, "a@presciaweb.com"),
        day("2026-09-08", 100, 9, "b@presciaweb.com"),
      ],
      today: TODAY,
    });

    expect(report.verdict).toBe("critical");
    expect(report.criticalCount).toBe(1);
    expect(report.okCount).toBe(1);
  });

  it("reports ok only when every mailbox is ok", () => {
    const report = buildDeliverabilityReport({
      accounts: [account({ email: "a@presciaweb.com" }), account({ email: "b@presciaweb.com" })],
      analytics: [
        day("2026-09-08", 100, 1, "a@presciaweb.com"),
        day("2026-09-08", 100, 1, "b@presciaweb.com"),
      ],
      today: TODAY,
    });

    expect(report.verdict).toBe("ok");
    expect(report.okCount).toBe(2);
  });

  it("ranks a warning above an unknown so a real breach is never hidden", () => {
    const report = buildDeliverabilityReport({
      accounts: [
        account({ email: "a@presciaweb.com", warmup_status: 0 }),
        account({ email: "b@presciaweb.com", daily_limit: null }),
      ],
      analytics: [
        day("2026-09-08", 100, 0, "a@presciaweb.com"),
        day("2026-09-08", 100, 0, "b@presciaweb.com"),
      ],
      today: TODAY,
    });

    expect(report.verdict).toBe("warning");
    expect(report.warningCount).toBe(1);
    expect(report.unknownCount).toBe(1);
  });

  it("sorts the worst mailboxes to the top", () => {
    const report = buildDeliverabilityReport({
      accounts: [
        account({ email: "ok@presciaweb.com" }),
        account({ email: "bad@presciaweb.com" }),
      ],
      analytics: [
        day("2026-09-08", 100, 0, "ok@presciaweb.com"),
        day("2026-09-08", 100, 9, "bad@presciaweb.com"),
      ],
      today: TODAY,
    });

    expect(report.mailboxes.map((mailbox) => mailbox.email)).toEqual([
      "bad@presciaweb.com",
      "ok@presciaweb.com",
    ]);
  });

  it("returns an empty report with no verdict when Instantly lists no accounts", () => {
    const report = buildDeliverabilityReport({ accounts: [], analytics: [], today: TODAY });

    expect(report.mailboxes).toHaveLength(0);
    expect(report.verdict).toBe("unknown");
    expect(report.totalDailyLimit.available).toBe(false);
    expect(report.totalSentToday.available).toBe(false);
  });

  it("totals the estate limit and today's sends across mailboxes", () => {
    const report = buildDeliverabilityReport({
      accounts: [
        account({ email: "a@presciaweb.com", daily_limit: 20 }),
        account({ email: "b@presciaweb.com", daily_limit: 19 }),
      ],
      analytics: [day(TODAY, 7, 0, "a@presciaweb.com"), day(TODAY, 5, 0, "b@presciaweb.com")],
      today: TODAY,
    });

    expect(report.totalDailyLimit).toEqual({ available: true, value: 39 });
    expect(report.totalSentToday).toEqual({ available: true, value: 12 });
  });

  it("does not total a daily limit when one mailbox does not report one", () => {
    const report = buildDeliverabilityReport({
      accounts: [
        account({ email: "a@presciaweb.com", daily_limit: 20 }),
        account({ email: "b@presciaweb.com", daily_limit: null }),
      ],
      analytics: [day(TODAY, 7, 0, "a@presciaweb.com")],
      today: TODAY,
    });

    expect(report.totalDailyLimit.available).toBe(false);
  });
});
