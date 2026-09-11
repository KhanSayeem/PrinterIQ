import { describe, expect, it } from "vitest";
import {
  BOUNCE_RATE_INVESTIGATE_THRESHOLD,
  GOOGLE_SPAM_RATE_HARD_LIMIT,
  GOOGLE_SPAM_RATE_TARGET,
  MAX_DAILY_RAMP_INCREASE,
  MIN_SENDS_FOR_MAILBOX_BOUNCE_RATE,
  buildDeliverabilityReport,
  filterAccountsBySendingDomains,
  sendingDayIsoDate,
  type MailboxSendCounts,
  type MailboxSends,
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

/** A UTC calendar day row from GET /api/v2/accounts/analytics/daily. */
function day(
  date: string,
  sent: number,
  bounced: number,
  email = "murphy@presciaweb.com",
): InstantlyDailyAccountAnalytics {
  return { date, email_account: email, sent, bounced };
}

type Unavailable = { readonly unavailable: string };

function isUnavailable(value: object): value is Unavailable {
  return "unavailable" in value;
}

function counts(entries: Record<string, number>): MailboxSendCounts {
  return new Map(Object.entries(entries).map(([email, sent]) => [email.toLowerCase(), sent]));
}

/**
 * The report under test. `sentToday` and `completedDays` stand in for the per
 * email counts from GET /api/v2/emails. Left out, today reads a real zero for
 * every account and there are no completed days, so a test about bounce rate
 * or warmup is not accidentally about sends as well.
 */
function report(input: {
  accounts: InstantlyAccount[];
  analytics?: InstantlyDailyAccountAnalytics[] | null;
  sentToday?: Record<string, number> | Unavailable;
  completedDays?: ReadonlyArray<readonly [string, Record<string, number>]> | Unavailable;
}) {
  const sentToday =
    input.sentToday ?? Object.fromEntries(input.accounts.map((item) => [item.email, 0]));
  const completedDays = input.completedDays ?? [];

  const sends: MailboxSends = {
    today: isUnavailable(sentToday)
      ? { available: false, reason: sentToday.unavailable }
      : { available: true, value: counts(sentToday) },
    completedDays: isUnavailable(completedDays)
      ? { available: false, reason: completedDays.unavailable }
      : {
          available: true,
          value: completedDays.map(([date, byMailbox]) => ({ date, byMailbox: counts(byMailbox) })),
        },
  };

  return buildDeliverabilityReport({
    accounts: input.accounts,
    analytics: input.analytics === undefined ? [] : input.analytics,
    sends,
  });
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
    const result = report({
      accounts: [account({ email: "murphy@presciaweb.com", daily_limit: 20, stat_warmup_score: 100 })],
      // Two days so the window clears the 30 send floor. With today alone, 15
      // sends is too few to judge a bounce rate and the mailbox is rightly
      // unknown rather than ok.
      analytics: [day("2026-09-08", 15, 0), day(TODAY, 15, 0)],
      sentToday: { "murphy@presciaweb.com": 15 },
    });

    const mailbox = result.mailboxes[0]!;
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

  it("reports a paused account as paused rather than active", () => {
    const result = report({ accounts: [account({ status: 2 })], analytics: [] });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.isPaused).toBe(true);
    expect(mailbox.isActive).toBe(false);
    expect(mailbox.accountStatusLabel).toBe("Paused");
  });

  it("treats a sending account error as a critical breach", () => {
    const result = report({ accounts: [account({ status: -2 })], analytics: [] });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.accountStatusLabel).toBe("Soft Bounce Error");
    expect(mailbox.verdict).toBe("critical");
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("account-status");
  });
});

/**
 * Observed on production on 2026-09-11: every card read "Sent today 0" and
 * "Limit used today 0.0%" while Instantly had sent 30 that day. Read from the
 * API at 16:15 Sydney, all 30 went out between 09:00 and 10:00 Sydney, 23:00Z
 * to 00:00Z on the previous UTC date, so the daily analytics row dated the 11th
 * did not exist and the row dated the 10th read 32. Sent today now comes from
 * the per email count only.
 */
