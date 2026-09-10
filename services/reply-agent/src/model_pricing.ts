/** Per-model token prices, in US dollars per million tokens.
 *
 * These feed `conversations.cost_usd`, which the AI spend card on /revenue
 * sums and shows to the operator as real money.
 *
 * Why this file exists: `claude_agent.ts` used to compute cost as a flat
 * `(tokens / 1e6) * 3` for input and `* 15` for output, with the multipliers
 * written inline. Those were the rates for the model that was hardcoded as
 * the default at the time. The model is chosen by `CLAUDE_REPLY_MODEL`, so
 * the moment that variable named anything else the spend figure was simply
 * wrong, and nothing about it looked wrong: a plausible dollar amount is the
 * hardest kind of error to notice.
 *
 * Keep this table in step with Anthropic's published pricing. Add a row when
 * a model is adopted rather than relying on the fallback below.
 */
export const MODEL_RATES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-fable-5-1": { input: 10, output: 50 },
};

/** The rate charged when the model is not in the table above.
 *
 * `conversations.cost_usd` is NOT NULL, so there is no null to record and
 * this has to return a number. The two wrong answers available are "cheaper
 * than reality" and "dearer than reality", and they are not symmetric: an
 * under-report makes spend look fine and gives the operator no reason to
 * look, while an over-report shows up as a figure worth questioning. So an
 * unrecognised model is charged the dearest rate we know of, and says so.
 */
function dearestKnownRate(): { input: number; output: number } {
  const rates = Object.values(MODEL_RATES_USD_PER_MTOK);

  return {
    input: Math.max(...rates.map((rate) => rate.input)),
    output: Math.max(...rates.map((rate) => rate.output)),
  };
}

/** Estimate what one Claude call cost, from its model and token counts.
 *
 * Model ids are matched exactly. Near-miss matching would paper over a typo
 * in `CLAUDE_REPLY_MODEL`, and that variable is what actually selects the
 * model, so a typo there is worth surfacing rather than absorbing.
 */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const known = Object.prototype.hasOwnProperty.call(MODEL_RATES_USD_PER_MTOK, model)
    ? MODEL_RATES_USD_PER_MTOK[model]
    : undefined;

  const rate = known ?? dearestKnownRate();

  if (!known) {
    console.warn(
      `model pricing unknown: model=${model} charged_at=${rate.input}/${rate.output} per MTok. ` +
        "Add it to MODEL_RATES_USD_PER_MTOK; spend is over-reported until then.",
    );
  }

  const inputCost = (inputTokens / 1_000_000) * rate.input;
  const outputCost = (outputTokens / 1_000_000) * rate.output;

  return Number((inputCost + outputCost).toFixed(6));
}
