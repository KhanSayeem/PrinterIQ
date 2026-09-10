import { describe, expect, it, vi } from "vitest";
import { estimateCostUsd, MODEL_RATES_USD_PER_MTOK } from "../src/model_pricing.js";

describe("estimateCostUsd", () => {
  it("prices Opus 5 at its own published rate, not a hardcoded one", () => {
    // 1M in, 1M out at $5 / $25.
    expect(estimateCostUsd("claude-opus-5", 1_000_000, 1_000_000)).toBe(30);
  });

  it("prices Sonnet 5 differently from Opus 5 for identical usage", () => {
    const opus = estimateCostUsd("claude-opus-5", 1_000_000, 1_000_000);
    const sonnet = estimateCostUsd("claude-sonnet-5", 1_000_000, 1_000_000);

    // $2 / $10 against $5 / $25. The old code returned the same number for
    // every model, so this is the assertion that a single hardcoded pair
    // cannot satisfy.
    expect(sonnet).toBe(12);
    expect(sonnet).not.toBe(opus);
  });

  it("prices Haiku 4.5 at its own rate", () => {
    expect(estimateCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000)).toBe(6);
  });

  it("scales linearly with token counts", () => {
    expect(estimateCostUsd("claude-opus-5", 500_000, 200_000)).toBeCloseTo(2.5 + 5, 6);
  });

  it("rounds to six decimal places, so a tiny call is not lost to zero", () => {
    const cost = estimateCostUsd("claude-opus-5", 100, 50);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBe(Number(cost.toFixed(6)));
  });

  /** An unknown model must never quietly price as free.
   *
   * `conversations.cost_usd` is NOT NULL, so there is no null to fall back
   * to and the function has to return a number. Returning 0, or silently
   * keeping an old rate, would under-report spend on the AI spend card and
   * the operator would have no reason to look. Charging the most expensive
   * known rate errs towards investigation instead.
   */
  it("charges the most expensive known rate for an unrecognised model", () => {
    const dearest = Math.max(...Object.values(MODEL_RATES_USD_PER_MTOK).map((r) => r.output));
    const cost = estimateCostUsd("some-model-released-after-this-code", 0, 1_000_000);

    expect(cost).toBe(dearest);
    expect(cost).toBeGreaterThan(estimateCostUsd("claude-opus-5", 0, 1_000_000));
  });

  it("warns loudly, naming the unrecognised model, so the table can be updated", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    estimateCostUsd("some-model-released-after-this-code", 10, 10);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("some-model-released-after-this-code");
    warn.mockRestore();
  });

  it("does not warn for a model it knows", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    estimateCostUsd("claude-opus-5", 10, 10);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("treats a model id it knows as case sensitive rather than guessing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Model ids are exact strings. Accepting near-misses would hide a typo in
    // CLAUDE_REPLY_MODEL, which is the setting that actually picks the model.
    estimateCostUsd("Claude-Opus-5", 10, 10);

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
