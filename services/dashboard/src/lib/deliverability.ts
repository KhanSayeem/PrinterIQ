import type { InstantlyAccount, InstantlyDailyAccountAnalytics } from "@/clients/instantly";

/**
 * Deliverability health model for the sending estate.
 *
 * Thresholds and their sources:
 *
 * - Spam rate. Google's sender guidelines say to keep the spam rate below 0.1%
 *   and never let it reach 0.3% or higher, measured daily.
 *   https://support.google.com/a/answer/14229414
 *   Instantly's API exposes no spam complaint figure at all, on the account
 *   object or on the daily analytics rows, so this panel reports the spam rate
 *   as unavailable and never as 0%. ADR 005 also records that Postmaster Tools
 *   will not have complete data at this volume, and that the operating rule is
 *   therefore an absolute count: any spam complaint at all stops the ramp.
 *
 * - Bounce rate. 3% is the operating line this dashboard treats as "stop and
 *   investigate". Be clear about its provenance: neither Google nor Microsoft
 *   publishes a bounce rate threshold, and ADR 005 says so explicitly. 3% is a
 *   PrinterIQ operating threshold, not a provider published figure, and it is
 *   deliberately looser than the vendor "under 2%" material the ADR rejects.
 *
 * - Volume ramp. Google's guidance on increasing volume for a new sender
 *   describes "a common daily increase of 25% to 100%".
 *   https://support.google.com/mail/answer/15256272
 *   100% is therefore the top of the published band, and a day over day
 *   increase above it is flagged. ADR 005 paces the PrinterIQ ramp at about
 *   50% per day, inside that band.
 *
 * Every metric is an availability wrapper rather than a bare number. A metric
 * that the API does not report renders as "not available" and never as zero.
 * Issue #122 and the Apollo enrichment rows are both cases where a silent zero
 * in this system was read as a healthy result.
 */

/** Google: keep the spam rate below 0.1%. */
export const GOOGLE_SPAM_RATE_TARGET = 0.001;
/** Google: never let the spam rate reach 0.3% or higher. */
export const GOOGLE_SPAM_RATE_HARD_LIMIT = 0.003;
/** Google: a common daily volume increase is 25% to 100%. 1 is a 100% increase. */
export const MAX_DAILY_RAMP_INCREASE = 1;
/** PrinterIQ operating threshold, not a provider published figure. See the note above. */
export const BOUNCE_RATE_INVESTIGATE_THRESHOLD = 0.03;
/** Bounce rate is measured over a window because a single day at this volume is noise. */
export const BOUNCE_WINDOW_DAYS = 30;

export type MetricAvailability<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false; readonly reason: string };

export type HealthVerdict = "ok" | "warning" | "critical" | "unknown";

export type MailboxBreach = {
  readonly id: string;
  readonly severity: "warning" | "critical";
  readonly label: string;
  readonly detail: string;
};

export type MailboxHealth = {
  readonly email: string;
  readonly domain: string;
  readonly warmupEnabled: boolean;
  readonly warmupStatusLabel: string;
  readonly accountStatusLabel: string;
  readonly isActive: boolean;
  readonly isPaused: boolean;
  readonly dailyLimit: MetricAvailability<number>;
  readonly sentToday: MetricAvailability<number>;
  /** Percentage of the daily limit consumed today, 0 to 100 and above. */
  readonly limitUsedPct: MetricAvailability<number>;
  /** Fraction, so 0.031 is 3.1%. Measured over the analytics window. */
  readonly bounceRate: MetricAvailability<number>;
  readonly bouncedInWindow: MetricAvailability<number>;
  readonly sentInWindow: MetricAvailability<number>;
  readonly warmupScore: MetricAvailability<number>;
  /**
   * Fraction increase between the two most recent completed days that have
   * analytics rows, so 0.5 is a 50% increase. Today is excluded because a day
   * in progress cannot be compared with a finished one.
   */
  readonly dayOverDayIncrease: MetricAvailability<number>;
  readonly verdict: HealthVerdict;
  readonly breaches: readonly MailboxBreach[];
};

