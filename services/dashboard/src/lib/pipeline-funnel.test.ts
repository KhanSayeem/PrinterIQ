import { describe, expect, it } from "vitest";
import type { MetricAvailability } from "./deliverability";
import {
  buildPipelineFunnel,
  formatPipelineRate,
  formatQualificationCriterion,
  PIPELINE_STAGES,
  type PipelineStage,
  type PipelineConversion,
  type PipelineMilestoneCounts,
  type PipelineStageKey,
} from "./pipeline-funnel";
import { QUALIFICATION_THRESHOLD_MISSING_REASON } from "./qualification-threshold";

/**
 * Milestone cohorts as verified against the production database on 10 September
 * 2026. Evidence rows that are never removed when a lead advances, so every
 * figure only grows.
 *
 * `scored` and `qualified` are two different populations. Every lead the
 * qualifier looked at gets a `qualifications` row whether it passed or failed,
 * so `scored` is scoring coverage and `qualified` is the 4,291 that met the
 * threshold. 3,252 leads were scored and archived.
 *
 * `contactedQualified` is the part of the contacted cohort that also met the
 * threshold. It is 5 short of `contacted` because 5 leads were contacted when
 * the threshold was lower than it is now.
 */
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

const liveThreshold: MetricAvailability<number> = { available: true, value: 35 };

