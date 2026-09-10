import type { MetricAvailability } from "./deliverability";

/**
 * The funnel is computed from milestone evidence, never from `leads.status`.
 *
 * `leads.status` is a single mutually exclusive current state that only moves
 * forward, so its histogram is the residual population that has not yet
 * advanced. Using it as a funnel denominator produced rates in the tens of
 * thousands of percent: qualified sat at 2 while contacted sat at 1951, and
 * "Qualified to Contacted" rendered 97550.0%.
 *
 * A milestone row is never removed when a lead advances, so these cohorts only
 * ever grow and the ratios between them are real:
 *
 * - imported: leads that are not deleted
 * - enriched: leads with an enrichment row
 * - qualified: leads with a qualification row
 * - contacted: leads with an outreach send
 * - replied: leads with an inbound conversation
 * - paid: leads with a paid payment
 *
 * Every figure is an availability wrapper rather than a bare number, matching
 * `src/lib/deliverability.ts`. A figure this system cannot measure renders as
 * words and never as zero, because a silent zero here reads as a measured
 * result.
 */

export const PIPELINE_STAGES = [
  "imported",
  "enriched",
  "qualified",
  "contacted",
  "replied",
  "paid",
  "archived",
] as const;

export type PipelineStageKey = (typeof PIPELINE_STAGES)[number];

/**
 * The stages that form the funnel. Archived is deliberately absent: archiving
 * writes no milestone row, so there is no cohort that ever reached it, only a
 * current status bucket.
 */
export const FUNNEL_STAGES = [
  "imported",
  "enriched",
  "qualified",
  "contacted",
  "replied",
  "paid",
] as const;

export type FunnelStageKey = (typeof FUNNEL_STAGES)[number];

export type PipelineMilestoneCounts = Record<FunnelStageKey, number>;

export type PipelineStage = {
  readonly status: PipelineStageKey;
  readonly label: string;
  /** The headline figure for the stage card. */
  readonly count: MetricAvailability<number>;
  /** What `count` measures, so the card can say so rather than imply a cohort. */
  readonly basis: "cohort" | "current-status";
  /** Leads whose current status is this stage. This is what the stage link opens. */
  readonly currentCount: number;
  /** Share of the imported cohort that ever reached this stage, 0 to 100. */
  readonly shareOfImported: MetricAvailability<number>;
};

export type PipelineConversion = {
  readonly from: FunnelStageKey;
  readonly to: FunnelStageKey;
  /** Percentage of the `from` cohort that went on to reach `to`, 0 to 100. */
  readonly rate: MetricAvailability<number>;
  /** Leads that reached `to`. */
  readonly count: MetricAvailability<number>;
  /** Leads that reached `from`. The real denominator of `rate`. */
  readonly enteredCount: MetricAvailability<number>;
  /** Leads that reached `from` and never reached `to`. */
  readonly droppedCount: MetricAvailability<number>;
};

export type PipelineAnalytics = {
  readonly stages: PipelineStage[];
  readonly conversions: PipelineConversion[];
  /** Non-deleted leads. Drives the page's empty state. */
  readonly total: number;
};

export type BuildPipelineFunnelInput = {
  readonly milestones: PipelineMilestoneCounts;
  readonly currentCounts: Partial<Record<PipelineStageKey, number>>;
};

function available<T>(value: T): MetricAvailability<T> {
  return { available: true, value };
}

function unavailable<T>(reason: string): MetricAvailability<T> {
  return { available: false, reason };
}

