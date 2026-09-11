import { InstantlyHttpClient } from "@/clients/instantly";
import type { InstantlySentEmail } from "@/clients/instantly";
import {
  filterAccountsBySendingDomains,
  mailboxKey,
  sendingDayIsoDate,
  type MailboxSends,
  type MetricAvailability,
  type SydneyDaySends,
} from "@/lib/deliverability";
import { MISSING_SENDING_DOMAINS_MESSAGE, resolveSendingDomains } from "@/lib/sending-domains";
import { SYDNEY_TIME_ZONE, getSydneyDayRange, type SydneyDayRange } from "@/lib/sydney-day";

/**
 * Today's real send count, read from Instantly.
 *
 * `outreach_sends.sent_at` cannot answer this. It is stamped when a lead is
 * handed to Instantly, which happens minutes after the pipeline runs and hours
 * before Instantly opens the sending window, and nothing updates it once the
 * email actually goes out. Reading it as "emails out today" reported three
 * sends on a day Instantly had sent none.
 *
 * Instantly's own pre-aggregated day cannot answer it either. Its daily
 * analytics rows are bucketed by UTC calendar date, established against the
 * live API: four sends recorded at 23:47:25Z and 23:56:26Z on 9 September and
 * 00:04:26Z and 00:05:27Z on 10 September were reported as 28 sends on the 9th
 * and 2 on the 10th, summing to the campaign's lifetime total. The bucket
 * boundary sits at UTC midnight.
 *
 * That boundary falls in the middle of the Australian sending day. The
 * campaigns send between 09:00 and 17:00, which in AEST is 23:00Z to 07:00Z, so
 * every Australian sending day straddles UTC midnight and lands in two UTC
 * buckets. Asking the daily endpoint for one Sydney date therefore reads low
 * for the first hour of the window and high afterwards, because the bucket it
 * returns is mostly the previous Australian day's tail.
 *
 * So this module counts sends itself, one email at a time, from
 * GET /api/v2/emails. Each row carries the UTC instant Instantly recorded it
 * at, and the Sydney day it belongs to is then decided here by arithmetic this
 * module owns rather than by a bucket boundary it does not control.
 *
 * The sending window is configured in Australia/Melbourne while the dashboard's
 * day is Australia/Sydney. Australia/Sydney is used throughout, because it is
 * the day the operator reads on the bar and the same day the database queries
 * use, and the two zones share an offset and the same daylight saving dates, so
 * their midnights are the same instant. Mixing them would not shift a boundary,
 * but naming one keeps the code honest about which it means.
 *
 * Every figure here is an availability wrapper. A failed call reports "not
 * available" with its reason and never a zero: a zero on this bar reads as a
 * quiet sending day and is indistinguishable from an API outage.
 */
export type TodaySendTotals = {
  readonly sent: MetricAvailability<number>;
  readonly bounces: MetricAvailability<number>;
};

/** Only the two read only calls this module makes, so tests inject a fake. */
export type TodaySendsClient = Pick<InstantlyHttpClient, "listAccounts" | "listSentEmails">;

export type LoadTodaySendTotalsOptions = {
  readonly now?: Date;
  readonly client?: TodaySendsClient;
  readonly apiKey?: string;
  readonly sendingDomains?: readonly string[];
};

const MISSING_API_KEY =
  "INSTANTLY_API_KEY is not configured, so today's send count cannot be read from Instantly.";
const MISSING_DOMAINS = MISSING_SENDING_DOMAINS_MESSAGE;
const NO_MATCHING_MAILBOX =
  "No Instantly mailbox matches the configured PrinterIQ sending domains.";
const ACCOUNTS_FAILED = "Instantly did not return the sending accounts.";
const SENT_EMAILS_FAILED = "Instantly did not return today's sent email.";
const TOO_MANY_SENT_EMAILS =
  "Today has more sent email than one dashboard load will page through, so the count would be short.";

