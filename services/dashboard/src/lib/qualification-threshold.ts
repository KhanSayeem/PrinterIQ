import "server-only";
import type { MetricAvailability } from "./deliverability";

/**
 * The qualification pass mark. `qualifications` holds a row for every lead the
 * qualifier scored, pass or fail, and the decision is not stored as a column:
 * `qualify.py` compares `score` against a `score_threshold` carried in the job
 * payload and archives the lead when it falls short. So the dashboard can only
 * name the passing cohort if it knows the same number, and the number lives in
 * the environment rather than in any constant in the pipeline.
 *
 * The reader never falls back to a value. A default would invent the one figure
 * the pass rate is made of, and a default of zero would make every scored lead
 * pass, which is exactly the reading this stage was corrected for.
 *
 * `src/app/api/import-csv/route.ts` reads the same variable with the same
 * rules, so an import that would be scored against a threshold and a funnel
 * that reports on it agree or both refuse.
 */
export const QUALIFICATION_SCORE_THRESHOLD_ENV = "QUALIFICATION_SCORE_THRESHOLD";

export const QUALIFICATION_THRESHOLD_MISSING_REASON =
  `${QUALIFICATION_SCORE_THRESHOLD_ENV} is not set, so the passing score is unknown and will not be guessed`;

export const QUALIFICATION_THRESHOLD_INVALID_REASON =
  `${QUALIFICATION_SCORE_THRESHOLD_ENV} must be an integer from 0 to 100`;

export function readQualificationScoreThreshold(): MetricAvailability<number> {
  const configured = process.env[QUALIFICATION_SCORE_THRESHOLD_ENV]?.trim();
  if (!configured) {
    return { available: false, reason: QUALIFICATION_THRESHOLD_MISSING_REASON };
  }
  if (!/^(0|[1-9][0-9]*)$/.test(configured)) {
    return { available: false, reason: QUALIFICATION_THRESHOLD_INVALID_REASON };
  }

  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    return { available: false, reason: QUALIFICATION_THRESHOLD_INVALID_REASON };
  }

  return { available: true, value };
}