describe("sent today", () => {
  it("reads the per email count for the Sydney day, not the UTC analytics row", () => {
    const result = report({
      accounts: [account({ daily_limit: 20 })],
      // The UTC rows as Instantly returned them: none dated today, and the
      // previous date holding today's morning. Neither may reach sent today.
      analytics: [day("2026-09-07", 28, 2), day("2026-09-08", 32, 5)],
      sentToday: { "murphy@presciaweb.com": 4 },
    });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.sentToday).toEqual({ available: true, value: 4 });
    expect(mailbox.limitUsedPct).toEqual({ available: true, value: 20 });
    expect(result.totalSentToday).toEqual({ available: true, value: 4 });
  });

  it("ignores an analytics row dated today even when one exists", () => {
    const result = report({
      accounts: [account()],
      analytics: [day(TODAY, 9, 0)],
      sentToday: { "murphy@presciaweb.com": 4 },
    });

    expect(result.mailboxes[0]!.sentToday).toEqual({ available: true, value: 4 });
  });

  it("reports a real zero when Instantly answered and the mailbox has sent nothing yet", () => {
    const result = report({
      accounts: [account()],
      analytics: [day("2026-09-08", 32, 0)],
      sentToday: { "murphy@presciaweb.com": 0 },
    });

    expect(result.mailboxes[0]!.sentToday).toEqual({ available: true, value: 0 });
    expect(result.mailboxes[0]!.limitUsedPct).toEqual({ available: true, value: 0 });
  });

  it("puts each mailbox's sends on its own card and totals them for the estate", () => {
    const result = report({
      accounts: [
        account({ email: "a@presciaweb.com", daily_limit: 20 }),
        account({ email: "b@presciaweb.com", daily_limit: 19 }),
      ],
      sentToday: { "a@presciaweb.com": 7, "b@presciaweb.com": 5 },
    });

    const byEmail = new Map(result.mailboxes.map((mailbox) => [mailbox.email, mailbox]));
    expect(byEmail.get("a@presciaweb.com")!.sentToday).toEqual({ available: true, value: 7 });
    expect(byEmail.get("b@presciaweb.com")!.sentToday).toEqual({ available: true, value: 5 });
    expect(result.totalDailyLimit).toEqual({ available: true, value: 39 });
    expect(result.totalSentToday).toEqual({ available: true, value: 12 });
  });

  it("matches the count to the mailbox whatever case Instantly spelled the address in", () => {
    const result = report({
      accounts: [account({ email: "Murphy@PresciaWeb.com" })],
      sentToday: { "murphy@presciaweb.com": 3 },
    });

    expect(result.mailboxes[0]!.sentToday).toEqual({ available: true, value: 3 });
  });

  /**
   * A zero here reads as a quiet morning and is indistinguishable from an
   * outage, so a failed call has to say it failed.
   */
  it("reports sent today, limit used and the estate total as not available, never 0, when the call failed", () => {
    const reason = "Instantly did not return today's sent email.";
    const result = report({
      accounts: [account({ email: "a@presciaweb.com" }), account({ email: "b@presciaweb.com" })],
      analytics: [day("2026-09-08", 100, 0, "a@presciaweb.com"), day("2026-09-08", 100, 0, "b@presciaweb.com")],
      sentToday: { unavailable: reason },
    });

    for (const mailbox of result.mailboxes) {
      expect(mailbox.sentToday).toEqual({ available: false, reason });
      expect(mailbox.limitUsedPct).toEqual({ available: false, reason });
      expect(mailbox.verdict).toBe("unknown");
    }
    expect(result.totalSentToday).toEqual({ available: false, reason });
    expect(JSON.stringify(result.totalSentToday)).not.toContain('"value"');
  });

  it("reports a mailbox the count never covered as not available rather than 0", () => {
    const result = report({
      accounts: [account({ email: "a@presciaweb.com" }), account({ email: "b@presciaweb.com" })],
      sentToday: { "a@presciaweb.com": 7 },
    });

    const byEmail = new Map(result.mailboxes.map((mailbox) => [mailbox.email, mailbox]));
    expect(byEmail.get("b@presciaweb.com")!.sentToday.available).toBe(false);
    expect(byEmail.get("b@presciaweb.com")!.limitUsedPct.available).toBe(false);
    expect(result.totalSentToday.available).toBe(false);
  });

  it("keeps sent today when only the daily analytics call failed", () => {
    const result = report({
      accounts: [account()],
      analytics: null,
      sentToday: { "murphy@presciaweb.com": 4 },
    });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.sentToday).toEqual({ available: true, value: 4 });
    expect(mailbox.bounceRate.available).toBe(false);
  });
});

