import { describe, expect, it } from "vitest";
import { readInstantlyCampaignTargets } from "./instantly-campaigns";

describe("readInstantlyCampaignTargets", () => {
  it("returns both configured campaigns with operator readable labels", () => {
    expect(
      readInstantlyCampaignTargets({
        INSTANTLY_CAMPAIGN_ID: "campaign-preview",
        INSTANTLY_NO_WEBSITE_CAMPAIGN_ID: "campaign-no-website",
      }),
    ).toEqual([
      { campaignId: "campaign-preview", label: "Website preview campaign" },
      { campaignId: "campaign-no-website", label: "No website campaign" },
    ]);
  });

  it("skips campaigns that are unset or blank", () => {
    expect(
      readInstantlyCampaignTargets({
        INSTANTLY_CAMPAIGN_ID: "campaign-preview",
        INSTANTLY_NO_WEBSITE_CAMPAIGN_ID: "   ",
      }),
    ).toEqual([{ campaignId: "campaign-preview", label: "Website preview campaign" }]);
  });

  it("returns an empty list when nothing is configured", () => {
    expect(readInstantlyCampaignTargets({})).toEqual([]);
  });

  it("does not pause the same campaign twice when both env vars hold one id", () => {
    expect(
      readInstantlyCampaignTargets({
        INSTANTLY_CAMPAIGN_ID: "campaign-preview",
        INSTANTLY_NO_WEBSITE_CAMPAIGN_ID: "campaign-preview",
      }),
    ).toEqual([{ campaignId: "campaign-preview", label: "Website preview campaign" }]);
  });
});
