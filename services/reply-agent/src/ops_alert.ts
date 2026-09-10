import {
  operatorEscalationPhone,
  TwilioBalanceClient,
  TwilioSmsClient,
  type BalanceClient,
  type SmsClient,
} from "./escalation.js";

/** Longest SMS body we will send for an operational alert.
 *
 * Two 160 character segments. The stall summary the pipeline monitor produces
 * is around 140 characters, so this is headroom rather than a constraint, and
 * it stops a malformed caller from sending a novel one segment at a time.
 */
const MAX_ALERT_BODY_LENGTH = 320;

/** Remaining Twilio credit, in USD, below which every ops alert says so.
 *
 * The account is on a trial plan and had 10.90 USD on it on 2026-09-10. An
 * outbound SMS to an Australian mobile runs around 0.05 USD a segment and an
 * ops alert is up to two segments, so 2.00 USD is roughly twenty more alerts.
 *
 * That is the point of the number: it has to leave enough runway that the
 * warning arrives while there is still credit to send it with, and enough
 * that the warning is not itself the last message out. Warning at 0.20 USD
 * would be technically true and operationally useless.
 */
const DEFAULT_LOW_BALANCE_WARN_USD = 2.0;

/** Room reserved at the end of an alert for the balance warning.
 *
 * The 320 character cap truncates from the tail, and the tail of a bounce
 * alert is the approved action. Reserving the suffix budget rather than
 * appending and hoping means the warning never buys itself space by cutting
 * the instruction the operator is meant to act on.
 */
const BALANCE_SUFFIX_BUDGET = 64;

export type OpsAlertConfig = {
  secret: string;
  sms: SmsClient;
  /** Optional on purpose: a missing balance reader costs the suffix, not the alert. */
  balance?: BalanceClient;
};

export type OpsAlertInput = {
  subject: string;
  body: string;
};

/** Send one operational alert to the operator's phone.
 *
 * This service owns the only SMS credentials in the system, so anything that
 * needs to page a human comes through here. `escalate()` pages for a reply
 * that needs attention; this pages for infrastructure that has stopped.
 * Same number, same client, one place to change providers.
 */
export async function sendOpsAlert(
  input: OpsAlertInput,
  sms: SmsClient,
  balance?: BalanceClient,
): Promise<void> {
  const subject = input.subject.trim();
  const alert = subject ? `${subject}: ${input.body}` : input.body;
  const suffix = await lowBalanceSuffix(balance);
  const body = suffix
    ? `${alert.slice(0, MAX_ALERT_BODY_LENGTH - suffix.length)}${suffix}`
    : alert.slice(0, MAX_ALERT_BODY_LENGTH);

  await sms.sendSms({
    to: operatorEscalationPhone(),
    body,
  });
}

/** The tail of an ops alert, when the Twilio credit is running out.
 *
 * This lives on the ops alert path rather than in the pipeline for two
 * reasons. Twilio credentials belong to this service and only this service:
 * CLAUDE.md forbids the Python workers from touching an SMS provider, and
 * putting a balance read in `alerting.py` would spread Twilio auth into a
 * second codebase to save nothing. And `sendOpsAlert` is the single choke
 * point every ops alert already passes through, so the stall monitor and the
 * bounce monitor both inherit the warning without either one knowing that
 * Twilio exists.
 *
 * It rides along on a message already being sent rather than going out as its
 * own SMS, because a separate text would spend the credit it is warning
 * about, and would need its own throttle to avoid spending it hourly.
 *
 * Any failure returns undefined. The alarm is the product and the balance is a
 * courtesy attached to it, so an unreadable balance costs the suffix and
 * never the alert.
 */
async function lowBalanceSuffix(balance?: BalanceClient): Promise<string | undefined> {
  if (!balance) {
    return undefined;
  }

  const threshold = Number(process.env.TWILIO_BALANCE_WARN_USD ?? DEFAULT_LOW_BALANCE_WARN_USD);

  let remaining: number | null;
  try {
    remaining = await balance.readBalanceUsd();
  } catch (error) {
    // Logged, not swallowed. A green log has already meant "never ran" on
    // this project, and a balance check that fails on every alert would be
    // indistinguishable from an account with plenty of credit.
    console.warn(
      `ops alert balance check failed: error=${error instanceof Error ? error.name : "UnknownError"}`,
    );
    return undefined;
  }

  if (remaining === null || !Number.isFinite(threshold) || remaining >= threshold) {
    return undefined;
  }

  const formatted = remaining.toFixed(2);
  // Also in the log, because an SMS is the one channel that cannot report its
  // own failure: at 0.00 USD nothing goes out at all and this line is the
  // only place the silence is explained.
  console.warn(`ops alert twilio balance low: remaining_usd=${formatted}`);

  const suffix = ` Twilio credit USD ${formatted}, top up or alerts stop.`;
  return suffix.length <= BALANCE_SUFFIX_BUDGET ? suffix : suffix.slice(0, BALANCE_SUFFIX_BUDGET);
}

/** Build the ops alert configuration, or explain why there is none.
 *
 * Missing configuration disables the route rather than failing startup, for
 * the same reason preview view tracking does: reply handling and Stripe are
 * revenue-critical and must keep running. The warning is loud because a
 * disabled route means the pipeline stall monitor will get a 404 and its
 * alerts will go nowhere.
 */
export function buildOpsAlertConfig(
  env: NodeJS.ProcessEnv = process.env,
  sms: SmsClient = new TwilioSmsClient(),
  balance: BalanceClient = new TwilioBalanceClient(),
): OpsAlertConfig | undefined {
  const secret = env.OPS_ALERT_SECRET;

  if (!secret) {
    console.warn("ops alerting disabled: missing OPS_ALERT_SECRET");
    return undefined;
  }

  return { secret, sms, balance };
}