/**
 * Instantly publishes no per email bounce marker. The Email schema in the v2
 * OpenAPI document carries no bounce field, and every bounce figure the API
 * does publish, on the daily account analytics rows and on the campaign
 * analytics, is already summed into a UTC calendar day. A UTC day cannot be cut
 * at Sydney midnight, and half of an Australian sending day sits either side of
 * that cut, so there is no bounce figure for today to report.
 *
 * The bounce rate that is measured is the 30 day one on the deliverability
 * page, where a one day boundary error is a rounding error rather than most of
 * the number, and that is the figure the 3% operating threshold is read against.
 * The reason text carries no digits on purpose: it renders inside a tile whose
 * whole point is that it is showing no number.
 */
const BOUNCES_NOT_BUCKETABLE =
  "Instantly reports bounces only as a whole UTC calendar day, which cannot be split at Sydney midnight. The measured figure is the rolling bounce rate on the deliverability page.";

function available(value: number): MetricAvailability<number> {
  return { available: true, value };
}

/**
 * Both figures unavailable, with one reason. Exported so a caller that has to
 * defend against this module throwing at all can still render the bar with a
 * stated reason instead of a zero or a blank panel.
 */
export function unavailableTodaySendTotals(reason: string): TodaySendTotals {
  return { sent: { available: false, reason }, bounces: { available: false, reason } };
}

const unavailableTotals = unavailableTodaySendTotals;

/** Sent count unavailable for its own reason, bounces for theirs. */
function sentUnavailable(reason: string): TodaySendTotals {
  return {
    sent: { available: false, reason },
    bounces: { available: false, reason: BOUNCES_NOT_BUCKETABLE },
  };
}

/**
 * How many of these emails belong to the given Sydney day.
 *
 * The range is half open, start inclusive and end exclusive, matching
 * `getSydneyDayRange` and the database window the rest of the bar uses. An
 * email recorded exactly at Sydney midnight belongs to the day that opens, not
 * to the one that closed.
 *
 * `mailboxes` is checked again here even though the request already asked
 * Instantly to filter by mailbox. The workspace is shared with other projects,
 * and a server side filter that quietly stopped working would otherwise inflate
 * a PrinterIQ figure with another project's sends.
 */
export function countSendsInSydneyDay(
  emails: readonly InstantlySentEmail[],
  day: SydneyDayRange,
  mailboxes: readonly string[],
): number {
  let total = 0;
  for (const count of countSendsByMailbox(emails, day, mailboxes).values()) {
    total += count;
  }
  return total;
}

/**
 * The same count as `countSendsInSydneyDay`, split by the mailbox each email
 * went out from (the row's `eaccount`), for the per mailbox cards on
 * /deliverability. Same half open range and the same mailbox check.
 *
 * Every configured mailbox gets an entry, starting at zero. Instantly answered
 * and the walk was complete by the time this runs, so a mailbox with no rows
 * genuinely sent nothing, and saying 0 is the truth. A mailbox with no entry at
 * all is then a different fact, "this count never covered it", which a caller
 * can report as missing instead of guessing a zero.
 */
export function countSendsByMailbox(
  emails: readonly InstantlySentEmail[],
  day: SydneyDayRange,
  mailboxes: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>(mailboxes.map((mailbox) => [mailboxKey(mailbox), 0]));
  const start = day.start.getTime();
  const end = day.end.getTime();

  for (const email of emails) {
    const key = mailboxKey(email.eaccount);
    const current = counts.get(key);
    if (current === undefined) {
      continue;
    }
    const sentAt = email.sentAt.getTime();
    if (sentAt >= start && sentAt < end) {
      counts.set(key, current + 1);
    }
  }

  return counts;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Instantly error";
}

/** Only the read only call a per email count makes, so tests inject a fake. */
export type SentEmailsClient = Pick<InstantlyHttpClient, "listSentEmails">;

type SentEmailsWindowMessages = {
  /** Shown to the operator when the call throws. */
  readonly failed: string;
  /** Shown to the operator when the page walk hit its cap. */
  readonly truncated: string;
  /** Names the caller in the server log. Never a mailbox or a lead. */
  readonly logContext: string;
};

