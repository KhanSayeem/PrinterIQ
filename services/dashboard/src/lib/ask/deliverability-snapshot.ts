import "server-only";

import { InstantlyHttpClient } from "@/clients/instantly";
import type { InstantlyDailyAccountAnalytics } from "@/clients/instantly";
import {
  BOUNCE_WINDOW_DAYS,
  buildDeliverabilityReport,
  filterAccountsBySendingDomains,
  isoDateDaysBefore,
  sendingDayIsoDate,
  type MailboxSends,
  type MetricAvailability,
} from "@/lib/deliverability";
import { resolveSendingDomains } from "@/lib/sending-domains";
import { loadMailboxSendsBySydneyDay } from "@/lib/today-sends";

/**
 * The same composition /deliverability renders, flattened for the ask panel.
 *
 * The page keeps its own copy of this sequence because it has error UI at each
 * step. Here every failure becomes one unavailable reason, so the model says
 * "not available, because X" rather than reporting a healthy estate it could
 * not read.
 */

const DEFAULT_TIMEZONE = "Australia/Sydney";

/** One value plus its reason, flattened so the model does not have to walk a union. */
function flatten<T>(metric: MetricAvailability<T>): T | string {
  return metric.available ? metric.value : `not available: ${metric.reason}`;
}

export type DeliverabilitySnapshot = {
  readonly day: string;
  readonly timeZone: string;
  readonly verdict: string;
  readonly bounceWindowDays: number;
  readonly counts: { critical: number; warning: number; unknown: number; ok: number };
  readonly totalSentToday: number | string;
  readonly totalDailyLimit: number | string;
  readonly notice: string | null;
  readonly mailboxes: readonly Record<string, unknown>[];
};

export async function loadDeliverabilitySnapshot(
  now: Date = new Date(),
): Promise<MetricAvailability<DeliverabilitySnapshot>> {
  if (!process.env.INSTANTLY_API_KEY) {
    return {
      available: false,
      reason: "INSTANTLY_API_KEY is not configured, so mailbox health cannot be read.",
    };
  }

  const client = new InstantlyHttpClient();
  const timeZone = process.env.DASHBOARD_TIMEZONE || DEFAULT_TIMEZONE;
  const today = sendingDayIsoDate(now, timeZone);

  let accounts;
  try {
    accounts = await client.listAccounts();
  } catch (error) {
    return {
      available: false,
      reason: `Instantly sending accounts could not be read: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }

  const sendingDomains = resolveSendingDomains();
  const mailboxes = filterAccountsBySendingDomains(accounts, sendingDomains);

  const loadAnalytics = async (): Promise<InstantlyDailyAccountAnalytics[] | null> => {
    try {
      return await client.getDailyAccountAnalytics({
        emails: mailboxes.map((account) => account.email),
        startDate: isoDateDaysBefore(today, BOUNCE_WINDOW_DAYS - 1),
        endDate: today,
      });
    } catch (error) {
      console.error("Ask panel failed to load Instantly daily account analytics", {
        message: error instanceof Error ? error.message : "unknown error",
      });
      return null;
    }
  };

  const [analytics, sends]: [InstantlyDailyAccountAnalytics[] | null, MailboxSends] =
    await Promise.all([
      loadAnalytics(),
      loadMailboxSendsBySydneyDay({
        client,
        mailboxes: mailboxes.map((account) => account.email),
        now,
      }),
    ]);

  const report = buildDeliverabilityReport({ accounts: mailboxes, analytics, sends });

  const notice =
    analytics === null
      ? `Daily analytics could not be loaded from Instantly, so the ${BOUNCE_WINDOW_DAYS} day send and bounce counts and the bounce rate are not available.`
      : sendingDomains.length === 0
        ? "No sending domain allowlist is configured, so every mailbox in the workspace is listed, including mailboxes that belong to another project."
        : null;

  return {
    available: true,
    value: {
      day: today,
      timeZone,
      verdict: report.verdict,
      bounceWindowDays: report.bounceWindowDays,
      counts: {
        critical: report.criticalCount,
        warning: report.warningCount,
        unknown: report.unknownCount,
        ok: report.okCount,
      },
      totalSentToday: flatten(report.totalSentToday),
      totalDailyLimit: flatten(report.totalDailyLimit),
      notice,
      mailboxes: report.mailboxes.map((mailbox) => ({
        email: mailbox.email,
        verdict: mailbox.verdict,
        accountStatus: mailbox.accountStatusLabel,
        warmup: mailbox.warmupStatusLabel,
        sentToday: flatten(mailbox.sentToday),
        dailyLimit: flatten(mailbox.dailyLimit),
        sentInWindow: flatten(mailbox.sentInWindow),
        bouncedInWindow: flatten(mailbox.bouncedInWindow),
        bounceRate: flatten(mailbox.bounceRate),
        breaches: mailbox.breaches.map((breach) => `${breach.severity}: ${breach.detail}`),
      })),
    },
  };
}