describe("bounce rate threshold", () => {
  it("stays ok just below the 3% investigate line", () => {
    const result = report({ accounts: [account()], analytics: [day("2026-09-08", 1000, 29)] });

    expect(result.mailboxes[0]!.bounceRate).toEqual({ available: true, value: 0.029 });
    expect(result.mailboxes[0]!.verdict).toBe("ok");
  });

  it("stays ok exactly at 3% because the rule is above the line", () => {
    const result = report({ accounts: [account()], analytics: [day("2026-09-08", 1000, 30)] });

    expect(result.mailboxes[0]!.bounceRate).toEqual({ available: true, value: 0.03 });
    expect(result.mailboxes[0]!.verdict).toBe("ok");
    expect(result.mailboxes[0]!.breaches).toHaveLength(0);
  });

  it("turns critical one bounce above the 3% line", () => {
    const result = report({ accounts: [account()], analytics: [day("2026-09-08", 1000, 31)] });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.bounceRate).toEqual({ available: true, value: 0.031 });
    expect(mailbox.verdict).toBe("critical");
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("bounce-rate");
  });

  it("shows the bounce rate as unavailable rather than 0% when nothing has been sent", () => {
    const result = report({ accounts: [account()], analytics: [day("2026-09-08", 0, 0)] });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.bounceRate.available).toBe(false);
    expect(mailbox.verdict).toBe("unknown");
  });
});

