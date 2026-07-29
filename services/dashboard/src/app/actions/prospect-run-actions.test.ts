import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createDiscoveryRunMock,
  failStaleActiveDiscoveryRunsMock,
  markDiscoveryRunFailedMock,
  enqueueStartDiscoveryJobMock,
  requireDashboardTenantIdMock,
  requireOperatorMock,
  revalidatePathMock,
} = vi.hoisted(() => ({
  createDiscoveryRunMock: vi.fn(),
  failStaleActiveDiscoveryRunsMock: vi.fn(),
  markDiscoveryRunFailedMock: vi.fn(),
  enqueueStartDiscoveryJobMock: vi.fn(),
  requireDashboardTenantIdMock: vi.fn(),
  requireOperatorMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("@/auth/server", () => ({ requireOperator: requireOperatorMock }));
vi.mock("@/auth/tenant", () => ({ requireDashboardTenantId: requireDashboardTenantIdMock }));
vi.mock("@/db/queries", () => ({
  createDiscoveryRun: createDiscoveryRunMock,
  failStaleActiveDiscoveryRuns: failStaleActiveDiscoveryRunsMock,
  markDiscoveryRunFailed: markDiscoveryRunFailedMock,
}));
vi.mock("@/queue/pipeline", () => ({ enqueueStartDiscoveryJob: enqueueStartDiscoveryJobMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import {
  createProspectRunActions,
  GREATER_BRISBANE_PLUMBERS_V1,
  initialProspectRunActionState,
} from "./prospect-run-actions-core";
import { startProspectDiscoveryRun } from "./prospect-run-actions";

const tenantId = "11111111-1111-4111-8111-111111111111";
const operatorId = "22222222-2222-4222-8222-222222222222";

function createDeps() {
  return {
    createDiscoveryRun: vi.fn().mockResolvedValue({ id: "run-1" }),
    failStaleActiveDiscoveryRuns: vi.fn().mockResolvedValue([]),
    markDiscoveryRunFailed: vi.fn().mockResolvedValue({ id: "run-1", status: "failed" }),
    enqueueStartDiscoveryJob: vi.fn().mockResolvedValue({
      id: "start-discovery-run-1",
      acquired: true,
    }),
    revalidatePath: vi.fn(),
  };
}

describe("prospect run actions", () => {
  beforeEach(() => {
    createDiscoveryRunMock.mockReset().mockResolvedValue({ id: "run-1" });
    failStaleActiveDiscoveryRunsMock.mockReset().mockResolvedValue([]);
    markDiscoveryRunFailedMock.mockReset().mockResolvedValue({ id: "run-1", status: "failed" });
    enqueueStartDiscoveryJobMock.mockReset().mockResolvedValue({
      id: "start-discovery-run-1",
      acquired: true,
    });
    requireDashboardTenantIdMock.mockReset().mockReturnValue(tenantId);
    requireOperatorMock.mockReset().mockResolvedValue({ id: operatorId });
    revalidatePathMock.mockReset();
  });

  it("defines the only approved Greater Brisbane plumbers preset", () => {
    expect(GREATER_BRISBANE_PLUMBERS_V1).toEqual({
      key: "greater-brisbane-plumbers-v1",
      categories: ["Plumber", "Drainage service", "Gas fitter"],
      localities: ["Brisbane", "Logan", "Ipswich", "Moreton Bay", "Redlands"],
      region: "AU",
      totalLimit: 500,
    });
  });

  it("creates the fixed shadow run before enqueueing its minimal identity", async () => {
    const deps = createDeps();
    const actions = createProspectRunActions(deps);

    const result = await actions.start({ tenantId, operatorId });

    expect(deps.createDiscoveryRun).toHaveBeenCalledWith({
      tenantId,
      querySpec: GREATER_BRISBANE_PLUMBERS_V1,
    });
    expect(deps.failStaleActiveDiscoveryRuns).toHaveBeenCalledWith({
      tenantId,
      staleBefore: expect.any(Date),
      processingStaleBefore: expect.any(Date),
    });
    expect(deps.enqueueStartDiscoveryJob).toHaveBeenCalledWith({
      tenantId,
      discoveryRunId: "run-1",
    });
    expect(deps.failStaleActiveDiscoveryRuns.mock.invocationCallOrder[0]).toBeLessThan(
      deps.createDiscoveryRun.mock.invocationCallOrder[0],
    );
    expect(deps.createDiscoveryRun.mock.invocationCallOrder[0]).toBeLessThan(
      deps.enqueueStartDiscoveryJob.mock.invocationCallOrder[0],
    );
    expect(deps.revalidatePath).toHaveBeenCalledWith("/prospects");
    expect(result).toEqual({
      ok: true,
      message: "Discovery run started.",
      discoveryRunId: "run-1",
    });
  });

  it("returns an operator-safe message for an active-run unique conflict", async () => {
    const deps = createDeps();
    deps.createDiscoveryRun.mockRejectedValue(
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint_name: "discovery_runs_one_active_per_tenant_idx",
      }),
    );

    const result = await createProspectRunActions(deps).start({ tenantId, operatorId });

    expect(result).toEqual({ ok: false, message: "A discovery run is already active." });
    expect(deps.enqueueStartDiscoveryJob).not.toHaveBeenCalled();
  });

  it("does not hide an unrelated unique violation as an active-run conflict", async () => {
    const deps = createDeps();
    const error = Object.assign(new Error("unrelated unique violation"), {
      code: "23505",
      constraint_name: "discovery_runs_pkey",
    });
    deps.createDiscoveryRun.mockRejectedValue(error);

    await expect(
      createProspectRunActions(deps).start({ tenantId, operatorId }),
    ).rejects.toBe(error);
  });

  it("fails the created run when queue submission fails", async () => {
    const deps = createDeps();
    deps.enqueueStartDiscoveryJob.mockRejectedValue(new Error("Redis password leaked here"));

    const result = await createProspectRunActions(deps).start({ tenantId, operatorId });

    expect(deps.markDiscoveryRunFailed).toHaveBeenCalledWith({
      tenantId,
      discoveryRunId: "run-1",
      failureCode: "queue_submission_failed",
    });
    expect(result).toEqual({
      ok: false,
      message: "Discovery run could not be queued. Try again.",
      discoveryRunId: "run-1",
    });
    expect(result.message).not.toContain("Redis password");
  });

  it("derives tenant and operator identity on the server", async () => {
    const formData = new FormData();
    formData.set("tenantId", "browser-tenant");
    formData.set("operatorId", "browser-operator");

    const result = await startProspectDiscoveryRun(initialProspectRunActionState, formData);

    expect(requireOperatorMock).toHaveBeenCalledOnce();
    expect(requireDashboardTenantIdMock).toHaveBeenCalledOnce();
    expect(failStaleActiveDiscoveryRunsMock).toHaveBeenCalledWith({
      tenantId,
      staleBefore: expect.any(Date),
      processingStaleBefore: expect.any(Date),
    });
    expect(createDiscoveryRunMock).toHaveBeenCalledWith({
      tenantId,
      querySpec: GREATER_BRISBANE_PLUMBERS_V1,
    });
    expect(enqueueStartDiscoveryJobMock).toHaveBeenCalledWith({
      tenantId,
      discoveryRunId: "run-1",
    });
    expect(result.ok).toBe(true);
  });
});