export type DeliverabilityReport = {
  readonly mailboxes: readonly MailboxHealth[];
  readonly verdict: HealthVerdict;
  readonly criticalCount: number;
  readonly warningCount: number;
  readonly unknownCount: number;
  readonly okCount: number;
  readonly totalDailyLimit: MetricAvailability<number>;
  readonly totalSentToday: MetricAvailability<number>;
  /** Always unavailable. Instantly reports no spam complaint figure. */
  readonly spamComplaintRate: MetricAvailability<number>;
  readonly bounceWindowDays: number;
};

export type BuildDeliverabilityReportInput = {
  readonly accounts: readonly InstantlyAccount[];
  /** `null` means the daily analytics call did not return data at all. */
  readonly analytics: readonly InstantlyDailyAccountAnalytics[] | null;
  /** The sending day, YYYY-MM-DD, in the estate timezone. */
  readonly today: string;
};

const ANALYTICS_UNAVAILABLE = "Instantly daily analytics did not load";

function available<T>(value: T): MetricAvailability<T> {
  return { available: true, value };
}

function unavailable<T>(reason: string): MetricAvailability<T> {
  return { available: false, reason };
}

/**
 * Instantly reports one date per analytics row and the estate sends from
 * Australia. Deriving the sending day from UTC would roll the day over ten
 * hours early and make "sent today" read as zero for most of the working day.
 */
export function sendingDayIsoDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isoDateDaysBefore(isoDate: string, days: number): string {
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return parsed.toISOString().slice(0, 10);
}

/**
 * ADR 005: the workspace also holds accounts on domains that belong to a
 * different project and are not PrinterIQ capacity. An empty allowlist means
 * no filtering was configured, so every account is shown.
 */
export function filterAccountsBySendingDomains(
  accounts: readonly InstantlyAccount[],
  domains: readonly string[],
): InstantlyAccount[] {
  if (!domains.length) {
    return [...accounts];
  }

  const allowed = new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean));
  return accounts.filter((account) => allowed.has(domainOf(account.email)));
}

