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
 * - scored: leads with a qualification row, pass or fail
 * - qualified: leads whose score met the qualification threshold
 * - contacted: leads with an outreach send
 * - replied: leads with an inbound conversation
 * - paid: leads with a paid payment
 *
 * Scoring and qualifying are two stages because they are two populations. A
 * lead gets a `qualifications` row whether it passed or failed, and the
 * decision is not a column: `qualify.py` compares `score` against the
 * `score_threshold` in the job payload and archives the lead when it falls
 * short. Reading `qualifications` as the qualified cohort therefore counted the
 * archived leads as qualified, which on the live tenant rendered 7,543 at
 * 100.0% of enriched and hid the largest filter in the business: 3,252 of
 * those leads scored below the threshold and 56.9% passed.
 *
 * Every figure is an availability wrapper rather than a bare number, matching
 * `src/lib/deliverability.ts`. A figure this system cannot measure renders as
 * words and never as zero, because a silent zero here reads as a measured
 * result.
 */

export const PIPELINE_STAGES = [
  "imported",
  "enriched",
  "scored",
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
  "scored",
  "qualified",
  "contacted",
  "replied",
  "paid",
] as const;

export type FunnelStageKey = (typeof FUNNEL_STAGES)[number];

export type PipelineMilestoneCounts = {
  readonly imported: number;
  readonly enriched: number;
  /** Leads the qualifier scored, whether they passed or failed. */
  readonly scored: number;
  /** Leads whose score met the threshold. Null when the threshold is unknown. */
  readonly qualified: number | null;
  /** Every lead ever contacted, whatever it scored. */
  readonly contacted: number;
  /**
   * Contacted leads that also met the threshold. This is the numerator of the
   * qualified to contacted step: without it the step would divide the whole
   * contacted cohort by the passing cohort, which are two different
   * populations. Null when the threshold is unknown.
   */
  readonly contactedQualified: number | null;
  readonly replied: number;
  readonly paid: number;
};

export type PipelineStage = {
  readonly status: PipelineStageKey;
  readonly label: string;
  /** The headline figure for the stage card. */
  readonly count: MetricAvailability<number>;
  /** What `count` measures, so the card can say so rather than imply a cohort. */
  readonly basis: "cohort" | "current-status";
  /** The rule that defines the cohort, printed on the card. Null when the stage needs none. */
  readonly criterion: string | null;
  /**
   * Leads whose current status is this stage, or null where no such lead status
   * exists and the figure would be a made up zero.
   */
  readonly currentCount: number | null;
  /** True when `href` filters on current status, so the card must name that count. */
  readonly linksToCurrentStatus: boolean;
  /** The leads view that reproduces this card's own figure. */
  readonly href: string;
  /** A second true figure the card must name so the two do not look like a contradiction. */
  readonly cohortNote: string | null;
  /** Share of the imported cohort that ever reached this stage, 0 to 100. */
  readonly shareOfImported: MetricAvailability<number>;
};

