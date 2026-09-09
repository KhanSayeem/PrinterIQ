import { operatorEscalationPhone, TwilioSmsClient, type SmsClient } from "./escalation.js";

/** Longest SMS body we will send for an operational alert.
 *
 * Two 160 character segments. The stall summary the pipeline monitor produces
 * is around 140 characters, so this is headroom rather than a constraint, and
 * it stops a malformed caller from sending a novel one segment at a time.
 */
const MAX_ALERT_BODY_LENGTH = 320;

export type OpsAlertConfig = {
  secret: string;
  sms: SmsClient;
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
export async function sendOpsAlert(input: OpsAlertInput, sms: SmsClient): Promise<void> {
  const subject = input.subject.trim();
  const body = subject ? `${subject}: ${input.body}` : input.body;

  await sms.sendSms({
    to: operatorEscalationPhone(),
    body: body.slice(0, MAX_ALERT_BODY_LENGTH),
  });
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
): OpsAlertConfig | undefined {
  const secret = env.OPS_ALERT_SECRET;

  if (!secret) {
    console.warn("ops alerting disabled: missing OPS_ALERT_SECRET");
    return undefined;
  }

  return { secret, sms };
}
