import type { CampaignTarget } from "@/lib/instantly-campaigns";

export const STOP_CONFIRMATION_PHRASE = "STOP";
export const RESUME_CONFIRMATION_PHRASE = "RESUME";

const CAMPAIGN_STATUS_ACTIVE = 1;
const CAMPAIGN_STATUS_PAUSED = 2;

const STATUS_LABELS = new Map<number, string>([
  [0, "draft"],
  [CAMPAIGN_STATUS_ACTIVE, "active"],
  [CAMPAIGN_STATUS_PAUSED, "paused"],
  [3, "completed"],
  [4, "running subsequences"],
  [-1, "accounts unhealthy"],
  [-2, "bounce protect"],
  [-99, "account suspended"],
]);

const STATUS_LIVE = new Map<number, boolean>([
  [0, false],
  [CAMPAIGN_STATUS_ACTIVE, true],
  [CAMPAIGN_STATUS_PAUSED, false],
  [3, false],
  [4, true],
]);

export type CampaignStatus = {
  /** The raw Instantly status code, or null when Instantly returned nothing usable. */
  code: number | null;
  label: string;
  /** true = sending, false = not sending, null = we do not know. Never guessed. */
  live: boolean | null;
};

export type CampaignStateRow = {
  campaignId: string;
  label: string;
  status: CampaignStatus;
  error: string | null;
};

export type CampaignSendingState = {
  rows: CampaignStateRow[];
  summary: "live" | "paused" | "unknown" | "unconfigured";
};

export type CampaignOutcome = {
  campaignId: string;
  label: string;
  ok: boolean;
  status: CampaignStatus;
  detail: string;
};

export type CampaignActionState = {
  ok: boolean;
  message: string;
  outcomes: CampaignOutcome[];
};

export const initialCampaignActionState: CampaignActionState = {
  ok: false,
  message: "",
  outcomes: [],
};

export const emptyCampaignSendingState: CampaignSendingState = {
  rows: [],
  summary: "unconfigured",
};

export type CampaignActionDeps = {
  listCampaignTargets: () => CampaignTarget[];
  instantly: {
    getCampaign(campaignId: string): Promise<{ id: string; name: string; status: number }>;
    pauseCampaign(campaignId: string): Promise<void>;
    activateCampaign(campaignId: string): Promise<void>;
  };
  revalidatePath: (path: string) => void;
};

const UNKNOWN_STATUS: CampaignStatus = { code: null, label: "unknown", live: null };