/**
 * Every sent email these mailboxes recorded inside the window, or the reason
 * there is no answer. Shared by the today bar and /deliverability so that both
 * treat a failed call and a truncated walk the same way: as missing, never as a
 * zero and never as a short count. Never throws.
 */
async function loadSentEmailsInWindow(
  client: SentEmailsClient,
  mailboxes: readonly string[],
  window: SydneyDayRange,
  messages: SentEmailsWindowMessages,
): Promise<MetricAvailability<readonly InstantlySentEmail[]>> {
  let result;
  try {
    result = await client.listSentEmails({
      emails: mailboxes,
      createdAtOrAfter: window.start,
      createdBefore: window.end,
    });
  } catch (error) {
    console.error(`Failed to load sent email from Instantly for ${messages.logContext}`, {
      message: errorMessage(error),
    });
    return { available: false, reason: messages.failed };
  }

  /**
   * A truncated page walk is a short count, and a short count rendered as a day
   * total is the same lie in a different direction. It is reported as missing.
   */
  if (!result.complete) {
    console.error(`Instantly sent email did not fit the page budget for ${messages.logContext}`, {
      pagedRows: result.emails.length,
    });
    return { available: false, reason: messages.truncated };
  }

  return { available: true, value: result.emails };
}

/**
 * How many completed Sydney days /deliverability counts behind today for the
 * day over day ramp.
 *
 * The ramp compares the two most recent completed days on which a mailbox sent.
 * Both campaigns send Monday to Friday only (read from their Instantly schedules
 * on 2026-09-11), so on a Monday those two days are Friday and Thursday, three
 * and four days back, and on a Tuesday they are Monday and Friday. Four days is
 * the shortest window that always holds them.
 *
 * It is also the page budget talking. Four days hold at most four sending days,
 * and the estate on 2026-09-11 was ten mailboxes with daily limits of 19 and 20,
 * so a full window is about 800 emails against the 1,000 one walk pages through.
 * A larger estate overflows the walk and the ramp then reads "not available"
 * with the reason, which is honest, rather than comparing a short day.
 */
export const RAMP_LOOKBACK_DAYS = 4;

const DELIVERABILITY_TODAY_FAILED =
  "Instantly did not return today's sent email, so today's sends cannot be counted.";
const DELIVERABILITY_TODAY_TRUNCATED =
  "Today has more sent email than one page load will page through, so the count would be short.";
const DELIVERABILITY_RECENT_FAILED =
  "Instantly did not return the last few days of sent email, so there is no completed day to compare.";
const DELIVERABILITY_RECENT_TRUNCATED =
  "The last few days hold more sent email than one page load will page through, so a day would be short.";

/** The `count` Sydney days before `day`, oldest first. */
function sydneyDaysBefore(day: SydneyDayRange, count: number): SydneyDayRange[] {
  const days: SydneyDayRange[] = [];
  let cursor = day;
  for (let step = 0; step < count; step += 1) {
    // The last instant of the previous day, so its range comes from Sydney's
    // own calendar. A fixed 24 hours would be an hour out either side of a
    // daylight saving change.
    cursor = getSydneyDayRange(new Date(cursor.start.getTime() - 1));
    days.unshift(cursor);
  }
  return days;
}

export type LoadMailboxSendsOptions = {
  readonly client: SentEmailsClient;
  /** The PrinterIQ mailboxes already scoped by the caller. */
  readonly mailboxes: readonly string[];
  readonly now?: Date;
};

/**
 * Read only. Per mailbox send counts for /deliverability: today's Sydney day,
 * and each of the completed Sydney days the ramp compares.
 *
 * This replaces reading GET /api/v2/accounts/analytics/daily for both, and the
 * reason is the same UTC bucketing the header of this module documents, only
 * sharper than it first looked. On 2026-09-11 every one of the day's 30 sends
 * went out between 09:00 and 10:00 Sydney, which is 23:00Z to 00:00Z on the
 * previous UTC date. Read at 16:15 Sydney that day, the daily row dated the
 * 11th did not exist at all, which is why the page read "Sent today 0" on every
 * mailbox, and the row dated the 10th read 32: 2 stragglers from the 10th and
 * all 30 of the 11th. That row
 * was also what the ramp called the latest completed day, so the ramp was
 * comparing today, still in progress, against yesterday.
 *
 * Two calls rather than one, so a failure or an overflow in the lookback costs
 * the ramp and not the headline figure. Never throws.
 */
