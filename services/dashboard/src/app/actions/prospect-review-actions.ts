"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/auth/server";
import { requireDashboardTenantId } from "@/auth/tenant";
import { insertManualProspectReview } from "@/db/queries";
import {
  createProspectReviewActions,
  type ProspectReviewActionDeps,
  type ProspectReviewActionState,
} from "./prospect-review-actions-core";

export type { ProspectReviewActionState } from "./prospect-review-actions-core";

function defaultDeps(): ProspectReviewActionDeps {
  return {
    insertManualProspectReview,
    revalidatePath,
  };
}

export async function recordProspectReview(
  previousState: ProspectReviewActionState,
  formData: FormData,
) {
  void previousState;
  const operator = await requireOperator();
  const tenantId = requireDashboardTenantId();

  return createProspectReviewActions(defaultDeps()).record(
    {
      tenantId,
      reviewerId: operator.id,
    },
    formData,
  );
}
