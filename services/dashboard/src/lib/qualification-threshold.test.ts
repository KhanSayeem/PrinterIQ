import { describe, expect, it, vi } from "vitest";
import {
  QUALIFICATION_SCORE_THRESHOLD_ENV,
  readQualificationScoreThreshold,
} from "./qualification-threshold";

describe("readQualificationScoreThreshold", () => {
  it("reads the passing score from the environment", () => {
    vi.stubEnv(QUALIFICATION_SCORE_THRESHOLD_ENV, "35");

    expect(readQualificationScoreThreshold()).toEqual({ available: true, value: 35 });
  });

  it("reads a threshold that is not the production value", () => {
    vi.stubEnv(QUALIFICATION_SCORE_THRESHOLD_ENV, "42");

    expect(readQualificationScoreThreshold()).toEqual({ available: true, value: 42 });
  });

  /**
   * The threshold is the figure the pass rate is entirely made of. Defaulting
   * it would invent that figure, and a default of zero would make every scored
   * lead pass, which is the exact bug this reader exists to prevent.
   */
  it("never invents a threshold when the variable is unset", () => {
    vi.stubEnv(QUALIFICATION_SCORE_THRESHOLD_ENV, undefined);

    const threshold = readQualificationScoreThreshold();

    expect(threshold.available).toBe(false);
    expect(!threshold.available && threshold.reason).toContain(QUALIFICATION_SCORE_THRESHOLD_ENV);
    expect(threshold).not.toHaveProperty("value");
  });

  it("treats a blank variable as unset rather than as zero", () => {
    vi.stubEnv(QUALIFICATION_SCORE_THRESHOLD_ENV, "   ");

    const threshold = readQualificationScoreThreshold();

    expect(threshold.available).toBe(false);
    expect(threshold).not.toHaveProperty("value");
  });

  it("refuses a malformed threshold instead of coercing it", () => {
    for (const value of ["35.5", "thirty five", "-1", "101", "1e2"]) {
      vi.stubEnv(QUALIFICATION_SCORE_THRESHOLD_ENV, value);

      const threshold = readQualificationScoreThreshold();

      expect(threshold.available, `${value} should not be accepted`).toBe(false);
      expect(!threshold.available && threshold.reason).toMatch(/integer from 0 to 100/i);
    }
  });

  it("accepts a threshold of zero when it is configured on purpose", () => {
    vi.stubEnv(QUALIFICATION_SCORE_THRESHOLD_ENV, "0");

    expect(readQualificationScoreThreshold()).toEqual({ available: true, value: 0 });
  });
});
