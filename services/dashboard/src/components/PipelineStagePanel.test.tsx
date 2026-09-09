import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PipelineStagePanel } from "./PipelineStagePanel";

describe("PipelineStagePanel", () => {
  it("renders selected stage metrics, top weaknesses, and sample leads", () => {
    render(
      <PipelineStagePanel
        detail={{
          status: "qualified",
          label: "Qualified",
          count: 3,
          shareOfImported: 60,
          previousConversionLabel: "75.0%",
          droppedFromPrevious: 1,
          averageScore: 72,
          topWeaknesses: [
            { label: "Slow mobile site", count: 2 },
            { label: "No SSL", count: 1 },
          ],
          sampleLeads: [
            {
              id: "lead-1",
              firstName: "Darren",
              lastName: "Smith",
              businessName: "Aqua Options",
              city: "Sydney",
              state: "NSW",
              status: "qualified",
              score: 72,
              updatedAt: new Date("2026-05-27T00:00:00Z"),
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Qualified details")).toBeInTheDocument();
    expect(screen.getByText("60.0%")).toBeInTheDocument();
    expect(screen.getByText("Slow mobile site")).toBeInTheDocument();
    expect(screen.getByText("Aqua Options")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View all qualified leads/ })).toHaveAttribute(
      "href",
      "/leads?status=qualified",
    );
  });

  it("renders empty states when stage detail has no supporting data", () => {
    render(
      <PipelineStagePanel
        detail={{
          status: "paid",
          label: "Paid",
          count: 0,
          shareOfImported: 0,
          previousConversionLabel: "--",
          droppedFromPrevious: 0,
          averageScore: null,
          topWeaknesses: [],
          sampleLeads: [],
        }}
      />,
    );

    expect(screen.getByText("No website weaknesses recorded for this stage.")).toBeInTheDocument();
    expect(screen.getByText("No leads currently in this stage.")).toBeInTheDocument();
    expect(screen.queryByText("No score data yet.")).not.toBeInTheDocument();
    expect(screen.queryByText("Avg score")).not.toBeInTheDocument();
    expect(screen.queryByText("Previous conversion")).not.toBeInTheDocument();
    expect(screen.queryByText("Dropped from previous")).not.toBeInTheDocument();
  });

  it("drops the tautological metrics on the first stage", () => {
    render(
      <PipelineStagePanel
        detail={{
          status: "imported",
          label: "Imported",
          count: 12,
          shareOfImported: 100,
          previousConversionLabel: "Starting stage",
          droppedFromPrevious: 0,
          averageScore: null,
          topWeaknesses: [],
          sampleLeads: [],
        }}
      />,
    );

    expect(screen.getByText("Imported details")).toBeInTheDocument();
    expect(screen.queryByText("Share of imported")).not.toBeInTheDocument();
    expect(screen.queryByText("Starting stage")).not.toBeInTheDocument();
    expect(screen.queryByText("Dropped from previous")).not.toBeInTheDocument();
    expect(screen.queryByText("Avg score")).not.toBeInTheDocument();
  });

  it("keeps the metrics that carry information for later stages", () => {
    render(
      <PipelineStagePanel
        detail={{
          status: "contacted",
          label: "Contacted",
          count: 4,
          shareOfImported: 40,
          previousConversionLabel: "80.0%",
          droppedFromPrevious: 1,
          averageScore: 66.5,
          topWeaknesses: [],
          sampleLeads: [],
        }}
      />,
    );

    expect(screen.getByText("Share of imported")).toBeInTheDocument();
    expect(screen.getByText("80.0%")).toBeInTheDocument();
    expect(screen.getByText("Dropped from previous")).toBeInTheDocument();
    expect(screen.getByText("66.5")).toBeInTheDocument();
  });
});
