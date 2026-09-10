import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  buildPipelineFunnel,
  type PipelineConversion,
  type PipelineStage,
} from "@/lib/pipeline-funnel";
import { PipelineFunnel } from "./PipelineFunnel";

function measured(value: number) {
  return { available: true as const, value };
}

function missing(reason: string) {
  return { available: false as const, reason };
}

function stageCard(overrides: Partial<PipelineStage> & Pick<PipelineStage, "status">): PipelineStage {
  return {
    label: overrides.status.charAt(0).toUpperCase() + overrides.status.slice(1),
    count: measured(1),
    basis: "cohort",
    currentCount: 1,
    shareOfImported: measured(100),
    ...overrides,
  };
}

/** The live tenant's shape, so the rendered page is pinned to real numbers. */
const liveAnalytics = buildPipelineFunnel({
  milestones: {
    imported: 7574,
    enriched: 7480,
    qualified: 7120,
    contacted: 6480,
    replied: 0,
    paid: 3,
  },
  currentCounts: {
    imported: 45,
    enriched: 2,
    qualified: 2,
    contacted: 1951,
    replied: 0,
    paid: 0,
    archived: 5574,
  },
});

describe("PipelineFunnel", () => {
  it("renders every pipeline stage", () => {
    const { container } = render(
      <PipelineFunnel stages={liveAnalytics.stages} conversions={liveAnalytics.conversions} />,
    );

    const stageNames = [...container.querySelectorAll(".stage-name")].map((node) => node.textContent);
    expect(stageNames).toEqual([
      "Imported",
      "Enriched",
      "Qualified",
      "Contacted",
      "Replied",
      "Paid",
      "Archived",
    ]);
    expect(container.querySelectorAll(".stage-count")).toHaveLength(7);
    expect(screen.getByRole("img", { name: /Conversion between stages/ })).toBeInTheDocument();
  });

  it("links every stage card to the leads list filtered to that stage", () => {
    render(
      <PipelineFunnel stages={liveAnalytics.stages} conversions={liveAnalytics.conversions} />,
    );

    expect(screen.getByRole("link", { name: /Imported/ })).toHaveAttribute("href", "/leads?status=imported");
    expect(screen.getByRole("link", { name: /Qualified/ })).toHaveAttribute("href", "/leads?status=qualified");
    expect(screen.getByRole("link", { name: /Contacted/ })).toHaveAttribute("href", "/leads?status=contacted");
    expect(screen.getByRole("link", { name: /Archived/ })).toHaveAttribute("href", "/leads?status=archived");
  });

  it("puts every stage card in the tab order as a real link", () => {
    render(
      <PipelineFunnel stages={[stageCard({ status: "imported" })]} conversions={[]} />,
    );

    const card = screen.getByRole("link", { name: /Imported/ });
    expect(card.tagName).toBe("A");
    expect(card).not.toHaveAttribute("tabindex", "-1");
    card.focus();
    expect(document.activeElement).toBe(card);
  });

  /**
   * The live regression. The contacted card divided by the residual imported
   * status bucket, a few dozen rows, and rendered a share in the thousands.
   */
  it("shares each stage against the imported cohort, never the residual bucket", () => {
    const { container } = render(
      <PipelineFunnel stages={liveAnalytics.stages} conversions={liveAnalytics.conversions} />,
    );

    expect(screen.getByText("6,480")).toBeInTheDocument();
    expect(screen.getByText("85.6% of imported")).toBeInTheDocument();

    const shares = [...container.querySelectorAll(".stage-pct")].map((node) => node.textContent ?? "");
    for (const share of shares) {
      const percentage = Number(/^([\d.]+)% of imported$/.exec(share)?.[1] ?? 0);
      expect(percentage).toBeLessThanOrEqual(100);
    }
  });

  it("says what the imported card measures instead of claiming 100% of total", () => {
    render(
      <PipelineFunnel stages={liveAnalytics.stages} conversions={liveAnalytics.conversions} />,
    );

    expect(screen.queryByText("100% of total")).not.toBeInTheDocument();
    expect(screen.getByText("The funnel denominator, every lead not deleted")).toBeInTheDocument();
  });

  it("names the current status count a cohort card links to", () => {
    render(
      <PipelineFunnel stages={liveAnalytics.stages} conversions={liveAnalytics.conversions} />,
    );

    expect(screen.getByText("1,951 in this status now")).toBeInTheDocument();
  });

  it("leaves an unavailable stage card as words rather than a zero", () => {
    render(
      <PipelineFunnel
        stages={[
          stageCard({
            status: "replied",
            count: missing("A webhook bug dropped inbound replies"),
            currentCount: 0,
            shareOfImported: missing("A webhook bug dropped inbound replies"),
          }),
        ]}
        conversions={[]}
      />,
    );

    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("A webhook bug dropped inbound replies")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByText(/% of imported/)).not.toBeInTheDocument();
  });

  it("renders conversion counts and drop-off labels from the cohorts", () => {
    const conversions: PipelineConversion[] = [
      {
        from: "imported",
        to: "enriched",
        rate: measured(70),
        count: measured(7),
        enteredCount: measured(10),
        droppedCount: measured(3),
      },
    ];

    render(<PipelineFunnel stages={[stageCard({ status: "imported" })]} conversions={conversions} />);

    expect(screen.getByText("7 of 10")).toBeInTheDocument();
    expect(screen.getByText("3 dropped")).toBeInTheDocument();
    expect(screen.getByText("70.0%")).toBeInTheDocument();
  });

  it("draws a conversion bar whose height tracks the rate", () => {
    const { container } = render(
      <PipelineFunnel
        stages={[stageCard({ status: "imported" })]}
        conversions={[
          {
            from: "imported",
            to: "enriched",
            rate: measured(50),
            count: measured(5),
            enteredCount: measured(10),
            droppedCount: measured(5),
          },
        ]}
      />,
    );

    const bar = container.querySelector(".cc-bar");
    expect(bar).not.toBeNull();
    expect(Number(bar?.getAttribute("height"))).toBeCloseTo(85, 0);
  });

  it("marks a transition with no measurable rate instead of drawing a bar", () => {
    const { container } = render(
      <PipelineFunnel
        stages={[stageCard({ status: "replied" })]}
        conversions={[
          {
            from: "replied",
            to: "paid",
            rate: missing("Replied could not be counted"),
            count: measured(0),
            enteredCount: missing("Replied could not be counted"),
            droppedCount: missing("Replied could not be counted"),
          },
        ]}
      />,
    );

    expect(container.querySelector(".cc-bar")).toBeNull();
    expect(container.querySelector(".cc-bar-empty")).not.toBeNull();
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });
});
