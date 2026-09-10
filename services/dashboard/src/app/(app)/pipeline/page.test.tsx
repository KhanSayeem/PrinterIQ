import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDashboardTenantIdMock, getPipelineAnalyticsMock } = vi.hoisted(() => ({
  getDashboardTenantIdMock: vi.fn(),
  getPipelineAnalyticsMock: vi.fn(),
}));

vi.mock("@/auth/tenant", () => ({
  getDashboardTenantId: getDashboardTenantIdMock,
}));

vi.mock("@/db/queries", () => ({
  getPipelineAnalytics: getPipelineAnalyticsMock,
}));

import { buildPipelineFunnel } from "@/lib/pipeline-funnel";

import PipelinePage from "./page";

const analytics = buildPipelineFunnel({
  milestones: {
    imported: 7574,
    enriched: 7480,
    qualified: 7120,
    contacted: 6480,
    replied: 0,
    paid: 3,
  },
  currentCounts: { imported: 45, qualified: 2, contacted: 1951, archived: 5574 },
});

describe("PipelinePage", () => {
  beforeEach(() => {
    getDashboardTenantIdMock.mockReset();
    getPipelineAnalyticsMock.mockReset();
    getDashboardTenantIdMock.mockReturnValue("10000000-0000-0000-0000-000000000001");
    getPipelineAnalyticsMock.mockResolvedValue(analytics);
  });

  it("renders the funnel", async () => {
    render(await PipelinePage());

    expect(screen.getByText("Funnel")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Imported/ })).toHaveAttribute("href", "/leads?status=imported");
  });

  it("no longer renders the stage details side card", async () => {
    const { container } = render(await PipelinePage());

    expect(container.querySelector(".pipeline-detail-panel")).toBeNull();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByText("Top weaknesses")).not.toBeInTheDocument();
    expect(screen.queryByText("Sample leads")).not.toBeInTheDocument();
    expect(screen.queryByText(/View all .* leads/)).not.toBeInTheDocument();
  });

  it("no longer asks the database for a selected stage's detail", async () => {
    render(await PipelinePage());

    expect(getPipelineAnalyticsMock).toHaveBeenCalledWith({
      tenantId: "10000000-0000-0000-0000-000000000001",
    });
  });

  it("says so when the pipeline data cannot be read", async () => {
    getPipelineAnalyticsMock.mockRejectedValue(new Error("pipeline query failed"));

    render(await PipelinePage());

    expect(screen.getByText(/Failed to load pipeline data/)).toBeInTheDocument();
  });

  it("does not call a current status snapshot an all time breakdown", async () => {
    render(await PipelinePage());

    expect(screen.queryByText(/all time/i)).not.toBeInTheDocument();
    expect(screen.getByText(/ever reached each stage/i)).toBeInTheDocument();
  });
});