export async function loadMailboxSendsBySydneyDay(
  options: LoadMailboxSendsOptions,
): Promise<MailboxSends> {
  const { client, mailboxes } = options;
  const today = getSydneyDayRange(options.now ?? new Date());
  const completed = sydneyDaysBefore(today, RAMP_LOOKBACK_DAYS);
  const lookback: SydneyDayRange = { start: completed[0]!.start, end: today.start };

  const [todayEmails, recentEmails] = await Promise.all([
    loadSentEmailsInWindow(client, mailboxes, today, {
      failed: DELIVERABILITY_TODAY_FAILED,
      truncated: DELIVERABILITY_TODAY_TRUNCATED,
      logContext: "deliverability sent today",
    }),
    loadSentEmailsInWindow(client, mailboxes, lookback, {
      failed: DELIVERABILITY_RECENT_FAILED,
      truncated: DELIVERABILITY_RECENT_TRUNCATED,
      logContext: "the deliverability ramp",
    }),
  ]);

  return {
    today: todayEmails.available
      ? { available: true, value: countSendsByMailbox(todayEmails.value, today, mailboxes) }
      : todayEmails,
    completedDays: recentEmails.available
      ? {
          available: true,
          value: completed.map(
            (day): SydneyDaySends => ({
              date: sendingDayIsoDate(day.start, SYDNEY_TIME_ZONE),
              byMailbox: countSendsByMailbox(recentEmails.value, day, mailboxes),
            }),
          ),
        }
      : recentEmails,
  };
}

/**
 * Read only. Lists the sending accounts, keeps the PrinterIQ ones, and counts
 * the email they actually sent inside the Sydney day. Never throws: a failure
 * comes back as an unavailable total with the reason attached.
 */
export async function loadTodayInstantlySendTotals(
  options: LoadTodaySendTotalsOptions = {},
): Promise<TodaySendTotals> {
  const now = options.now ?? new Date();
  const day = getSydneyDayRange(now);
  const apiKey = options.apiKey === undefined ? process.env.INSTANTLY_API_KEY : options.apiKey;

  if (!apiKey) {
    return unavailableTotals(MISSING_API_KEY);
  }

  /**
   * One resolver for the whole estate, so this bar, /deliverability and
   * /sending can never scope themselves differently. Without either env var
   * every mailbox in the workspace would be counted, including another
   * project's, so the honest answer is that the figure is not available rather
   * than a plausible larger number.
   */
  const sendingDomains = options.sendingDomains ?? resolveSendingDomains();

  if (!sendingDomains.length) {
    return unavailableTotals(MISSING_DOMAINS);
  }

  const client = options.client ?? new InstantlyHttpClient({ apiKey });

  let mailboxes: string[];
  try {
    const accounts = await client.listAccounts();
    mailboxes = filterAccountsBySendingDomains(accounts, [...sendingDomains]).map(
      (account) => account.email,
    );
  } catch (error) {
    console.error("Failed to load Instantly sending accounts for the today bar", {
      message: errorMessage(error),
    });
    return unavailableTotals(ACCOUNTS_FAILED);
  }

  if (!mailboxes.length) {
    return unavailableTotals(NO_MATCHING_MAILBOX);
  }

  const emails = await loadSentEmailsInWindow(client, mailboxes, day, {
    failed: SENT_EMAILS_FAILED,
    truncated: TOO_MANY_SENT_EMAILS,
    logContext: "the today bar",
  });

  if (!emails.available) {
    return sentUnavailable(emails.reason);
  }

  return {
    sent: available(countSendsInSydneyDay(emails.value, day, mailboxes)),
    bounces: { available: false, reason: BOUNCES_NOT_BUCKETABLE },
  };
}
