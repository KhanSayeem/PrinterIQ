import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  insertManualProspectReviewMock,
  requireDashboardTenantIdMock,
  requireOperatorMock,
  revalidatePathMock,
} = vi.hoisted(() => ({
  insertManualProspectReviewMock: vi.fn(),
  requireDashboardTenantIdMock: vi.fn(),
  requireOperatorMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("@/auth/server", () => ({ requireOperator: requireOperatorMock }));
vi.mock("@/auth/tenant", () => ({ requireDashboardTenantId: requireDashboardTenantIdMock }));
vi.mock("@/db/queries", () => ({ insertManualProspectReview: insertManualProspectReviewMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import {
  createProspectReviewActions,
  initialProspectReviewActionState,
} from "./prospect-review-actions-core";
import { recordProspectReview } from "./prospect-review-actions";

const tenantId = "11111111-1111-4111-8111-111111111111";
const reviewerId = "22222222-2222-4222-8222-222222222222";
const discoveryRunId = "33333333-3333-4333-8333-333333333333";
const prospectId = "44444444-4444-4444-8444-444444444444";
const idempotencyKey = "55555555-5555-4555-8555-555555555555";

function form(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("discoveryRunId", discoveryRunId);
  data.set("prospectId", prospectId);
  data.set("idempotencyKey", idempotencyKey);
  data.set("decision", "correct");
  for (const [key, value] of Object.entries(overrides)) {
    data.set(key, value);
  }
  return data;
}

function deps() {
  return {
    insertManualProspectReview: vi.fn().mockResolvedValue({ id: "assessment-1" }),
    revalidatePath: vi.fn(),
  };
}

describe("prospect review actions", () => {
  beforeEach(() => {
    insertManualProspectReviewMock.mockReset().mockResolvedValue({ id: "assessment-1" });
    requireDashboardTenantIdMock.mockReset().mockReturnValue(tenantId);
    requireOperatorMock.mockReset().mockResolvedValue({ id: reviewerId });
    revalidatePathMock.mockReset();
  });

  it("records a correct review with server-derived tenant and reviewer identity", async () => {
    const localDeps = deps();
    const actions = createProspectReviewActions(localDeps);

    const result = await actions.record({ tenantId, reviewerId }, form({ note: "  Looks right  " }));

    expect(localDeps.insertManualProspectReview).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        reviewerId,
        discoveryRunId,
        prospectId,
        idempotencyKey,
        decision: "correct",
        note: "Looks right",
      }),
    );
    expect(localDeps.revalidatePath).toHaveBeenCalledWith("/prospects");
    expect(result).toEqual({ ok: true, message: "Review recorded.", prospectId });
  });

  it("requires corrected route only for wrong-route reviews", async () => {
    const actions = createProspectReviewActions(deps());

    await expect(
      actions.record({ tenantId, reviewerId }, form({ decision: "wrong_route" })),
    ).rejects.toThrow("Corrected route is required");

    await expect(
      actions.record({ tenantId, reviewerId }, form({ decision: "correct", correctedRoute: "A" })),
    ).rejects.toThrow("Corrected route is only allowed");
  });

  it("trims notes to the bounded manual review size", async () => {
    const localDeps = deps();
    const longNote = `  ${"a".repeat(1100)}  `;

    await createProspectReviewActions(localDeps).record(
      { tenantId, reviewerId },
      form({ decision: "wrong_route", correctedRoute: "B", note: longNote }),
    );

    expect(localDeps.insertManualProspectReview).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        reviewerId,
        discoveryRunId,
        prospectId,
        idempotencyKey,
        decision: "wrong_route",
        correctedRoute: "B",
        note: "a".repeat(1000),
      }),
    );
  });

  it("server wrapper ignores browser identity fields", async () => {
    const data = form({
      tenantId: "browser-tenant",
      reviewerId: "browser-reviewer",
      decision: "needs_investigation",
    });

    await recordProspectReview(initialProspectReviewActionState, data);

    expect(requireOperatorMock).toHaveBeenCalledOnce();
    expect(requireDashboardTenantIdMock).toHaveBeenCalledOnce();
    expect(insertManualProspectReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        reviewerId,
        decision: "needs_investigation",
      }),
    );
    expect(insertManualProspectReviewMock.mock.calls[0]?.[0]).not.toMatchObject({
      tenantId: "browser-tenant",
      reviewerId: "browser-reviewer",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/prospects");
  });
});