describe("volume ramp threshold", () => {
  it("stays ok at a 100% day over day increase, the top of Google's published band", () => {
    const result = report({
      accounts: [account()],
      analytics: [day("2026-09-07", 40, 0), day("2026-09-08", 80, 0)],
      completedDays: [
        ["2026-09-07", { "murphy@presciaweb.com": 40 }],
        ["2026-09-08", { "murphy@presciaweb.com": 80 }],
      ],
    });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.dayOverDayIncrease).toEqual({ available: true, value: 1 });
    expect(mailbox.verdict).toBe("ok");
  });

  it("warns one send above a 100% day over day increase", () => {
    const result = report({
      accounts: [account()],
      analytics: [day("2026-09-07", 40, 0), day("2026-09-08", 81, 0)],
      completedDays: [
        ["2026-09-07", { "murphy@presciaweb.com": 40 }],
        ["2026-09-08", { "murphy@presciaweb.com": 81 }],
      ],
    });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.verdict).toBe("warning");
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("ramp-speed");
  });

  it("stays ok just below a 100% day over day increase", () => {
    const result = report({
      accounts: [account()],
      analytics: [day("2026-09-07", 40, 0), day("2026-09-08", 79, 0)],
      completedDays: [
        ["2026-09-07", { "murphy@presciaweb.com": 40 }],
        ["2026-09-08", { "murphy@presciaweb.com": 79 }],
      ],
    });

    expect(result.mailboxes[0]!.verdict).toBe("ok");
  });

  it("shows the ramp as unavailable when only one completed day has sends", () => {
    const result = report({
      accounts: [account()],
      analytics: [day("2026-09-08", 80, 0)],
      completedDays: [
        ["2026-09-07", { "murphy@presciaweb.com": 0 }],
        ["2026-09-08", { "murphy@presciaweb.com": 80 }],
      ],
    });

    expect(result.mailboxes[0]!.dayOverDayIncrease.available).toBe(false);
  });

  /**
   * The UTC rows put Monday's 09:00 burst on Sunday's date and leave Friday's
   * date holding a couple of stragglers, so read off the analytics this would
   * be a 1,400% jump and a false warning every Monday. The Sydney days are flat.
   */
  it("compares Sydney days from the per email count, not the UTC analytics rows", () => {
    const result = report({
      accounts: [account()],
      analytics: [day("2026-09-04", 2, 0), day("2026-09-06", 30, 0)],
      completedDays: [
        ["2026-09-04", { "murphy@presciaweb.com": 30 }],
        ["2026-09-05", { "murphy@presciaweb.com": 0 }],
        ["2026-09-06", { "murphy@presciaweb.com": 0 }],
        ["2026-09-07", { "murphy@presciaweb.com": 30 }],
      ],
    });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.dayOverDayIncrease).toEqual({ available: true, value: 0 });
    expect(mailbox.breaches.map((breach) => breach.id)).not.toContain("ramp-speed");
  });

  /**
   * The campaigns send Monday to Friday. On a Tuesday the two most recent days
   * that sent are Monday and Friday, and the weekend between them is skipped
   * the way the old analytics rows skipped it, by having no sends.
   */
  it("skips the weekend, so Tuesday compares Monday with Friday", () => {
    const result = report({
      accounts: [account()],
      analytics: [day("2026-09-03", 40, 0), day("2026-09-06", 81, 0)],
      completedDays: [
        ["2026-09-04", { "murphy@presciaweb.com": 40 }],
        ["2026-09-05", { "murphy@presciaweb.com": 0 }],
        ["2026-09-06", { "murphy@presciaweb.com": 0 }],
        ["2026-09-07", { "murphy@presciaweb.com": 81 }],
      ],
    });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.dayOverDayIncrease).toEqual({ available: true, value: 1.025 });
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("ramp-speed");
  });

  it("never compares today, a day still in progress, with a finished day", () => {
    const result = report({
      accounts: [account()],
      analytics: [day("2026-09-08", 30, 0)],
      sentToday: { "murphy@presciaweb.com": 4 },
      completedDays: [["2026-09-08", { "murphy@presciaweb.com": 30 }]],
    });

    expect(result.mailboxes[0]!.dayOverDayIncrease.available).toBe(false);
  });

  it("shows the ramp as not available with the reason when the recent days could not be read", () => {
    const reason = "Instantly did not return the last few days of sent email.";
    const result = report({
      accounts: [account()],
      analytics: [day("2026-09-07", 40, 0), day("2026-09-08", 81, 0)],
      completedDays: { unavailable: reason },
    });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.dayOverDayIncrease).toEqual({ available: false, reason });
    expect(mailbox.breaches.map((breach) => breach.id)).not.toContain("ramp-speed");
  });

  it("keeps each mailbox's ramp to its own sends", () => {
    const result = report({
      accounts: [account({ email: "a@presciaweb.com" }), account({ email: "b@presciaweb.com" })],
      completedDays: [
        ["2026-09-07", { "a@presciaweb.com": 40, "b@presciaweb.com": 10 }],
        ["2026-09-08", { "a@presciaweb.com": 40, "b@presciaweb.com": 30 }],
      ],
    });

    const byEmail = new Map(result.mailboxes.map((mailbox) => [mailbox.email, mailbox]));
    expect(byEmail.get("a@presciaweb.com")!.dayOverDayIncrease).toEqual({ available: true, value: 0 });
    expect(byEmail.get("b@presciaweb.com")!.dayOverDayIncrease).toEqual({ available: true, value: 2 });
  });
});

describe("warmup state", () => {
  it("warns when warmup is switched off", () => {
    const result = report({
      accounts: [account({ warmup_status: 0 })],
      analytics: [day("2026-09-08", 100, 0)],
    });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.warmupEnabled).toBe(false);
    expect(mailbox.warmupStatusLabel).toBe("Paused");
    expect(mailbox.verdict).toBe("warning");
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("warmup-off");
  });

  it("warns on any warmup state that is not active, not only on a paused one", () => {
    const result = report({
      accounts: [account({ warmup_status: -2 })],
      analytics: [day("2026-09-08", 100, 0)],
    });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.warmupEnabled).toBe(false);
    expect(mailbox.warmupStatusLabel).toBe("Spam folder unknown");
    expect(mailbox.verdict).toBe("warning");
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("warmup-off");
  });

  it("treats a banned warmup as critical", () => {
    const result = report({
      accounts: [account({ warmup_status: -1 })],
      analytics: [day("2026-09-08", 100, 0)],
    });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.warmupStatusLabel).toBe("Banned");
    expect(mailbox.verdict).toBe("critical");
  });
});