function labelForStage(stage: PipelineStageKey) {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

/**
 * A rate that is real but tiny must not round down to "0.0%". Three paid leads
 * out of 7,574 is 0.04%, and printing that as zero is the same silent zero this
 * dashboard has already been burned by.
 */
export function formatPipelineRate(rate: number) {
  if (rate > 0 && rate < 0.1) {
    return "under 0.1%";
  }

  return `${rate.toFixed(1)}%`;
}

/**
 * A webhook bug dropped every inbound reply and the fix is not deployed yet,
 * so `conversations` holds no inbound rows. A zero reply cohort is therefore
 * the known symptom of that bug rather than a measurement, and presenting it
 * as 0% would read as "the campaign gets no replies". Once real inbound rows
 * land the count becomes evidence again and this stage measures itself.
 */
export const REPLIED_COHORT_UNAVAILABLE_REASON =
  "No inbound replies are recorded. A webhook bug dropped them and the fix is not deployed, so zero is not a measured result.";

/**
 * Imported is the denominator every other share is measured against, so it has
 * no share of its own. The card used to claim "100% of total", which was wrong
 * twice: the figure it divided by was the residual imported status bucket, and
 * a stage is never 100% of itself in any useful sense.
 */
export const IMPORTED_SHARE_UNAVAILABLE_REASON =
  "The funnel denominator, every lead not deleted";

/** Archiving writes no milestone row, so there is no cohort to divide. */
export const ARCHIVED_SHARE_UNAVAILABLE_REASON =
  "Current status count, not a cohort";

function isFunnelStage(stage: PipelineStageKey): stage is FunnelStageKey {
  return (FUNNEL_STAGES as readonly PipelineStageKey[]).includes(stage);
}

function resolveMilestone(
  stage: FunnelStageKey,
  counts: PipelineMilestoneCounts,
): MetricAvailability<number> {
  if (stage === "replied" && counts.replied === 0) {
    return unavailable(REPLIED_COHORT_UNAVAILABLE_REASON);
  }

  return available(counts[stage]);
}

export function buildPipelineFunnel(input: BuildPipelineFunnelInput): PipelineAnalytics {
  const cohorts = new Map<FunnelStageKey, MetricAvailability<number>>(
    FUNNEL_STAGES.map((stage) => [stage, resolveMilestone(stage, input.milestones)]),
  );

  const conversions = FUNNEL_STAGES.slice(1).map((to, index) => {
    const from = FUNNEL_STAGES[index]!;
    const entered = cohorts.get(from)!;
    const reached = cohorts.get(to)!;

    return {
      from,
      to,
      rate: rateOf({ from, to, entered, reached }),
      count: reached,
      enteredCount: entered,
      droppedCount: dropOf({ from, to, entered, reached }),
    };
  });

  const importedCohort = cohorts.get("imported")!;
  const stages = PIPELINE_STAGES.map<PipelineStage>((status) => {
    const currentCount = input.currentCounts[status] ?? 0;

    if (!isFunnelStage(status)) {
      return {
        status,
        label: labelForStage(status),
        count: available(currentCount),
        basis: "current-status",
        currentCount,
        shareOfImported: unavailable(ARCHIVED_SHARE_UNAVAILABLE_REASON),
      };
    }

    const cohort = cohorts.get(status)!;

    return {
      status,
      label: labelForStage(status),
      count: cohort,
      basis: "cohort",
      currentCount,
      shareOfImported:
        status === "imported"
          ? unavailable(IMPORTED_SHARE_UNAVAILABLE_REASON)
          : rateOf({ from: "imported", to: status, entered: importedCohort, reached: cohort }),
    };
  });

  return { stages, conversions, total: input.milestones.imported };
}

type Step = {
  readonly from: FunnelStageKey;
  readonly to: FunnelStageKey;
  readonly entered: MetricAvailability<number>;
  readonly reached: MetricAvailability<number>;
};

/**
 * A rate is only rendered when both sides were measured and the denominator is
 * a real population. An unmeasured or empty denominator gives no rate at all,
 * not 0.0% and not a clamped bar.
 */
function rateOf(step: Step): MetricAvailability<number> {
  if (!step.entered.available) {
    return unavailable(
      `${labelForStage(step.from)} could not be counted, so there is no denominator: ${step.entered.reason}`,
    );
  }
  if (!step.reached.available) {
    return unavailable(
      `${labelForStage(step.to)} could not be counted: ${step.reached.reason}`,
    );
  }
  if (step.entered.value === 0) {
    return unavailable(
      `No leads ever reached ${labelForStage(step.from)}, so there is no rate to measure`,
    );
  }

  return available((step.reached.value / step.entered.value) * 100);
}

/**
 * The drop is the part of the earlier cohort that never reached the later one.
 * If the later cohort is somehow the larger of the two the funnel is not
 * monotone at this step, and a negative drop is not a real figure. Report that
 * rather than clamping it to zero, which is how 5,574 archived leads came to
 * sit under a "0 dropped" label.
 */
function dropOf(step: Step): MetricAvailability<number> {
  if (!step.entered.available || !step.reached.available) {
    const blocked = step.entered.available ? step.reached : step.entered;
    return unavailable(
      blocked.available ? "This step has no cohort figures" : blocked.reason,
    );
  }

  const dropped = step.entered.value - step.reached.value;
  if (dropped < 0) {
    return unavailable(
      `More leads reached ${labelForStage(step.to)} than ever reached ${labelForStage(step.from)}, so the drop cannot be measured`,
    );
  }

  return available(dropped);
}
