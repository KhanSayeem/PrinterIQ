"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/auth/server";
import { InstantlyHttpClient } from "@/clients/instantly";
import { readInstantlyCampaignTargets } from "@/lib/instantly-campaigns";
import {
  createCampaignActions,
  type CampaignActionDeps,
  type CampaignActionState,
  type CampaignSendingState,
} from "./campaign-actions-core";

export type { CampaignActionState, CampaignSendingState } from "./campaign-actions-core";

function defaultDeps(): CampaignActionDeps {
  return {
    listCampaignTargets: () => readInstantlyCampaignTargets(),
    instantly: new InstantlyHttpClient(),
    revalidatePath,
  };
}

export async function loadCampaignSendingState(): Promise<CampaignSendingState> {
  await requireOperator();
  return createCampaignActions(defaultDeps()).loadState();
}

export async function stopSending(previousState: CampaignActionState, formData: FormData) {
  await requireOperator();
  return createCampaignActions(defaultDeps()).stopSending(previousState, formData);
}

export async function resumeSending(previousState: CampaignActionState, formData: FormData) {
  await requireOperator();
  return createCampaignActions(defaultDeps()).resumeSending(previousState, formData);
}