export function parseSendingDomains(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

const WARMUP_STATUS_LABELS: Record<number, string> = {
  0: "Paused",
  1: "Active",
  [-1]: "Banned",
  [-2]: "Spam folder unknown",
  [-3]: "Permanent suspension",
};

const ACCOUNT_STATUS_LABELS: Record<number, string> = {
  1: "Active",
  2: "Paused",
  3: "Paused for maintenance",
  [-1]: "Connection Error",
  [-2]: "Soft Bounce Error",
  [-3]: "Sending Error",
};

const VERDICT_RANK: Record<HealthVerdict, number> = {
  ok: 0,
  unknown: 1,
  warning: 2,
  critical: 3,
};

function worstVerdict(verdicts: readonly HealthVerdict[]): HealthVerdict {
  return verdicts.reduce<HealthVerdict>(
    (worst, current) => (VERDICT_RANK[current] > VERDICT_RANK[worst] ? current : worst),
    "ok",
  );
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function buildDeliverabilityReport(
  input: BuildDeliverabilityReportInput,
): DeliverabilityReport {
  const mailboxes = input.accounts
    .map((account) => buildMailboxHealth(account, input.analytics, input.today))
    .sort(
      (left, right) =>
        VERDICT_RANK[right.verdict] - VERDICT_RANK[left.verdict] ||
        left.email.localeCompare(right.email),
    );

  const counts = { critical: 0, warning: 0, unknown: 0, ok: 0 };
  for (const mailbox of mailboxes) {
    counts[mailbox.verdict] += 1;
  }

  return {
    mailboxes,
    verdict: mailboxes.length ? worstVerdict(mailboxes.map((mailbox) => mailbox.verdict)) : "unknown",
    criticalCount: counts.critical,
    warningCount: counts.warning,
    unknownCount: counts.unknown,
    okCount: counts.ok,
    totalDailyLimit: sumMetric(mailboxes.map((mailbox) => mailbox.dailyLimit)),
    totalSentToday: sumMetric(mailboxes.map((mailbox) => mailbox.sentToday)),
    spamComplaintRate: unavailable(
      "Instantly reports no spam complaint rate. Read it in Google Postmaster Tools.",
    ),
    bounceWindowDays: BOUNCE_WINDOW_DAYS,
  };
}

/**
 * A total is only meaningful when every mailbox contributed a real number.
 * Summing the mailboxes that happen to report one would understate the estate
 * and look like a confident answer.
 */
function sumMetric(metrics: readonly MetricAvailability<number>[]): MetricAvailability<number> {
  if (!metrics.length) {
    return unavailable("No sending accounts returned by Instantly");
  }
  if (metrics.some((metric) => !metric.available)) {
    return unavailable("At least one mailbox did not report this figure");
  }

  return available(
    metrics.reduce((total, metric) => total + (metric.available ? metric.value : 0), 0),
  );
}

function buildMailboxHealth(
  account: InstantlyAccount,
  analytics: readonly InstantlyDailyAccountAnalytics[] | null,
  today: string,
): MailboxHealth {
  const breaches: MailboxBreach[] = [];
  const rows = analytics
    ? analytics
        .filter((row) => row.email_account.toLowerCase() === account.email.toLowerCase())
        .slice()
        .sort((left, right) => left.date.localeCompare(right.date))
    : null;

  const accountStatus = account.status ?? 1;
  const accountStatusLabel = ACCOUNT_STATUS_LABELS[accountStatus] ?? `Unknown status ${accountStatus}`;
  const warmupStatusLabel = WARMUP_STATUS_LABELS[account.warmup_status] ?? `Unknown warmup status ${account.warmup_status}`;

  if (accountStatus < 0) {
    breaches.push({
      id: "account-status",
      severity: "critical",
      label: "Sending account error",
      detail: `Instantly reports ${accountStatusLabel}. This mailbox is not sending.`,
    });
  }

  if (account.warmup_status === -1 || account.warmup_status === -3) {
    breaches.push({
      id: "warmup-banned",
      severity: "critical",
      label: "Warmup banned or suspended",
      detail: `Instantly reports warmup ${warmupStatusLabel}. The domain reputation is already damaged.`,
    });
  } else if (account.warmup_status !== 1) {
    breaches.push({
      id: "warmup-off",
      severity: "warning",
      label: "Warmup is not running",
      detail:
        "ADR 005 keeps warmup running alongside the live campaign for the whole ramp. This mailbox is not warming.",
    });
  }

  const dailyLimit =
    typeof account.daily_limit === "number"
      ? available(account.daily_limit)
      : unavailable<number>("Instantly returned no daily limit for this account");

  const warmupScore =
    typeof account.stat_warmup_score === "number"
      ? available(account.stat_warmup_score)
      : unavailable<number>("Instantly returned no warmup score for this account");

  const sentToday: MetricAvailability<number> = rows
    ? available(rows.find((row) => row.date === today)?.sent ?? 0)
    : unavailable(ANALYTICS_UNAVAILABLE);

  const limitUsedPct =
    sentToday.available && dailyLimit.available && dailyLimit.value > 0
      ? available(round((sentToday.value / dailyLimit.value) * 100, 1))
      : unavailable<number>(
          sentToday.available ? "No daily limit to measure usage against" : ANALYTICS_UNAVAILABLE,
        );

  if (sentToday.available && dailyLimit.available && sentToday.value > dailyLimit.value) {
    breaches.push({
      id: "over-daily-limit",
      severity: "warning",
      label: "Over its daily limit",
      detail: `${sentToday.value} sent today against a limit of ${dailyLimit.value}.`,
    });
  }

  const windowSent = rows ? rows.reduce((total, row) => total + row.sent, 0) : null;
  const windowBounced = rows ? rows.reduce((total, row) => total + row.bounced, 0) : null;

  const sentInWindow =
    windowSent === null ? unavailable<number>(ANALYTICS_UNAVAILABLE) : available(windowSent);
  const bouncedInWindow =
    windowBounced === null ? unavailable<number>(ANALYTICS_UNAVAILABLE) : available(windowBounced);

  const bounceRate: MetricAvailability<number> =
    windowSent === null || windowBounced === null
      ? unavailable(ANALYTICS_UNAVAILABLE)
      : windowSent === 0
        ? unavailable(
            `Nothing sent in the last ${BOUNCE_WINDOW_DAYS} days, so there is no bounce rate to report`,
          )
        : available(round(windowBounced / windowSent, 4));

  if (bounceRate.available && bounceRate.value > BOUNCE_RATE_INVESTIGATE_THRESHOLD) {
    breaches.push({
      id: "bounce-rate",
      severity: "critical",
      label: "Bounce rate above 3%",
      detail: `${formatPercent(bounceRate.value)} over the last ${BOUNCE_WINDOW_DAYS} days. Stop sending from this mailbox and investigate the list.`,
    });
  }

  const dayOverDayIncrease = computeDayOverDayIncrease(rows, today);

  if (dayOverDayIncrease.available && dayOverDayIncrease.value > MAX_DAILY_RAMP_INCREASE) {
    breaches.push({
      id: "ramp-speed",
      severity: "warning",
      label: "Ramping faster than Google's band",
      detail: `Volume rose ${formatPercent(dayOverDayIncrease.value)} day over day. Google describes a common daily increase of 25% to 100%.`,
    });
  }

  /**
   * These four decide whether the mailbox can be judged at all. A configured,
   * sending account reports all of them, so a gap means the verdict is genuinely
   * unknown rather than healthy. The ramp figure is deliberately not in this
   * list: it needs two completed days of history by definition, and its absence
   * on a quiet estate is expected rather than a blind spot.
   */
  const hasUnavailableMetric = [dailyLimit, sentToday, bounceRate, warmupScore].some(
    (metric) => !metric.available,
  );

  const breachVerdict = worstVerdict(breaches.map((breach) => breach.severity));
  const verdict: HealthVerdict =
    breaches.length > 0 ? breachVerdict : hasUnavailableMetric ? "unknown" : "ok";

  return {
    email: account.email,
    domain: domainOf(account.email),
    warmupEnabled: account.warmup_status === 1,
    warmupStatusLabel,
    accountStatusLabel,
    isActive: accountStatus === 1,
    isPaused: accountStatus === 2 || accountStatus === 3,
    dailyLimit,
    sentToday,
    limitUsedPct,
    bounceRate,
    bouncedInWindow,
    sentInWindow,
    warmupScore,
    dayOverDayIncrease,
    verdict,
    breaches,
  };
}

/**
 * Compares the two most recent completed days that have analytics rows. Today
 * is excluded on purpose: a day in progress against a finished day would report
 * a fake collapse every morning.
 */
function computeDayOverDayIncrease(
  rows: readonly InstantlyDailyAccountAnalytics[] | null,
  today: string,
): MetricAvailability<number> {
  if (!rows) {
    return unavailable(ANALYTICS_UNAVAILABLE);
  }

  const completed = rows.filter((row) => row.date < today);
  if (completed.length < 2) {
    return unavailable("Fewer than two completed days of sending to compare");
  }

  const latest = completed[completed.length - 1]!;
  const previous = completed[completed.length - 2]!;

  if (previous.sent === 0) {
    return unavailable("The comparison day has no sends, so there is no increase to measure");
  }

  return available(round((latest.sent - previous.sent) / previous.sent, 4));
}

export function formatPercent(fraction: number, decimals = 1): string {
  return `${round(fraction * 100, decimals).toFixed(decimals)}%`;
}
