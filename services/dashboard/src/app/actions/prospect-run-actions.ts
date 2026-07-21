"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/auth/server";
import { requireDashboardTenantId } from "@/auth/tenant";
import { createDiscoveryRun, markDiscoveryRunFailed } from "@/db/queries";
import { enqueueStartDiscoveryJob } from "@/queue/pipeline";
import {
  createProspectRunActions,
  type ProspectRunActionDeps,
  type ProspectRunActionState,
} from "./prospect-run-actions-core";

export type { ProspectRunActionState } from "./prospect-run-actions-core";

function defaultDeps(): ProspectRunActionDeps {
  return {
    createDiscoveryRun,
    markDiscoveryRunFailed,
    enqueueStartDiscoveryJob,
    revalidatePath,
  };
}

export async function startProspectRun(
  previousState: ProspectRunActionState,
  formData: FormData,
) {
  void previousState;
  void formData;
  const operator = await requireOperator();
  const tenantId = requireDashboardTenantId();

  return createProspectRunActions(defaultDeps()).start({
    tenantId,
    operatorId: operator.id,
  });
}

export async function startProspectDiscoveryRun(
  previousState: ProspectRunActionState,
  formData: FormData,
) {
  return startProspectRun(previousState, formData);
}
