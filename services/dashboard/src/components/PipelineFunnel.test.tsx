import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  buildPipelineFunnel,
  type PipelineConversion,
  type PipelineMilestoneCounts,
  type PipelineStage,
} from "@/lib/pipeline-funnel";
import { QUALIFICATION_THRESHOLD_MISSING_REASON } from "@/lib/qualification-threshold";
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
    criterion: null,
    currentCount: 1,
    linksToCurrentStatus: true,
    href: `/leads?status=${overrides.status}`,
    cohortNote: null,
    shareOfImported: measured(100),
    ...overrides,
  };
}

/** Verified against the production database on 10 September 2026. */
const liveMilestones: PipelineMilestoneCounts = {
  imported: 7574,
  enriched: 7546,
  scored: 7543,
  qualified: 4291,
  contacted: 1960,
  contactedQualified: 1955,
  replied: 0,
  paid: 0,
};

const liveCurrentCounts = {
  imported: 45,
  enriched: 2,
  qualified: 2,
  contacted: 1951,
  replied: 0,
  paid: 0,
  archived: 5574,
};

const liveAnalytics = buildPipelineFunnel({
  milestones: liveMilestones,
  currentCounts: liveCurrentCounts,
  qualificationThreshold: measured(35),
});

const noThresholdAnalytics = buildPipelineFunnel({
  milestones: { ...liveMilestones, qualified: null, contactedQualified: null },
  currentCounts: liveCurrentCounts,
  qualificationThreshold: missing(QUALIFICATION_THRESHOLD_MISSING_REASON),
});

/** The one card, so an assertion about Qualified cannot pass on Scored. */
function cardFor(container: HTMLElement, label: string) {
  const card = [...container.querySelectorAll(".stage-card")].find(
    (node) => node.querySelector(".stage-name")?.textContent === label,
  );
  if (!card) {
    throw new Error(`No ${label} stage card was rendered`);
  }

  return card as HTMLElement;
}

describe("PipelineFunnel", () => {
  it("renders every pipeline stage", () => {
    const { container } = render(
      <PipelineFunnel stages={liveAnalytics.stages} conversions={liveAnalytics.conversions} />,
    );

    const stageNames = [...container.querySelectorAll(".stage-name")].map((node) => node.textContent);
    expect(stageNames).toEqual([
      "Imported",
      "Enriched",
      "Scored",
      "Qualified",
      "Contacted",
      "Replied",
      "Paid",
      "Archived",
    ]);
    expect(container.querySelectorAll(".stage-count")).toHaveLength(8);
    expect(screen.getByRole("img", { name: /Conversion between stages/ })).toBeInTheDocument();
  });

  /**
   * The live regression. Qualified was defined as every `qualifications` row,
   * so the card read 7,543 at 100.0% of enriched, which says everything
   * qualified. 3,252 of those leads scored below the threshold and were
   * archived, and that filter is the largest one in the business.
   */
  it("shows the leads that met the threshold on the qualified card, not every scored lead", () => {
    const { container } = render(
      <PipelineFunnel stages={liveAnalytics.stages} conversions={liveAnalytics.conversions} />,
    );

    const qualified = cardFor(container, "Qualified");
    expect(qualified.querySelector(".stage-count")?.textContent).toBe("4,291");
    expect(qualified.textContent).not.toContain("7,543");
    expect(qualified.textContent).not.toContain("100");

    const scored = cardFor(container, "Scored");
    expect(scored.querySelector(".stage-count")?.textContent).toBe("7,543");
  });

  it("prints the passing score on the qualified card", () => {
    const { container } = render(
      <PipelineFunnel stages={liveAnalytics.stages} conversions={liveAnalytics.conversions} />,
    );

    expect(cardFor(container, "Qualified").textContent).toContain("score 35 or above");
  });

  it("shows the pass rate as a conversion step between scored and qualified", () => {
    render(
      <PipelineFunnel stages={liveAnalytics.stages} conversions={liveAnalytics.conversions} />,
    );

    expect(screen.getByText("56.9%")).toBeInTheDocument();
    expect(screen.getByText("4,291 of 7,543")).toBeInTheDocument();
    expect(screen.getByText("3,252 dropped")).toBeInTheDocument();
  });

  it("names the contacted leads that fall below the current threshold", () => {
    render(
      <PipelineFunnel stages={liveAnalytics.stages} conversions={liveAnalytics.conversions} />,
    );

    expect(screen.getByText("1,955 of 4,291")).toBeInTheDocument();
    expect(screen.getByText("5 contacted leads score below 35")).toBeInTheDocument();
  });

  /**
   * With no threshold configured there is no passing score to divide by, and
   * guessing one would invent the figure the whole card is made of.
   */
  it("renders the qualified card as unavailable when no threshold is configured", () => {
    const { container } = render(
      <PipelineFunnel
        stages={noThresholdAnalytics.stages}
        conversions={noThresholdAnalytics.conversions}
      />,
    );

    const qualified = cardFor(container, "Qualified");
    expect(qualified.querySelector(".stage-count-unavailable")?.textContent).toBe("Not available");
    expect(qualified.textContent).toContain("QUALIFICATION_SCORE_THRESHOLD");
    expect(qualified.textContent).not.toMatch(/% of imported/);
    expect(qualified.textContent).not.toContain("4,291");
    expect(qualified.textContent).not.toContain("7,543");

    expect(cardFor(container, "Scored").querySelector(".stage-count")?.textContent).toBe("7,543");
  });

  it("links every stage card to a leads view that reproduces its own figure", () => {
    render(
      <PipelineFunnel stages={liveAnalytics.stages} conversions={liveAnalytics.conversions} />,
    );

    expect(screen.getByRole("link", { name: /Imported/ })).toHaveAttribute("href", "/leads?status=imported");
    expect(screen.getByRole("link", { name: /Scored/ })).toHaveAttribute("href", "/leads?score_min=0");
    expect(screen.getByRole("link", { name: /Qualified/ })).toHaveAttribute("href", "/leads?score_min=35");
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

    expect(screen.getByText("1,960")).toBeInTheDocument();
    expect(screen.getByText("25.9% of imported")).toBeInTheDocument();

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

  it("never claims a status count for a stage that has no lead status", () => {
    const { container } = render(
      <PipelineFunnel stages={liveAnalytics.stages} conversions={liveAnalytics.conversions} />,
    );

    expect(cardFor(container, "Scored").textContent).not.toContain("in this status now");
    expect(cardFor(container, "Qualified").textContent).not.toContain("in this status now");
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
