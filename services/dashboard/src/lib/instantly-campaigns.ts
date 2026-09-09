export type CampaignTarget = {
  campaignId: string;
  label: string;
};

const CAMPAIGN_ENV_VARS = [
  { envVar: "INSTANTLY_CAMPAIGN_ID", label: "Website preview campaign" },
  { envVar: "INSTANTLY_NO_WEBSITE_CAMPAIGN_ID", label: "No website campaign" },
] as const;

/**
 * The campaigns the dashboard kill switch is allowed to pause and resume.
 *
 * Only ids the dashboard process can actually see are returned. A campaign the
 * dashboard cannot see is never silently treated as stopped: it is simply absent
 * from the list, and the kill switch reports how many campaigns it acted on.
 */
export function readInstantlyCampaignTargets(
  env: Record<string, string | undefined> = process.env,
): CampaignTarget[] {
  const targets: CampaignTarget[] = [];

  for (const { envVar, label } of CAMPAIGN_ENV_VARS) {
    const campaignId = env[envVar]?.trim();
    if (!campaignId) {
      continue;
    }
    if (targets.some((target) => target.campaignId === campaignId)) {
      continue;
    }
    targets.push({ campaignId, label });
  }

  return targets;
}
