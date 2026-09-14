import { describe, expect, it, vi } from "vitest";
import type { InstantlyCampaignTotals } from "@/clients/instantly";
import { loadSendsToDate } from "./sends-to-date";

const env = { INSTANTLY_CAMPAIGN_ID: "has-website", INSTANTLY_NO_WEBSITE_CAMPAIGN_ID: "no-website" };

function clientWith(rows: InstantlyCampaignTotals[] | Error) {
  return {
    getCampaignTotals: vi.fn(async () => {
      if (rows instanceof Error) {
        throw rows;
      }
      return rows;
    }),
  };
}

describe("loadSendsToDate", () => {
  it("adds up every configured campaign, the paused one included", async () => {
    // Production on 2026-09-14: the live campaign had sent 45 and bounced 1, the
    // paused one 30 and 6. A paused campaign's emails still went out.
    const client = clientWith([
      { campaignId: "has-website", emailsSent: 45, bounced: 1, contacted: 37 },
      { campaignId: "no-website", emailsSent: 30, bounced: 6, contacted: 30 },
    ]);

    await expect(loadSendsToDate({ client, env })).resolves.toEqual({
      available: true,
      value: { sent: 75, bounced: 7, delivered: 68, contacted: 67 },
    });
    expect(client.getCampaignTotals).toHaveBeenCalledWith(["has-website", "no-website"]);
  });

  it("reports a campaign with nothing sent yet as a real zero", async () => {
    const client = clientWith([
      { campaignId: "has-website", emailsSent: 0, bounced: 0, contacted: 0 },
      { campaignId: "no-website", emailsSent: 0, bounced: 0, contacted: 0 },
    ]);

    await expect(loadSendsToDate({ client, env })).resolves.toEqual({
      available: true,
      value: { sent: 0, bounced: 0, delivered: 0, contacted: 0 },
    });
  });

  it("refuses to show a short total when a configured campaign is missing", async () => {
    const client = clientWith([{ campaignId: "has-website", emailsSent: 45, bounced: 1, contacted: 37 }]);

    const result = await loadSendsToDate({ client, env });

    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toContain("No website campaign");
    }
  });

  it("says no campaign is configured, without calling Instantly", async () => {
    const client = clientWith([]);

    const result = await loadSendsToDate({ client, env: {} });

    expect(result.available).toBe(false);
    expect(client.getCampaignTotals).not.toHaveBeenCalled();
  });

  it("turns an Instantly failure into an unavailable figure and never throws", async () => {
    const client = clientWith(new Error("Instantly API GET /api/v2/campaigns/analytics failed with 503"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await loadSendsToDate({ client, env });

    expect(result.available).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
