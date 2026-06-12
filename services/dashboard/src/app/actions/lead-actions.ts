"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/auth/server";
import { requireDashboardTenantId } from "@/auth/tenant";
import { InstantlyHttpClient } from "@/clients/instantly";
import {
  getLatestInstantlyLeadId,
  getLatestInstantlyReplyMetadata,
  insertOperatorConversation,
  updateLeadStatus,
  assertLeadStatusTransitionAllowed,
  deleteOperatorNote,
} from "@/db/queries";
import {
  createLeadActions,
  type LeadActionState,
  type LeadActionDeps,
} from "./lead-actions-core";

export type { LeadActionState } from "./lead-actions-core";

function defaultDeps(): LeadActionDeps {
  return {
    insertOperatorConversation,
    updateLeadStatus,
    assertLeadStatusTransitionAllowed,
    getLatestInstantlyLeadId,
    getLatestInstantlyReplyMetadata,
    deleteOperatorNote,
    instantly: new InstantlyHttpClient(),
    revalidatePath,
  };
}

export async function addNote(previousState: LeadActionState, formData: FormData) {
  await requireOperator();
  return createLeadActions(defaultDeps()).addNote(previousState, withServerTenant(formData));
}

export async function overrideReply(previousState: LeadActionState, formData: FormData) {
  await requireOperator();
  return createLeadActions(defaultDeps()).overrideReply(previousState, withServerTenant(formData));
}

export async function pauseLead(previousState: LeadActionState, formData: FormData) {
  await requireOperator();
  return createLeadActions(defaultDeps()).pauseLead(previousState, withServerTenant(formData));
}

export async function deleteNote(previousState: LeadActionState, formData: FormData) {
  await requireOperator();
  return createLeadActions(defaultDeps()).deleteNote(previousState, withServerTenant(formData));
}

function withServerTenant(formData: FormData) {
  const scopedFormData = new FormData();
  for (const [key, value] of formData.entries()) {
    scopedFormData.set(key, value);
  }
  scopedFormData.set("tenantId", requireDashboardTenantId());
  return scopedFormData;
}
