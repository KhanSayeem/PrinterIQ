import { describe, expect, it } from "vitest";
import {
  buildPipelineFunnel,
  formatPipelineRate,
  PIPELINE_STAGES,
  type PipelineStage,
  type PipelineConversion,
  type PipelineMilestoneCounts,
  type PipelineStageKey,
} from "./pipeline-funnel";

/**
 * Milestone cohorts of the shape the live tenant reports: evidence rows that
 * are never removed when a lead advances, so every figure only grows.
 */
const liveMilestones: PipelineMilestoneCounts = {
  imported: 7574,
  enriched: 7480,
  qualified: 7120,
  contacted: 6480,
  replied: 0,
  paid: 3,
};

/**
 * The live `leads.status` histogram. A single mutually exclusive current state
 * that only moves forward, which is why it cannot carry a funnel: qualified
 * sits at 2 because everything that qualified has since advanced.
 */
const liveCurrentCounts: Partial<Record<PipelineStageKey, number>> = {
  imported: 45,
  enriched: 2,
  qualified: 2,
  contacted: 1951,
  replied: 0,
  paid: 0,
  archived: 5574,
};

function conversion(
  conversions: PipelineConversion[],
  from: PipelineStageKey,
  to: PipelineStageKey,
): PipelineConversion {
  const found = conversions.find((row) => row.from === from && row.to === to);
  if (!found) {
    throw new Error(`No ${from} to ${to} conversion was built`);
  }

  return found;
}

function stage(stages: PipelineStage[], status: PipelineStageKey): PipelineStage {
  const found = stages.find((row) => row.status === status);
  if (!found) {
    throw new Error(`No ${status} stage was built`);
  }

  return found;
}

describe("buildPipelineFunnel", () => {
  it("rates qualified to contacted against the qualified cohort, not the residual status bucket", () => {
    const { conversions } = buildPipelineFunnel({
      milestones: liveMilestones,
      currentCounts: liveCurrentCounts,
    });

    const step = conversion(conversions, "qualified", "contacted");

    expect(step.rate.available).toBe(true);
    expect(step.rate.available && step.rate.value).toBeCloseTo(91.0, 1);
    expect(step.rate.available && step.rate.value).toBeLessThanOrEqual(100);
  });

  it("reports the replied cohort as unavailable rather than a measured zero", () => {
    const { conversions } = buildPipelineFunnel({
      milestones: liveMilestones,
      currentCounts: liveCurrentCounts,
    });

    const step = conversion(conversions, "contacted", "replied");

    expect(step.count.available).toBe(false);
    expect(!step.count.available && step.count.reason).toMatch(/webhook/i);
    expect(step.rate.available).toBe(false);
  });

  it("counts the leads that really dropped between cohorts", () => {
    const { conversions } = buildPipelineFunnel({
      milestones: liveMilestones,
      currentCounts: liveCurrentCounts,
    });

    const enrichedStep = conversion(conversions, "imported", "enriched");
    const contactedStep = conversion(conversions, "qualified", "contacted");

    expect(enrichedStep.droppedCount).toEqual({ available: true, value: 94 });
    expect(contactedStep.droppedCount).toEqual({ available: true, value: 640 });
  });

  it("refuses to call a negative drop zero", () => {
    const { conversions } = buildPipelineFunnel({
      milestones: { ...liveMilestones, qualified: 100, contacted: 6480 },
      currentCounts: liveCurrentCounts,
    });

    const step = conversion(conversions, "qualified", "contacted");

    expect(step.droppedCount.available).toBe(false);
    expect(!step.droppedCount.available && step.droppedCount.reason).toMatch(
      /drop cannot be measured/i,
    );
  });

  it("gives no rate at all when the denominator cohort is empty", () => {
    const { conversions } = buildPipelineFunnel({
      milestones: { ...liveMilestones, qualified: 0, contacted: 0 },
      currentCounts: liveCurrentCounts,
    });

    const step = conversion(conversions, "qualified", "contacted");

    expect(step.rate.available).toBe(false);
    expect(!step.rate.available && step.rate.reason).toMatch(/no leads ever reached qualified/i);
  });

  it("counts each stage card from its cohort and keeps the current status count beside it", () => {
    const { stages } = buildPipelineFunnel({
      milestones: liveMilestones,
      currentCounts: liveCurrentCounts,
    });

    expect(stages.map((stage) => stage.status)).toEqual([...PIPELINE_STAGES]);

    const contacted = stage(stages, "contacted");
    expect(contacted.count).toEqual({ available: true, value: 6480 });
    expect(contacted.basis).toBe("cohort");
    expect(contacted.currentCount).toBe(1951);
    expect(contacted.shareOfImported.available).toBe(true);
    expect(contacted.shareOfImported.available && contacted.shareOfImported.value).toBeCloseTo(85.6, 1);
  });

  it("never divides a stage share by the residual imported bucket", () => {
    const { stages } = buildPipelineFunnel({
      milestones: liveMilestones,
      currentCounts: liveCurrentCounts,
    });

    const share = stage(stages, "contacted").shareOfImported;

    expect(share.available && share.value).toBeLessThanOrEqual(100);
  });

  it("says what the imported card measures instead of claiming 100% of total", () => {
    const { stages } = buildPipelineFunnel({
      milestones: liveMilestones,
      currentCounts: liveCurrentCounts,
    });

    const imported = stage(stages, "imported");

    expect(imported.count).toEqual({ available: true, value: 7574 });
    expect(imported.shareOfImported.available).toBe(false);
    expect(!imported.shareOfImported.available && imported.shareOfImported.reason).toMatch(
      /denominator/i,
    );
  });

  it("keeps archived as a current status bucket rather than a cohort", () => {
    const { stages } = buildPipelineFunnel({
      milestones: liveMilestones,
      currentCounts: liveCurrentCounts,
    });

    const archived = stage(stages, "archived");

    expect(archived.count).toEqual({ available: true, value: 5574 });
    expect(archived.basis).toBe("current-status");
    expect(archived.shareOfImported.available).toBe(false);
  });

  it("leaves the replied stage card unavailable rather than showing a zero share", () => {
    const { stages } = buildPipelineFunnel({
      milestones: liveMilestones,
      currentCounts: liveCurrentCounts,
    });

    const replied = stage(stages, "replied");

    expect(replied.count.available).toBe(false);
    expect(replied.shareOfImported.available).toBe(false);
  });

  it("counts every non-deleted lead as the funnel total", () => {
    const analytics = buildPipelineFunnel({
      milestones: liveMilestones,
      currentCounts: liveCurrentCounts,
    });

    expect(analytics.total).toBe(7574);
  });

  it("never rounds a real share down to zero percent", () => {
    const { stages } = buildPipelineFunnel({
      milestones: liveMilestones,
      currentCounts: liveCurrentCounts,
    });

    const paid = stage(stages, "paid");

    expect(paid.count).toEqual({ available: true, value: 3 });
    expect(paid.shareOfImported.available).toBe(true);
    expect(formatPipelineRate(paid.shareOfImported.available ? paid.shareOfImported.value : 0)).toBe(
      "under 0.1%",
    );
  });

  it("formats a measured zero as zero and everything else to one decimal", () => {
    expect(formatPipelineRate(0)).toBe("0.0%");
    expect(formatPipelineRate(91.011)).toBe("91.0%");
    expect(formatPipelineRate(0.0396)).toBe("under 0.1%");
  });
});
