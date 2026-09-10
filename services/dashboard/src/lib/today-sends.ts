import { InstantlyHttpClient } from "@/clients/instantly";
import type { InstantlyDailyAccountAnalytics } from "@/clients/instantly";
import {
  filterAccountsBySendingDomains,
  parseSendingDomains,
  type MetricAvailability,
} from "@/lib/deliverability";
import { getSydneyIsoDate } from "@/lib/sydney-day";

/**
 * Today's real send and bounce counts, read from Instantly.
 *
 * `outreach_sends.sent_at` cannot answer this. It is stamped when a lead is
 * handed to Instantly, which happens minutes after the pipeline runs and hours
 * before Instantly opens the sending window, and nothing updates it once the
 * email actually goes out. Reading it as "emails out today" reported three
 * sends on a day Instantly had sent none.
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
export type TodaySendsClient = Pick<
  InstantlyHttpClient,
  "listAccounts" | "getDailyAccountAnalytics"
>;

export type LoadTodaySendTotalsOptions = {
  readonly now?: Date;
  readonly client?: TodaySendsClient;
  readonly apiKey?: string;
  readonly sendingDomains?: readonly string[];
};

const MISSING_API_KEY =
  "INSTANTLY_API_KEY is not configured, so today's send count cannot be read from Instantly.";
const MISSING_DOMAINS =
  "DELIVERABILITY_SENDING_DOMAINS is not set, so PrinterIQ mailboxes cannot be told apart from the other projects sharing this Instantly workspace.";
const NO_MATCHING_MAILBOX =
  "No Instantly mailbox matches the configured PrinterIQ sending domains.";
const ACCOUNTS_FAILED = "Instantly did not return the sending accounts.";
const ANALYTICS_FAILED = "Instantly daily analytics did not load.";

function available(value: number): MetricAvailability<number> {
  return { available: true, value };
}

function unavailableTotals(reason: string): TodaySendTotals {
  return { sent: { available: false, reason }, bounces: { available: false, reason } };
}

/**
 * Sums the rows Instantly stamped with today's date. Rows for other days are
 * dropped rather than summed, so an operator reading "sent today" is not shown
 * the whole analytics window.
 */
export function totalsFromDailyAnalytics(
  rows: readonly InstantlyDailyAccountAnalytics[],
  today: string,
): TodaySendTotals {
  const todayRows = rows.filter((row) => row.date === today);

  return {
    sent: available(todayRows.reduce((total, row) => total + row.sent, 0)),
    bounces: available(todayRows.reduce((total, row) => total + row.bounced, 0)),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Instantly error";
}

/**
 * Read only. Lists the sending accounts, keeps the PrinterIQ ones, and asks for
 * their daily analytics for the Sydney day. Never throws: a failure comes back
 * as an unavailable total with the reason attached.
 */
export async function loadTodayInstantlySendTotals(
  options: LoadTodaySendTotalsOptions = {},
): Promise<TodaySendTotals> {
  const now = options.now ?? new Date();
  const today = getSydneyIsoDate(now);
  const apiKey = options.apiKey === undefined ? process.env.INSTANTLY_API_KEY : options.apiKey;

  if (!apiKey) {
    return unavailableTotals(MISSING_API_KEY);
  }

  /**
   * Both env vars name the same five PrinterIQ domains and both are set in
   * production. Without either one, every mailbox in the workspace would be
   * counted, including another project's, so the honest answer is that the
   * figure is not available rather than a plausible larger number.
   */
  const sendingDomains =
    options.sendingDomains ??
    parseSendingDomains(
      process.env.DELIVERABILITY_SENDING_DOMAINS || process.env.INSTANTLY_SENDING_DOMAINS,
    );

  if (!sendingDomains.length) {
    return unavailableTotals(MISSING_DOMAINS);
  }

  const client = options.client ?? new InstantlyHttpClient({ apiKey });

  let mailboxes;
  try {
    const accounts = await client.listAccounts();
    mailboxes = filterAccountsBySendingDomains(accounts, [...sendingDomains]);
  } catch (error) {
    console.error("Failed to load Instantly sending accounts for the today bar", {
      message: errorMessage(error),
    });
    return unavailableTotals(ACCOUNTS_FAILED);
  }

  if (!mailboxes.length) {
    return unavailableTotals(NO_MATCHING_MAILBOX);
  }

  try {
    const rows = await client.getDailyAccountAnalytics({
      emails: mailboxes.map((mailbox) => mailbox.email),
      startDate: today,
      endDate: today,
    });

    return totalsFromDailyAnalytics(rows, today);
  } catch (error) {
    console.error("Failed to load Instantly daily analytics for the today bar", {
      message: errorMessage(error),
    });
    return unavailableTotals(ANALYTICS_FAILED);
  }
}
