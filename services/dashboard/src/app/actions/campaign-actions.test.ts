import { describe, expect, it, vi } from "vitest";
import {
  createCampaignActions,
  describeCampaignStatus,
  initialCampaignActionState,
  STOP_CONFIRMATION_PHRASE,
  RESUME_CONFIRMATION_PHRASE,
} from "./campaign-actions-core";

const previewCampaign = { campaignId: "campaign-preview", label: "Website preview campaign" };
const noWebsiteCampaign = { campaignId: "campaign-no-website", label: "No website campaign" };

function form(values: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }
  return formData;
}

type GetCampaign = (campaignId: string) => Promise<{ id: string; name: string; status: number }>;
type ApplyCampaign = (campaignId: string) => Promise<void>;

const alwaysPaused: GetCampaign = async (campaignId) => ({
  id: campaignId,
  name: campaignId,
  status: 2,
});

const succeeds: ApplyCampaign = async () => undefined;

function createDeps(
  overrides: {
    targets?: { campaignId: string; label: string }[];
    getCampaign?: GetCampaign;
    pauseCampaign?: ApplyCampaign;
    activateCampaign?: ApplyCampaign;
  } = {},
) {
  const targets = overrides.targets ?? [previewCampaign, noWebsiteCampaign];
  return {
    listCampaignTargets: vi.fn(() => targets),
    instantly: {
      getCampaign: vi.fn(overrides.getCampaign ?? alwaysPaused),
      pauseCampaign: vi.fn(overrides.pauseCampaign ?? succeeds),
      activateCampaign: vi.fn(overrides.activateCampaign ?? succeeds),
    },
    revalidatePath: vi.fn(),
  };
}

describe("describeCampaignStatus", () => {
  it("maps the Instantly campaign status codes it knows", () => {
    expect(describeCampaignStatus(1)).toEqual({ code: 1, label: "active", live: true });
    expect(describeCampaignStatus(2)).toEqual({ code: 2, label: "paused", live: false });
    expect(describeCampaignStatus(4)).toEqual({ code: 4, label: "running subsequences", live: true });
    expect(describeCampaignStatus(0)).toEqual({ code: 0, label: "draft", live: false });
  });

  it("refuses to guess for a status code it does not recognise", () => {
    const described = describeCampaignStatus(77);

    expect(described.live).toBeNull();
    expect(described.label).toContain("77");
  });

  it("refuses to guess when Instantly returned no usable status", () => {
    expect(describeCampaignStatus(Number.NaN)).toEqual({ code: null, label: "unknown", live: null });
  });
});

describe("campaign sending state", () => {
  it("reports live when Instantly says a campaign is active", async () => {
    const deps = createDeps({
      getCampaign: vi.fn(async (campaignId: string) => ({
        id: campaignId,
        name: campaignId,
        status: campaignId === previewCampaign.campaignId ? 1 : 2,
      })),
    });

    const state = await createCampaignActions(deps).loadState();

    expect(state.summary).toBe("live");
    expect(state.rows).toEqual([
      {
        campaignId: previewCampaign.campaignId,
        label: previewCampaign.label,
        status: { code: 1, label: "active", live: true },
        error: null,
      },
      {
        campaignId: noWebsiteCampaign.campaignId,
        label: noWebsiteCampaign.label,
        status: { code: 2, label: "paused", live: false },
        error: null,
      },
    ]);
  });

  it("reports paused only when every campaign is confirmed paused", async () => {
    const state = await createCampaignActions(createDeps()).loadState();

    expect(state.summary).toBe("paused");
  });

  it("reports unknown, not paused, when a campaign state cannot be read", async () => {
    const deps = createDeps({
      getCampaign: vi.fn(async (campaignId: string) => {
        if (campaignId === noWebsiteCampaign.campaignId) {
          throw new Error("Instantly API GET /api/v2/campaigns/campaign-no-website failed with 500");
        }
        return { id: campaignId, name: campaignId, status: 2 };
      }),
    });

    const state = await createCampaignActions(deps).loadState();

    expect(state.summary).toBe("unknown");
    expect(state.rows[1]!.status.live).toBeNull();
    expect(state.rows[1]!.error).toContain("failed with 500");
  });

  it("reports unconfigured when no campaign id is configured", async () => {
    const deps = createDeps({ targets: [] });

    const state = await createCampaignActions(deps).loadState();

    expect(state.summary).toBe("unconfigured");
    expect(state.rows).toEqual([]);
    expect(deps.instantly.getCampaign).not.toHaveBeenCalled();
  });
});