export type PipelineConversion = {
  readonly from: FunnelStageKey;
  readonly to: FunnelStageKey;
  /** Percentage of the `from` cohort that went on to reach `to`, 0 to 100. */
  readonly rate: MetricAvailability<number>;
  /** Leads from the `from` cohort that reached `to`. */
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
  /**
   * The passing score, read from `QUALIFICATION_SCORE_THRESHOLD`. Unavailable
   * when it is not configured, and then the qualified stage is unavailable too.
   * This function never supplies a threshold of its own.
   */
  readonly qualificationThreshold: MetricAvailability<number>;
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
 * dashboard has already been burned by. The mirror case is just as misleading:
 * 7,543 of 7,546 enriched leads were scored, and printing that as "100.0%"
 * above a "3 dropped" label contradicts itself.
 */
export function formatPipelineRate(rate: number) {
  if (rate > 0 && rate < 0.1) {
    return "under 0.1%";
  }

  const rounded = rate.toFixed(1);
  if (rounded === "100.0" && rate !== 100) {
    return rate < 100 ? "just under 100%" : "just over 100%";
  }

  return `${rounded}%`;
}

/**
 * The rule printed beside the qualified stage, so the cohort figure explains
 * itself instead of leaving an operator to guess what "qualified" means. The
 * number comes from the environment, so the label is generated rather than
 * written down.
 */
export function formatQualificationCriterion(threshold: number) {
  return `score ${threshold} or above`;
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

/** Every lead the qualifier looked at, so the card is not read as a pass rate. */
export const SCORED_STAGE_CRITERION = "every lead scored, pass or fail";

/**
 * The passing score is known but the cohort behind it was not counted. This
 * should not happen, and reporting it beats reporting a number that was never
 * measured.
 */
export const QUALIFIED_COHORT_UNCOUNTED_REASON =
  "The passing score is configured but the qualified cohort was not counted";

function isFunnelStage(stage: PipelineStageKey): stage is FunnelStageKey {
  return (FUNNEL_STAGES as readonly PipelineStageKey[]).includes(stage);
}

/**
 * Resolves a cohort that only exists once the passing score is known. Nothing
 * here defaults the threshold, so an unset variable propagates as words rather
 * than as a count that silently passes every scored lead.
 */
function resolveThresholdCohort(
  count: number | null,
  threshold: MetricAvailability<number>,
): MetricAvailability<number> {
  if (!threshold.available) {
    return unavailable(threshold.reason);
  }
  if (count === null) {
    return unavailable(QUALIFIED_COHORT_UNCOUNTED_REASON);
  }

  return available(count);
}

function resolveMilestone(
  stage: FunnelStageKey,
  input: BuildPipelineFunnelInput,
): MetricAvailability<number> {
  const counts = input.milestones;

  if (stage === "qualified") {
    return resolveThresholdCohort(counts.qualified, input.qualificationThreshold);
  }
  if (stage === "replied" && counts.replied === 0) {
    return unavailable(REPLIED_COHORT_UNAVAILABLE_REASON);
  }

  return available(counts[stage]);
}

function criterionFor(
  stage: PipelineStageKey,
  threshold: MetricAvailability<number>,
): string | null {
  if (stage === "scored") {
    return SCORED_STAGE_CRITERION;
  }
  if (stage === "qualified") {
    return threshold.available ? formatQualificationCriterion(threshold.value) : null;
  }

  return null;
}

/**
 * `scored` has no lead status at all, and the qualified status bucket holds
 * only the residue that has not advanced, 2 leads against a cohort of 4,291.
 * Neither card can honestly link to a status filter, so both link to the score
 * filter that reproduces the cohort the card prints.
 */
function linkFor(stage: PipelineStageKey, threshold: MetricAvailability<number>) {
  if (stage === "scored") {
    return { href: "/leads?score_min=0", linksToCurrentStatus: false };
  }
  if (stage === "qualified") {
    return {
      href: threshold.available ? `/leads?score_min=${threshold.value}` : "/leads",
      linksToCurrentStatus: false,
    };
  }

  return { href: `/leads?status=${stage}`, linksToCurrentStatus: true };
}

/**
 * 1,960 leads were contacted but only 1,955 of them met the current threshold,
 * because 5 were contacted when the threshold was lower. Both figures are true
 * and both are on the page, the card's own count and the numerator of the
 * qualified step, so the card names the difference rather than leaving the two
 * looking like a contradiction.
 */
function contactedCohortNote(input: BuildPipelineFunnelInput): string | null {
  const { contacted, contactedQualified } = input.milestones;
  const threshold = input.qualificationThreshold;

  if (!threshold.available || contactedQualified === null) {
    return null;
  }

  const belowThreshold = contacted - contactedQualified;
  if (belowThreshold <= 0) {
    return null;
  }

  return `${belowThreshold.toLocaleString()} contacted leads score below ${threshold.value}`;
}

export function buildPipelineFunnel(input: BuildPipelineFunnelInput): PipelineAnalytics {
  const threshold = input.qualificationThreshold;
  const cohorts = new Map<FunnelStageKey, MetricAvailability<number>>(
    FUNNEL_STAGES.map((stage) => [stage, resolveMilestone(stage, input)]),
  );

  /**
   * The step into a stage normally counts that stage's whole cohort. Contacted
   * is the exception: its cohort includes leads that never met the threshold,
   * so dividing it by the passing cohort would mix two populations.
   */
  const contactedQualified = resolveThresholdCohort(
    input.milestones.contactedQualified,
    threshold,
  );

  const conversions = FUNNEL_STAGES.slice(1).map((to, index) => {
    const from = FUNNEL_STAGES[index]!;
    const entered = cohorts.get(from)!;
    const reached = to === "contacted" ? contactedQualified : cohorts.get(to)!;

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
    const link = linkFor(status, threshold);
    const currentCount = link.linksToCurrentStatus
      ? (input.currentCounts[status] ?? 0)
      : null;

    if (!isFunnelStage(status)) {
      return {
        status,
        label: labelForStage(status),
        count: available(currentCount ?? 0),
        basis: "current-status",
        criterion: null,
        currentCount,
        linksToCurrentStatus: link.linksToCurrentStatus,
        href: link.href,
        cohortNote: null,
        shareOfImported: unavailable(ARCHIVED_SHARE_UNAVAILABLE_REASON),
      };
    }

    const cohort = cohorts.get(status)!;

    return {
      status,
      label: labelForStage(status),
      count: cohort,
      basis: "cohort",
      criterion: criterionFor(status, threshold),
      currentCount,
      linksToCurrentStatus: link.linksToCurrentStatus,
      href: link.href,
      cohortNote: status === "contacted" ? contactedCohortNote(input) : null,
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
 * not 0.0% and not a clamped bar. A rate above 100% is reported as it is, and
 * the chart caps the bar without letting it read as a complete one.
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
