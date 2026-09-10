import { InstantlyHttpClient } from "@/clients/instantly";
import type { InstantlySentEmail } from "@/clients/instantly";
import { filterAccountsBySendingDomains, type MetricAvailability } from "@/lib/deliverability";
import { MISSING_SENDING_DOMAINS_MESSAGE, resolveSendingDomains } from "@/lib/sending-domains";
import { getSydneyDayRange, type SydneyDayRange } from "@/lib/sydney-day";

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
  const allowed = new Set(mailboxes.map((mailbox) => mailbox.trim().toLowerCase()));
  const start = day.start.getTime();
  const end = day.end.getTime();

  return emails.filter((email) => {
    if (!allowed.has(email.eaccount.trim().toLowerCase())) {
      return false;
    }
    const sentAt = email.sentAt.getTime();
    return sentAt >= start && sentAt < end;
  }).length;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Instantly error";
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

  let result;
  try {
    result = await client.listSentEmails({
      emails: mailboxes,
      createdAtOrAfter: day.start,
      createdBefore: day.end,
    });
  } catch (error) {
    console.error("Failed to load today's sent email from Instantly for the today bar", {
      message: errorMessage(error),
    });
    return sentUnavailable(SENT_EMAILS_FAILED);
  }

  /**
   * A truncated page walk is a short count, and a short count rendered as a day
   * total is the same lie in a different direction. It is reported as missing.
   */
  if (!result.complete) {
    console.error("Today's Instantly sent email did not fit the page budget for the today bar", {
      pagedRows: result.emails.length,
    });
    return sentUnavailable(TOO_MANY_SENT_EMAILS);
  }

  return {
    sent: available(countSendsInSydneyDay(result.emails, day, mailboxes)),
    bounces: { available: false, reason: BOUNCES_NOT_BUCKETABLE },
  };
}