export function describeCampaignStatus(status: number): CampaignStatus {
  if (!Number.isFinite(status)) {
    return { ...UNKNOWN_STATUS };
  }

  const label = STATUS_LABELS.get(status);
  if (label === undefined) {
    return { code: status, label: `unrecognised Instantly status ${status}`, live: null };
  }

  return { code: status, label, live: STATUS_LIVE.get(status) ?? null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function readConfirmation(formData: FormData) {
  const value = formData.get("confirmation");
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function campaignWord(count: number) {
  return count === 1 ? "campaign" : "campaigns";
}

export function createCampaignActions(deps: CampaignActionDeps) {
  async function readCampaignRow(target: CampaignTarget): Promise<CampaignStateRow> {
    try {
      const campaign = await deps.instantly.getCampaign(target.campaignId);
      return {
        campaignId: target.campaignId,
        label: target.label,
        status: describeCampaignStatus(campaign.status),
        error: null,
      };
    } catch (error) {
      return {
        campaignId: target.campaignId,
        label: target.label,
        status: { ...UNKNOWN_STATUS },
        error: errorMessage(error),
      };
    }
  }

  async function applyAndVerify(
    target: CampaignTarget,
    apply: (campaignId: string) => Promise<void>,
    expectedCode: number,
    expectedLabel: string,
  ): Promise<CampaignOutcome> {
    try {
      await apply(target.campaignId);
    } catch (error) {
      return {
        campaignId: target.campaignId,
        label: target.label,
        ok: false,
        status: { ...UNKNOWN_STATUS },
        detail: `Instantly rejected the call: ${errorMessage(error)}`,
      };
    }

    let status: CampaignStatus;
    try {
      const campaign = await deps.instantly.getCampaign(target.campaignId);
      status = describeCampaignStatus(campaign.status);
    } catch (error) {
      return {
        campaignId: target.campaignId,
        label: target.label,
        ok: false,
        status: { ...UNKNOWN_STATUS },
        detail: `Instantly accepted the call but the result could not be verified: ${errorMessage(error)}`,
      };
    }

    if (status.code !== expectedCode) {
      return {
        campaignId: target.campaignId,
        label: target.label,
        ok: false,
        status,
        detail: `Instantly accepted the call but still reports this campaign as ${status.label}.`,
      };
    }

    return {
      campaignId: target.campaignId,
      label: target.label,
      ok: true,
      status,
      detail: `Instantly confirms this campaign is ${expectedLabel}.`,
    };
  }

  return {
    async loadState(): Promise<CampaignSendingState> {
      const targets = deps.listCampaignTargets();
      if (targets.length === 0) {
        return { rows: [], summary: "unconfigured" };
      }

      const rows: CampaignStateRow[] = [];
      for (const target of targets) {
        rows.push(await readCampaignRow(target));
      }

      if (rows.some((row) => row.status.live === true)) {
        return { rows, summary: "live" };
      }
      if (rows.some((row) => row.status.live === null)) {
        return { rows, summary: "unknown" };
      }

      return { rows, summary: "paused" };
    },

    async stopSending(
      _previousState: CampaignActionState,
      formData: FormData,
    ): Promise<CampaignActionState> {
      if (readConfirmation(formData) !== STOP_CONFIRMATION_PHRASE) {
        return {
          ok: false,
          message: `Type ${STOP_CONFIRMATION_PHRASE} to confirm. Nothing was paused.`,
          outcomes: [],
        };
      }

      const targets = deps.listCampaignTargets();
      if (targets.length === 0) {
        return {
          ok: false,
          message: "No Instantly campaign id is configured on the dashboard, so nothing was paused.",
          outcomes: [],
        };
      }

      const outcomes: CampaignOutcome[] = [];
      for (const target of targets) {
        outcomes.push(
          await applyAndVerify(
            target,
            (campaignId) => deps.instantly.pauseCampaign(campaignId),
            CAMPAIGN_STATUS_PAUSED,
            "paused",
          ),
        );
      }
      deps.revalidatePath("/sending");

      const paused = outcomes.filter((outcome) => outcome.ok).length;
      const failed = outcomes.length - paused;
      const total = `${paused} of ${outcomes.length} ${campaignWord(outcomes.length)}`;

      if (failed === 0) {
        return { ok: true, message: `Paused ${total}. Instantly confirms sending is stopped.`, outcomes };
      }
      if (paused === 0) {
        return { ok: false, message: `Paused ${total}. Sending was not stopped.`, outcomes };
      }

      return {
        ok: false,
        message: `Paused ${total}. ${failed} failed and may still be sending.`,
        outcomes,
      };
    },

    async resumeSending(
      _previousState: CampaignActionState,
      formData: FormData,
    ): Promise<CampaignActionState> {
      if (readConfirmation(formData) !== RESUME_CONFIRMATION_PHRASE) {
        return {
          ok: false,
          message: `Type ${RESUME_CONFIRMATION_PHRASE} to confirm. Nothing was resumed.`,
          outcomes: [],
        };
      }

      const targets = deps.listCampaignTargets();
      if (targets.length === 0) {
        return {
          ok: false,
          message: "No Instantly campaign id is configured on the dashboard, so nothing was resumed.",
          outcomes: [],
        };
      }

      const outcomes: CampaignOutcome[] = [];
      for (const target of targets) {
        outcomes.push(
          await applyAndVerify(
            target,
            (campaignId) => deps.instantly.activateCampaign(campaignId),
            CAMPAIGN_STATUS_ACTIVE,
            "active",
          ),
        );
      }
      deps.revalidatePath("/sending");

      const resumed = outcomes.filter((outcome) => outcome.ok).length;
      const failed = outcomes.length - resumed;
      const total = `${resumed} of ${outcomes.length} ${campaignWord(outcomes.length)}`;

      if (failed === 0) {
        return { ok: true, message: `Resumed ${total}. Instantly confirms sending is live.`, outcomes };
      }
      if (resumed === 0) {
        return { ok: false, message: `Resumed ${total}. Sending was not resumed.`, outcomes };
      }

      return {
        ok: false,
        message: `Resumed ${total}. ${failed} failed and is not sending.`,
        outcomes,
      };
    },
  };
}