describe("unavailable metrics", () => {
  it("never renders a missing daily limit or warmup score as zero", () => {
    const result = report({
      accounts: [account({ daily_limit: null, stat_warmup_score: null })],
      analytics: [day(TODAY, 5, 0), day("2026-09-08", 100, 0)],
      sentToday: { "murphy@presciaweb.com": 5 },
    });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.dailyLimit.available).toBe(false);
    expect(mailbox.warmupScore.available).toBe(false);
    expect(mailbox.limitUsedPct.available).toBe(false);
    expect(mailbox.verdict).toBe("unknown");
  });

  it("marks every analytics backed metric unavailable when the analytics call failed", () => {
    const result = report({ accounts: [account()], analytics: null });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.bounceRate.available).toBe(false);
    expect(mailbox.bouncedInWindow.available).toBe(false);
    expect(mailbox.sentInWindow.available).toBe(false);
    expect(mailbox.verdict).toBe("unknown");
    expect(result.verdict).toBe("unknown");
  });

  it("never exposes a spam complaint rate, because Instantly does not report one", () => {
    const result = report({ accounts: [account()], analytics: [day("2026-09-08", 100, 0)] });

    expect(result.spamComplaintRate.available).toBe(false);
  });
});

describe("over the daily limit", () => {
  it("warns when today's sends exceed the account's own daily limit", () => {
    const result = report({
      accounts: [account({ daily_limit: 20 })],
      analytics: [day(TODAY, 21, 0), day("2026-09-08", 20, 0)],
      sentToday: { "murphy@presciaweb.com": 21 },
    });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.verdict).toBe("warning");
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("over-daily-limit");
  });

  it("stays ok when today's sends exactly reach the daily limit", () => {
    const result = report({
      accounts: [account({ daily_limit: 20 })],
      analytics: [day(TODAY, 20, 0), day("2026-09-08", 20, 0)],
      sentToday: { "murphy@presciaweb.com": 20 },
    });

    expect(result.mailboxes[0]!.verdict).toBe("ok");
  });

  it("raises no limit breach when today's count could not be read", () => {
    const result = report({
      accounts: [account({ daily_limit: 20 })],
      analytics: [day(TODAY, 21, 0), day("2026-09-08", 20, 0)],
      sentToday: { unavailable: "Instantly did not return today's sent email." },
    });

    expect(result.mailboxes[0]!.breaches.map((breach) => breach.id)).not.toContain(
      "over-daily-limit",
    );
  });
});

