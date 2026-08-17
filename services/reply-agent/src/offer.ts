/** The single source of truth for what the website offer costs.
 *
 * The price previously lived in four places that drifted: a hardcoded
 * CHECKOUT_AMOUNT_CENTS here, prompts/opener-v2.txt, prompts/reply-agent-v1.txt
 * and the Instantly templates. The Instantly copy was corrected to $1,499 and
 * nothing else was, so checkout would have charged $1,500 against a $1,499
 * quote. Reading it from one env var keeps checkout and both prompts in step.
 *
 * The Instantly templates still have to be edited by hand, since they live in
 * a third-party UI. That is a runbook step, not something this can enforce.
 */

const DEFAULT_OFFER_PRICE_AUD = 1499;

export function offerPriceAud(): number {
  const configured = process.env.OFFER_PRICE_AUD?.trim();
  if (!configured) {
    return DEFAULT_OFFER_PRICE_AUD;
  }

  // Deliberately strict. Falling back to the default on a malformed value
  // would charge one price while the emails quote another, which is the exact
  // failure this module exists to prevent.
  if (!/^[1-9][0-9]*$/.test(configured)) {
    throw new Error(`OFFER_PRICE_AUD must be a positive whole number of dollars, got: ${configured}`);
  }

  return Number(configured);
}

export function offerPriceCents(): number {
  return offerPriceAud() * 100;
}

/** The price as it should appear in customer-facing copy, e.g. "1,499". */
export function offerPriceDisplay(): string {
  return offerPriceAud().toLocaleString("en-AU");
}
