import type { createDiscoveryRun, markDiscoveryRunFailed } from "@/db/queries";
import type { enqueueStartDiscoveryJob } from "@/queue/pipeline";

export const GREATER_BRISBANE_PLUMBERS_V1 = {
  key: "greater-brisbane-plumbers-v1",
  categories: ["Plumber", "Drainage service", "Gas fitter"],
  localities: ["Brisbane", "Logan", "Ipswich", "Moreton Bay", "Redlands"],
  region: "AU",
  totalLimit: 500,
} as const;

export type ProspectRunActionState = {
  ok: boolean;
  message: string;
  discoveryRunId?: string;
};

export const initialProspectRunActionState: ProspectRunActionState = {
  ok: false,
  message: "",
};

export type ProspectRunActionDeps = {
  createDiscoveryRun: typeof createDiscoveryRun;
  markDiscoveryRunFailed: typeof markDiscoveryRunFailed;
  enqueueStartDiscoveryJob: typeof enqueueStartDiscoveryJob;
  revalidatePath(path: string): void;
};

type StartProspectRunContext = {
  tenantId: string;
  operatorId: string;
};

function isActiveRunConflict(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const constraint =
    "constraint_name" in error
      ? error.constraint_name
      : "constraint" in error
        ? error.constraint
        : null;
  return error.code === "23505" && constraint === "discovery_runs_one_active_per_tenant_idx";
}

export function createProspectRunActions(deps: ProspectRunActionDeps) {
  return {
    async start(context: StartProspectRunContext): Promise<ProspectRunActionState> {
      if (!context.tenantId || !context.operatorId) {
        throw new Error("Missing server-derived discovery run identity");
      }

      let run: Awaited<ReturnType<typeof deps.createDiscoveryRun>>;
      try {
        run = await deps.createDiscoveryRun({
          tenantId: context.tenantId,
          querySpec: GREATER_BRISBANE_PLUMBERS_V1,
        });
      } catch (error) {
        if (isActiveRunConflict(error)) {
          return { ok: false, message: "A discovery run is already active." };
        }
        throw error;
      }

      try {
        await deps.enqueueStartDiscoveryJob({
          tenantId: context.tenantId,
          discoveryRunId: run.id,
        });
      } catch {
        await deps.markDiscoveryRunFailed({
          tenantId: context.tenantId,
          discoveryRunId: run.id,
          failureCode: "queue_submission_failed",
        });
        deps.revalidatePath("/prospects");
        return {
          ok: false,
          message: "Discovery run could not be queued. Try again.",
          discoveryRunId: run.id,
        };
      }
      deps.revalidatePath("/prospects");

      return {
        ok: true,
        message: "Discovery run started.",
        discoveryRunId: run.id,
      };
    },
  };
}