describe("overall verdict", () => {
  it("reports the worst mailbox verdict across the estate", () => {
    const result = report({
      accounts: [account({ email: "a@presciaweb.com" }), account({ email: "b@presciaweb.com" })],
      analytics: [
        day("2026-09-08", 100, 0, "a@presciaweb.com"),
        day("2026-09-08", 100, 9, "b@presciaweb.com"),
      ],
    });

    expect(result.verdict).toBe("critical");
    expect(result.criticalCount).toBe(1);
    expect(result.okCount).toBe(1);
  });

  it("reports ok only when every mailbox is ok", () => {
    const result = report({
      accounts: [account({ email: "a@presciaweb.com" }), account({ email: "b@presciaweb.com" })],
      analytics: [
        day("2026-09-08", 100, 1, "a@presciaweb.com"),
        day("2026-09-08", 100, 1, "b@presciaweb.com"),
      ],
    });

    expect(result.verdict).toBe("ok");
    expect(result.okCount).toBe(2);
  });

  it("ranks a warning above an unknown so a real breach is never hidden", () => {
    const result = report({
      accounts: [
        account({ email: "a@presciaweb.com", warmup_status: 0 }),
        account({ email: "b@presciaweb.com", daily_limit: null }),
      ],
      analytics: [
        day("2026-09-08", 100, 0, "a@presciaweb.com"),
        day("2026-09-08", 100, 0, "b@presciaweb.com"),
      ],
    });

    expect(result.verdict).toBe("warning");
    expect(result.warningCount).toBe(1);
    expect(result.unknownCount).toBe(1);
  });

  it("sorts the worst mailboxes to the top", () => {
    const result = report({
      accounts: [account({ email: "ok@presciaweb.com" }), account({ email: "bad@presciaweb.com" })],
      analytics: [
        day("2026-09-08", 100, 0, "ok@presciaweb.com"),
        day("2026-09-08", 100, 9, "bad@presciaweb.com"),
      ],
    });

    expect(result.mailboxes.map((mailbox) => mailbox.email)).toEqual([
      "bad@presciaweb.com",
      "ok@presciaweb.com",
    ]);
  });

  it("returns an empty report with no verdict when Instantly lists no accounts", () => {
    const result = report({ accounts: [], analytics: [] });

    expect(result.mailboxes).toHaveLength(0);
    expect(result.verdict).toBe("unknown");
    expect(result.totalDailyLimit.available).toBe(false);
    expect(result.totalSentToday.available).toBe(false);
  });

  it("does not total a daily limit when one mailbox does not report one", () => {
    const result = report({
      accounts: [
        account({ email: "a@presciaweb.com", daily_limit: 20 }),
        account({ email: "b@presciaweb.com", daily_limit: null }),
      ],
      analytics: [day(TODAY, 7, 0, "a@presciaweb.com")],
    });

    expect(result.totalDailyLimit.available).toBe(false);
  });
});

describe("bounce rate volume floor", () => {
  it("needs 30 sends in the window before a mailbox's rate is judged", () => {
    expect(MIN_SENDS_FOR_MAILBOX_BOUNCE_RATE).toBe(30);
  });

  /**
   * Measured on 2026-09-11: five healthy mailboxes, active and warming at 98 to
   * 100, showed critical with "Stop sending from this mailbox" because 1 or 2 of
   * their 6 sends had bounced. The bounces came from unverified leads that were
   * pulled from the campaigns that morning, not from the mailboxes. At six sends
   * one bounce reads as 17%, so the 3% line cannot tell a bad mailbox from bad
   * luck, and a panel that cries wolf gets ignored the day it is right.
   */
  it("does not judge 2 bounced of 6 sent, and still shows both counts", () => {
    const result = report({
      accounts: [account()],
      analytics: [day("2026-09-10", 3, 1), day("2026-09-11", 3, 1)],
    });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.bounceRate.available).toBe(false);
    if (!mailbox.bounceRate.available) {
      expect(mailbox.bounceRate.reason).toContain("Too few sends");
      expect(mailbox.bounceRate.reason).toContain("30");
    }
    expect(mailbox.breaches.map((breach) => breach.id)).not.toContain("bounce-rate");
    expect(mailbox.verdict).toBe("unknown");
    expect(mailbox.bouncedInWindow).toEqual({ available: true, value: 2 });
    expect(mailbox.sentInWindow).toEqual({ available: true, value: 6 });
  });

  it("still does not judge one send below the floor", () => {
    const result = report({ accounts: [account()], analytics: [day("2026-09-08", 29, 5)] });

    expect(result.mailboxes[0]!.bounceRate.available).toBe(false);
    expect(result.mailboxes[0]!.verdict).toBe("unknown");
  });

  it("judges the rate from exactly the floor, and a real breach turns critical", () => {
    const result = report({ accounts: [account()], analytics: [day("2026-09-08", 30, 2)] });

    const mailbox = result.mailboxes[0]!;
    expect(mailbox.bounceRate).toEqual({ available: true, value: 0.0667 });
    expect(mailbox.verdict).toBe("critical");
    expect(mailbox.breaches.map((breach) => breach.id)).toContain("bounce-rate");
  });

  it("does not let the floor hide an account error", () => {
    const result = report({ accounts: [account({ status: -2 })], analytics: [day("2026-09-08", 6, 2)] });

    expect(result.mailboxes[0]!.verdict).toBe("critical");
  });
});
