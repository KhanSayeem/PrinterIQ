/**
 * Sending volume ramp maths for the operator send-rate control.
 *
 * The ramp itself is not a guess. It is the schedule accepted in
 * `docs/adr/005-sending-volume-ramp.md`: 30, 45, 68, 101, 152, 155 campaign sends
 * per day over roughly six days, at about 50% daily growth.
 */
export const SENDING_VOLUME_RAMP = [30, 45, 68, 101, 152, 155] as const;

/**
 * Upper bound on what the operator can request in one go. This is a typo guard,
 * not a deliverability rule: the estate's whole documented destination is 155 per
 * day, so a four figure request is a slipped keystroke rather than an intent.
 */
export const MAX_REQUESTABLE_DAILY_TOTAL = 1000;

/**
 * The next documented ramp step above the current campaign daily total, or null
 * once the estate has reached the ramp destination.
 */
export function nextRampStep(currentDailyTotal: number): number | null {
  return SENDING_VOLUME_RAMP.find((step) => step > currentDailyTotal) ?? null;
}

/**
 * True when the requested daily volume is more than a doubling of the current
 * volume.
 *
 * Google's guidance for senders increasing volume describes "a common daily
 * increase of 25% to 100%" (https://support.google.com/mail/answer/15256272).
 * 100% growth is a doubling, so anything strictly above 2x the current volume is
 * outside the band Google publishes and has to be confirmed deliberately.
 * Exactly 2x is the top of the band and is allowed without a warning.
 *
 * Growing from zero recorded volume has no percentage to sit inside the band, so
 * it is treated as outside the guidance too.
 */
export function exceedsGoogleRampGuidance(
  currentDailyTotal: number,
  requestedDailyTotal: number,
): boolean {
  if (requestedDailyTotal <= currentDailyTotal) {
    return false;
  }
  if (currentDailyTotal <= 0) {
    return requestedDailyTotal > 0;
  }
  return requestedDailyTotal > currentDailyTotal * 2;
}

/**
 * Split a campaign daily total across mailboxes so the per-mailbox limits sum to
 * exactly the total. The remainder goes to the earliest mailboxes, so the split
 * is deterministic for a given ordering.
 */
export function distributeDailyLimit(dailyTotal: number, mailboxCount: number): number[] {
  if (mailboxCount <= 0) {
    return [];
  }

  const base = Math.floor(dailyTotal / mailboxCount);
  const remainder = dailyTotal - base * mailboxCount;

  return Array.from({ length: mailboxCount }, (_, index) => (index < remainder ? base + 1 : base));
}
