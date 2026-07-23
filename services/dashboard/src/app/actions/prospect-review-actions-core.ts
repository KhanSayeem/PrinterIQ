import type { insertManualProspectReview } from "@/db/queries";

export type ManualReviewDecision = "correct" | "wrong_route" | "ineligible" | "needs_investigation";
export type CorrectedRoute = "A" | "B" | "manual_review" | "healthy";

export type ProspectReviewActionState = {
  ok: boolean;
  message: string;
  prospectId?: string;
};

export const initialProspectReviewActionState: ProspectReviewActionState = {
  ok: false,
  message: "",
};

export type ProspectReviewActionDeps = {
  insertManualProspectReview: typeof insertManualProspectReview;
  revalidatePath(path: string): void;
};

export type ManualReviewContext = {
  tenantId: string;
  reviewerId: string;
};

const decisions = new Set<ManualReviewDecision>([
  "correct",
  "wrong_route",
  "ineligible",
  "needs_investigation",
]);
const correctedRoutes = new Set<CorrectedRoute>(["A", "B", "manual_review", "healthy"]);

export function createProspectReviewActions(deps: ProspectReviewActionDeps) {
  return {
    async record(
      context: ManualReviewContext,
      formData: FormData,
    ): Promise<ProspectReviewActionState> {
      if (!context.tenantId || !context.reviewerId) {
        throw new Error("Missing server-derived review identity");
      }

      const input = parseManualReviewForm(formData);
      await deps.insertManualProspectReview({
        tenantId: context.tenantId,
        reviewerId: context.reviewerId,
        discoveryRunId: input.discoveryRunId,
        prospectId: input.prospectId,
        idempotencyKey: input.idempotencyKey,
        decision: input.decision,
        correctedRoute: input.correctedRoute,
        note: input.note,
      });
      deps.revalidatePath("/prospects");
      return {
        ok: true,
        message: "Review recorded.",
        prospectId: input.prospectId,
      };
    },
  };
}

function parseManualReviewForm(formData: FormData) {
  const discoveryRunId = readRequired(formData, "discoveryRunId");
  const prospectId = readRequired(formData, "prospectId");
  const idempotencyKey = readRequired(formData, "idempotencyKey");
  const decisionValue = readRequired(formData, "decision");
  if (!decisions.has(decisionValue as ManualReviewDecision)) {
    throw new Error("Unsupported review decision");
  }
  const decision = decisionValue as ManualReviewDecision;
  const correctedRouteValue = readOptional(formData, "correctedRoute");
  if (decision === "wrong_route") {
    if (!correctedRoutes.has(correctedRouteValue as CorrectedRoute)) {
      throw new Error("Corrected route is required for wrong-route reviews");
    }
  } else if (correctedRouteValue) {
    throw new Error("Corrected route is only allowed for wrong-route reviews");
  }

  return {
    discoveryRunId,
    prospectId,
    idempotencyKey,
    decision,
    correctedRoute: correctedRouteValue ? (correctedRouteValue as CorrectedRoute) : undefined,
    note: trimNote(readOptional(formData, "note")),
  };
}

function readRequired(formData: FormData, field: string) {
  const value = formData.get(field);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function readOptional(formData: FormData, field: string) {
  const value = formData.get(field);
  return typeof value === "string" ? value.trim() : "";
}

function trimNote(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 1000) : undefined;
}