describe("stopSending confirmation gate", () => {
  it("refuses to pause anything without the typed confirmation", async () => {
    const deps = createDeps();

    const result = await createCampaignActions(deps).stopSending(initialCampaignActionState, form({}));

    expect(result.ok).toBe(false);
    expect(result.message).toContain(STOP_CONFIRMATION_PHRASE);
    expect(result.outcomes).toEqual([]);
    expect(deps.instantly.pauseCampaign).not.toHaveBeenCalled();
  });

  it("refuses to pause anything when the confirmation text is wrong", async () => {
    const deps = createDeps();

    const result = await createCampaignActions(deps).stopSending(
      initialCampaignActionState,
      form({ confirmation: "stahp" }),
    );

    expect(result.ok).toBe(false);
    expect(deps.instantly.pauseCampaign).not.toHaveBeenCalled();
  });

  it("does not accept the resume phrase as a stop confirmation", async () => {
    const deps = createDeps();

    const result = await createCampaignActions(deps).stopSending(
      initialCampaignActionState,
      form({ confirmation: RESUME_CONFIRMATION_PHRASE }),
    );

    expect(result.ok).toBe(false);
    expect(deps.instantly.pauseCampaign).not.toHaveBeenCalled();
  });
});

describe("stopSending", () => {
  it("pauses every configured campaign and verifies each one in Instantly", async () => {
    const deps = createDeps();

    const result = await createCampaignActions(deps).stopSending(
      initialCampaignActionState,
      form({ confirmation: STOP_CONFIRMATION_PHRASE }),
    );

    expect(deps.instantly.pauseCampaign).toHaveBeenNthCalledWith(1, previewCampaign.campaignId);
    expect(deps.instantly.pauseCampaign).toHaveBeenNthCalledWith(2, noWebsiteCampaign.campaignId);
    expect(deps.instantly.getCampaign).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Paused 2 of 2 campaigns. Instantly confirms sending is stopped.");
    expect(result.outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(deps.revalidatePath).toHaveBeenCalledWith("/sending");
  });

  it("accepts the confirmation phrase in lower case and with surrounding spaces", async () => {
    const deps = createDeps();

    const result = await createCampaignActions(deps).stopSending(
      initialCampaignActionState,
      form({ confirmation: "  " + STOP_CONFIRMATION_PHRASE.toLowerCase() + "  " }),
    );

    expect(result.ok).toBe(true);
  });

  it("reports a partial failure honestly when one campaign pause errors", async () => {
    const deps = createDeps({
      pauseCampaign: vi.fn(async (campaignId: string) => {
        if (campaignId === noWebsiteCampaign.campaignId) {
          throw new Error("Instantly API POST /api/v2/campaigns/campaign-no-website/pause failed with 500");
        }
      }),
    });

    const result = await createCampaignActions(deps).stopSending(
      initialCampaignActionState,
      form({ confirmation: STOP_CONFIRMATION_PHRASE }),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Paused 1 of 2 campaigns. 1 failed and may still be sending.");
    expect(result.outcomes[0]).toMatchObject({ campaignId: previewCampaign.campaignId, ok: true });
    expect(result.outcomes[1]).toMatchObject({ campaignId: noWebsiteCampaign.campaignId, ok: false });
    expect(result.outcomes[1]!.detail).toContain("failed with 500");
  });

  it("reports failure when every pause call fails", async () => {
    const deps = createDeps({
      pauseCampaign: vi.fn(async () => {
        throw new Error("Instantly API POST failed with 503; response body omitted");
      }),
    });

    const result = await createCampaignActions(deps).stopSending(
      initialCampaignActionState,
      form({ confirmation: STOP_CONFIRMATION_PHRASE }),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Paused 0 of 2 campaigns. Sending was not stopped.");
    expect(result.outcomes.every((outcome) => outcome.ok === false)).toBe(true);
    expect(result.outcomes[0]!.detail).toContain("503");
  });

  it("reports failure when Instantly accepts the pause but still says the campaign is active", async () => {
    const deps = createDeps({
      targets: [previewCampaign],
      getCampaign: vi.fn(async (campaignId: string) => ({ id: campaignId, name: campaignId, status: 1 })),
    });

    const result = await createCampaignActions(deps).stopSending(
      initialCampaignActionState,
      form({ confirmation: STOP_CONFIRMATION_PHRASE }),
    );

    expect(result.ok).toBe(false);
    expect(result.outcomes[0]!.ok).toBe(false);
    expect(result.outcomes[0]!.detail).toContain("active");
    expect(result.message).toBe("Paused 0 of 1 campaign. Sending was not stopped.");
  });

  it("reports failure when the pause cannot be verified", async () => {
    const deps = createDeps({
      targets: [previewCampaign],
      getCampaign: vi.fn(async () => {
        throw new Error("Instantly API GET /api/v2/campaigns/campaign-preview failed with 500");
      }),
    });

    const result = await createCampaignActions(deps).stopSending(
      initialCampaignActionState,
      form({ confirmation: STOP_CONFIRMATION_PHRASE }),
    );

    expect(result.ok).toBe(false);
    expect(result.outcomes[0]!.detail).toContain("could not be verified");
    expect(result.outcomes[0]!.status.live).toBeNull();
  });

  it("says plainly that nothing was paused when no campaign is configured", async () => {
    const deps = createDeps({ targets: [] });

    const result = await createCampaignActions(deps).stopSending(
      initialCampaignActionState,
      form({ confirmation: STOP_CONFIRMATION_PHRASE }),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "No Instantly campaign id is configured on the dashboard, so nothing was paused.",
    );
    expect(deps.instantly.pauseCampaign).not.toHaveBeenCalled();
  });
});

describe("resumeSending", () => {
  it("refuses to resume without the typed confirmation", async () => {
    const deps = createDeps();

    const result = await createCampaignActions(deps).resumeSending(
      initialCampaignActionState,
      form({ confirmation: STOP_CONFIRMATION_PHRASE }),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain(RESUME_CONFIRMATION_PHRASE);
    expect(deps.instantly.activateCampaign).not.toHaveBeenCalled();
  });

  it("activates every configured campaign and verifies each one", async () => {
    const deps = createDeps({
      getCampaign: vi.fn(async (campaignId: string) => ({ id: campaignId, name: campaignId, status: 1 })),
    });

    const result = await createCampaignActions(deps).resumeSending(
      initialCampaignActionState,
      form({ confirmation: RESUME_CONFIRMATION_PHRASE }),
    );

    expect(deps.instantly.activateCampaign).toHaveBeenNthCalledWith(1, previewCampaign.campaignId);
    expect(deps.instantly.activateCampaign).toHaveBeenNthCalledWith(2, noWebsiteCampaign.campaignId);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Resumed 2 of 2 campaigns. Instantly confirms sending is live.");
    expect(deps.revalidatePath).toHaveBeenCalledWith("/sending");
  });

  it("reports failure when Instantly accepts the activate but the campaign is still paused", async () => {
    const deps = createDeps({ targets: [previewCampaign] });

    const result = await createCampaignActions(deps).resumeSending(
      initialCampaignActionState,
      form({ confirmation: RESUME_CONFIRMATION_PHRASE }),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Resumed 0 of 1 campaign. Sending was not resumed.");
    expect(result.outcomes[0]!.detail).toContain("paused");
  });

  it("reports a partial failure honestly when one activate errors", async () => {
    const deps = createDeps({
      getCampaign: vi.fn(async (campaignId: string) => ({ id: campaignId, name: campaignId, status: 1 })),
      activateCampaign: vi.fn(async (campaignId: string) => {
        if (campaignId === noWebsiteCampaign.campaignId) {
          throw new Error("Instantly API POST /api/v2/campaigns/campaign-no-website/activate failed with 500");
        }
      }),
    });

    const result = await createCampaignActions(deps).resumeSending(
      initialCampaignActionState,
      form({ confirmation: RESUME_CONFIRMATION_PHRASE }),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Resumed 1 of 2 campaigns. 1 failed and is not sending.");
  });
});