/**
 * A `leads.status` histogram of the shape this tenant reports. A single
 * mutually exclusive current state that only moves forward, which is why it
 * cannot carry a funnel: qualified sits at 2 because everything that qualified
 * has since advanced. These figures are an earlier snapshot than the cohorts
 * above and are here only to exercise the current status path.
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

function buildLiveFunnel(
  overrides: Partial<PipelineMilestoneCounts> = {},
  threshold: MetricAvailability<number> = liveThreshold,
) {
  return buildPipelineFunnel({
    milestones: { ...liveMilestones, ...overrides },
    currentCounts: liveCurrentCounts,
    qualificationThreshold: threshold,
  });
}

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
  /**
   * The regression this correction exists for. Defining qualified as every
   * `qualifications` row made the card read 7,543 at 100.0% of enriched, which
   * says everything qualified. 3,252 of those leads failed and were archived,
   * and that filter is the largest one in the business.
   */
  it("separates scoring coverage from the leads that met the threshold", () => {
    const { stages, conversions } = buildLiveFunnel();

    expect(stage(stages, "scored").count).toEqual({ available: true, value: 7543 });
    expect(stage(stages, "qualified").count).toEqual({ available: true, value: 4291 });

    const passStep = conversion(conversions, "scored", "qualified");
    expect(passStep.rate.available).toBe(true);
    expect(formatPipelineRate(passStep.rate.available ? passStep.rate.value : 0)).toBe("56.9%");
    expect(passStep.droppedCount).toEqual({ available: true, value: 3252 });
  });

  it("never presents the scored cohort as a qualification rate", () => {
    const { stages, conversions } = buildLiveFunnel();

    for (const step of conversions.filter((row) => row.to === "qualified")) {
      expect(step.count).not.toEqual({ available: true, value: 7543 });
      expect(step.rate.available && step.rate.value).toBeLessThan(100);
    }

    const qualified = stage(stages, "qualified");
    expect(qualified.count).not.toEqual({ available: true, value: 7543 });
    expect(qualified.shareOfImported.available && qualified.shareOfImported.value).toBeLessThan(100);
  });

  it("says the passing score in words an operator can read off the page", () => {
    expect(formatQualificationCriterion(35)).toBe("score 35 or above");
    expect(formatQualificationCriterion(0)).toBe("score 0 or above");
  });

  it("prints the threshold beside the qualified stage so the number explains itself", () => {
    const { stages } = buildLiveFunnel();

    expect(stage(stages, "qualified").criterion).toBe("score 35 or above");
  });

  it("prints whatever threshold is configured rather than a remembered 35", () => {
    const { stages } = buildLiveFunnel({}, { available: true, value: 60 });

    expect(stage(stages, "qualified").criterion).toBe("score 60 or above");
  });

  /**
   * Guessing a threshold would invent the one figure the pass rate is made of,
   * and a guess of zero would make every scored lead pass, which is the bug
   * this stage was corrected for.
   */
  it("renders the qualified stage as unavailable when no threshold is configured", () => {
    const { stages, conversions } = buildLiveFunnel(
      { qualified: null, contactedQualified: null },
      { available: false, reason: QUALIFICATION_THRESHOLD_MISSING_REASON },
    );

    const qualified = stage(stages, "qualified");
    expect(qualified.count.available).toBe(false);
    expect(!qualified.count.available && qualified.count.reason).toMatch(
      /QUALIFICATION_SCORE_THRESHOLD/,
    );
    expect(qualified.criterion).toBeNull();
    expect(qualified.shareOfImported.available).toBe(false);

    expect(conversion(conversions, "scored", "qualified").rate.available).toBe(false);
    expect(conversion(conversions, "qualified", "contacted").rate.available).toBe(false);
  });

  it("keeps the stages that do not need a threshold measurable without one", () => {
    const { stages } = buildLiveFunnel(
      { qualified: null, contactedQualified: null },
      { available: false, reason: QUALIFICATION_THRESHOLD_MISSING_REASON },
    );

    expect(stage(stages, "scored").count).toEqual({ available: true, value: 7543 });
    expect(stage(stages, "contacted").count).toEqual({ available: true, value: 1960 });
    expect(stage(stages, "imported").count).toEqual({ available: true, value: 7574 });
  });

  it("never treats a missing threshold as a threshold of zero", () => {
    const { stages } = buildLiveFunnel(
      { qualified: null, contactedQualified: null },
      { available: false, reason: QUALIFICATION_THRESHOLD_MISSING_REASON },
    );

    const qualified = stage(stages, "qualified");
    expect(qualified.count).not.toEqual({ available: true, value: 7543 });
    expect(qualified.count).not.toEqual({ available: true, value: 0 });
  });

  /**
   * 1,960 leads were contacted but only 1,955 of them met the current
   * threshold, so a rate built from the full contacted count against the
   * passing cohort would mix two populations. The step counts the part of the
   * contacted cohort that also passed, and the card names the difference.
   */
  it("rates contacted against the part of the contacted cohort that passed", () => {
    const { stages, conversions } = buildLiveFunnel();

    const step = conversion(conversions, "qualified", "contacted");
    expect(step.enteredCount).toEqual({ available: true, value: 4291 });
    expect(step.count).toEqual({ available: true, value: 1955 });
    expect(formatPipelineRate(step.rate.available ? step.rate.value : 0)).toBe("45.6%");
    expect(step.droppedCount).toEqual({ available: true, value: 2336 });

    const contacted = stage(stages, "contacted");
    expect(contacted.count).toEqual({ available: true, value: 1960 });
    expect(contacted.cohortNote).toBe("5 contacted leads score below 35");
  });

  it("says nothing about a below-threshold contacted group when there is none", () => {
    const { stages } = buildLiveFunnel({ contactedQualified: 1960 });

    expect(stage(stages, "contacted").cohortNote).toBeNull();
  });

  /**
   * If the threshold is raised, leads contacted under the old one can outnumber
   * the cohort that passes the new one. That is a rate above 100% and it must
   * stay a rate above 100%: the true figure is reported, the drop is not, and
   * the chart caps the bar without letting it read as complete.
   */
  it("reports a rate above 100% rather than clamping it when contacted exceeds the passing cohort", () => {
    const { conversions } = buildLiveFunnel(
      { qualified: 1500, contactedQualified: 1960 },
      { available: true, value: 80 },
    );

    const step = conversion(conversions, "qualified", "contacted");

    expect(step.rate.available).toBe(true);
    expect(step.rate.available && step.rate.value).toBeCloseTo(130.7, 1);
    expect(step.rate.available && step.rate.value).toBeGreaterThan(100);
    expect(step.droppedCount.available).toBe(false);
    expect(!step.droppedCount.available && step.droppedCount.reason).toMatch(
      /drop cannot be measured/i,
    );
  });

  it("reports the replied cohort as unavailable rather than a measured zero", () => {
    const { conversions } = buildLiveFunnel();

    const step = conversion(conversions, "contacted", "replied");

    expect(step.count.available).toBe(false);
    expect(!step.count.available && step.count.reason).toMatch(/webhook/i);
    expect(step.rate.available).toBe(false);
  });

  it("counts the leads that really dropped between cohorts", () => {
    const { conversions } = buildLiveFunnel();

    expect(conversion(conversions, "imported", "enriched").droppedCount).toEqual({
      available: true,
      value: 28,
    });
    expect(conversion(conversions, "enriched", "scored").droppedCount).toEqual({
      available: true,
      value: 3,
    });
  });

  it("refuses to call a negative drop zero", () => {
    const { conversions } = buildLiveFunnel({ qualified: 100 });

    const step = conversion(conversions, "qualified", "contacted");

    expect(step.droppedCount.available).toBe(false);
    expect(!step.droppedCount.available && step.droppedCount.reason).toMatch(
      /drop cannot be measured/i,
    );
  });

  it("gives no rate at all when the denominator cohort is empty", () => {
    const { conversions } = buildLiveFunnel({ qualified: 0, contactedQualified: 0 });

    const step = conversion(conversions, "qualified", "contacted");

    expect(step.rate.available).toBe(false);
    expect(!step.rate.available && step.rate.reason).toMatch(/no leads ever reached qualified/i);
  });

  it("counts each stage card from its cohort and keeps the current status count beside it", () => {
    const { stages } = buildLiveFunnel();

    expect(stages.map((row) => row.status)).toEqual([...PIPELINE_STAGES]);

    const contacted = stage(stages, "contacted");
    expect(contacted.count).toEqual({ available: true, value: 1960 });
    expect(contacted.basis).toBe("cohort");
    expect(contacted.currentCount).toBe(1951);
    expect(contacted.linksToCurrentStatus).toBe(true);
    expect(contacted.shareOfImported.available).toBe(true);
    expect(contacted.shareOfImported.available && contacted.shareOfImported.value).toBeCloseTo(
      25.9,
      1,
    );
  });

  /**
   * There is no `scored` lead status and the qualified status bucket holds the
   * residue that has not advanced, so neither card can honestly link to a
   * status filter. Both link to the score filter that reproduces the cohort.
   */
  it("links the score-defined cards to the score filter rather than a status", () => {
    const { stages } = buildLiveFunnel();

    const scored = stage(stages, "scored");
    expect(scored.href).toBe("/leads?score_min=0");
    expect(scored.linksToCurrentStatus).toBe(false);
    expect(scored.currentCount).toBeNull();

    const qualified = stage(stages, "qualified");
    expect(qualified.href).toBe("/leads?score_min=35");
    expect(qualified.linksToCurrentStatus).toBe(false);

    expect(stage(stages, "contacted").href).toBe("/leads?status=contacted");
    expect(stage(stages, "archived").href).toBe("/leads?status=archived");
  });

  it("does not link the qualified card to a score filter it cannot build", () => {
    const { stages } = buildLiveFunnel(
      { qualified: null, contactedQualified: null },
      { available: false, reason: QUALIFICATION_THRESHOLD_MISSING_REASON },
    );

    expect(stage(stages, "qualified").href).toBe("/leads");
  });

  it("never divides a stage share by the residual imported bucket", () => {
    const { stages } = buildLiveFunnel();

    for (const row of stages) {
      if (row.shareOfImported.available) {
        expect(row.shareOfImported.value).toBeLessThanOrEqual(100);
      }
    }
  });

  it("says what the imported card measures instead of claiming 100% of total", () => {
    const { stages } = buildLiveFunnel();

    const imported = stage(stages, "imported");

    expect(imported.count).toEqual({ available: true, value: 7574 });
    expect(imported.shareOfImported.available).toBe(false);
    expect(!imported.shareOfImported.available && imported.shareOfImported.reason).toMatch(
      /denominator/i,
    );
  });

  it("keeps archived as a current status bucket rather than a cohort", () => {
    const { stages } = buildLiveFunnel();

    const archived = stage(stages, "archived");

    expect(archived.count).toEqual({ available: true, value: 5574 });
    expect(archived.basis).toBe("current-status");
    expect(archived.shareOfImported.available).toBe(false);
  });

  it("leaves the replied stage card unavailable rather than showing a zero share", () => {
    const { stages } = buildLiveFunnel();

    const replied = stage(stages, "replied");

    expect(replied.count.available).toBe(false);
    expect(replied.shareOfImported.available).toBe(false);
  });

  it("counts every non-deleted lead as the funnel total", () => {
    expect(buildLiveFunnel().total).toBe(7574);
  });

  it("never rounds a real share down to zero percent", () => {
    const { stages } = buildLiveFunnel({ paid: 3 });

    const paid = stage(stages, "paid");

    expect(paid.count).toEqual({ available: true, value: 3 });
    expect(paid.shareOfImported.available).toBe(true);
    expect(formatPipelineRate(paid.shareOfImported.available ? paid.shareOfImported.value : 0)).toBe(
      "under 0.1%",
    );
  });

  /**
   * 7,543 of 7,546 enriched leads were scored. Rounding that to "100.0%" over
   * a "3 dropped" label contradicts itself, the same way rounding a real share
   * down to "0.0%" does.
   */
  it("never rounds an incomplete share up to one hundred percent", () => {
    const { conversions } = buildLiveFunnel();

    const step = conversion(conversions, "enriched", "scored");

    expect(formatPipelineRate(step.rate.available ? step.rate.value : 0)).toBe("just under 100%");
  });

  it("formats a measured zero as zero and everything else to one decimal", () => {
    expect(formatPipelineRate(0)).toBe("0.0%");
    expect(formatPipelineRate(91.011)).toBe("91.0%");
    expect(formatPipelineRate(0.0396)).toBe("under 0.1%");
    expect(formatPipelineRate(100)).toBe("100.0%");
    expect(formatPipelineRate(99.96)).toBe("just under 100%");
    expect(formatPipelineRate(100.02)).toBe("just over 100%");
    expect(formatPipelineRate(130.7)).toBe("130.7%");
  });
});
