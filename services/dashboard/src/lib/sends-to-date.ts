import { InstantlyHttpClient } from "@/clients/instantly";
import type { MetricAvailability } from "@/lib/deliverability";
import { readInstantlyCampaignTargets } from "@/lib/instantly-campaigns";

/**
 * Emails the live campaigns have sent since launch, and how many got through.
 *
 * "Delivered" here means sent and not bounced, and nothing more. Instantly
 * reports no spam complaint figure and open tracking is off, so this does not
 * claim an email reached an inbox rather than a spam folder.
 *
 * The totals come from Instantly's lifetime campaign analytics rather than from
 * `outreach_sends`. That table records the handoff to Instantly, not the send,
 * and it learns about a bounce only through a webhook that once dropped every
 * event for months. A lifetime total has no day boundary, so the UTC bucketing
 * that distorts Instantly's daily figures does not apply here.
 *
 * Only the campaigns this dashboard is configured for are counted, which keeps
 * the dev preview smoke campaign out. A paused campaign is still counted: its
 * emails went out.
 */
export type SendsToDate = {
  readonly sent: number;
  readonly bounced: number;
  readonly delivered: number;
  /** Distinct businesses emailed at least once. */
  readonly contacted: number;
};

/** Only the one read-only call this figure makes, so tests inject a fake. */
export type SendsToDateClient = Pick<InstantlyHttpClient, "getCampaignTotals">;

export type LoadSendsToDateOptions = {
  readonly client?: SendsToDateClient;
  readonly env?: Record<string, string | undefined>;
};

/**
 * Never throws. Every failure comes back as an unavailable figure with its
 * reason, because a zero on this card would read as a campaign that never sent.
 */
export async function loadSendsToDate(
  options: LoadSendsToDateOptions = {},
): Promise<MetricAvailability<SendsToDate>> {
  const targets = readInstantlyCampaignTargets(options.env);
  if (targets.length === 0) {
    return {
      available: false,
      reason: "No Instantly campaign is configured for this dashboard, so there is nothing to count.",
    };
  }

  let rows;
  try {
    const client = options.client ?? new InstantlyHttpClient();
    rows = await client.getCampaignTotals(targets.map((target) => target.campaignId));
  } catch (error) {
    console.error("Failed to load campaign totals from Instantly", {
      message: error instanceof Error ? error.message : "Unknown campaign totals error",
    });
    return { available: false, reason: "Instantly did not return the campaign totals." };
  }

  // A configured campaign with no row would make the total quietly short, so
  // the whole figure is withheld instead and the missing campaign is named.
  const byId = new Map(rows.map((row) => [row.campaignId, row]));
  const missing = targets.filter((target) => !byId.has(target.campaignId));
  if (missing.length > 0) {
    return {
      available: false,
      reason: `Instantly returned no totals for: ${missing.map((target) => target.label).join(", ")}, so the figure would be short.`,
    };
  }

  let sent = 0;
  let bounced = 0;
  let contacted = 0;
  for (const target of targets) {
    const row = byId.get(target.campaignId)!;
    sent += row.emailsSent;
    bounced += row.bounced;
    contacted += row.contacted;
  }

  return { available: true, value: { sent, bounced, delivered: sent - bounced, contacted } };
}
