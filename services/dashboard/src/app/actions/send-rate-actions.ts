"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/auth/server";
import { InstantlyHttpClient } from "@/clients/instantly";
import {
  createSendRateActions,
  parseSendingDomains,
  type SendRateActionDeps,
  type SendRateActionState,
} from "./send-rate-actions-core";

export type { SendRateActionState } from "./send-rate-actions-core";

function defaultDeps(): SendRateActionDeps {
  return {
    instantly: new InstantlyHttpClient(),
    allowedDomains: parseSendingDomains(process.env.INSTANTLY_SENDING_DOMAINS),
    revalidatePath,
  };
}

export async function readSendRate(): Promise<SendRateActionState> {
  await requireOperator();
  return createSendRateActions(defaultDeps()).read();
}

export async function applySendRate(
  previousState: SendRateActionState,
  formData: FormData,
): Promise<SendRateActionState> {
  void previousState;
  await requireOperator();
  return createSendRateActions(defaultDeps()).apply(formData);
}
