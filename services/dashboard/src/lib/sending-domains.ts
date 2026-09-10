/** One name for the PrinterIQ sending estate, read the same way everywhere.
 *
 * The Instantly workspace also holds mailboxes on other projects' domains, so
 * every page that reports capacity has to be told which domains are ours.
 * Two env vars grew up doing that job: /deliverability filtered on
 * DELIVERABILITY_SENDING_DOMAINS and /sending filtered on
 * INSTANTLY_SENDING_DOMAINS. Both are set in production and both currently
 * name the same domains, but nothing enforced that, and if they ever drifted
 * the two pages would report different estate sizes and different totals with
 * nothing on screen to say why.
 *
 * INSTANTLY_SENDING_DOMAINS is the canonical name: it is the one
 * docs/operator-runbook.md tells the operator to set, and it names the
 * Instantly workspace it actually scopes rather than one page that reads it.
 * DELIVERABILITY_SENDING_DOMAINS stays as a documented fallback so a
 * production host that only has that one keeps working, and so this change
 * cannot silently unscope the estate. Setting only the fallback is supported;
 * setting both to different values is not, and the canonical one wins.
 */

export const SENDING_DOMAINS_ENV_VAR = "INSTANTLY_SENDING_DOMAINS";
export const SENDING_DOMAINS_FALLBACK_ENV_VAR = "DELIVERABILITY_SENDING_DOMAINS";

/** Said whenever neither variable is set, so both names appear together. */
export const MISSING_SENDING_DOMAINS_MESSAGE =
  `${SENDING_DOMAINS_ENV_VAR} is not set, so the PrinterIQ mailboxes cannot be told apart from other ` +
  `projects' mailboxes in the same Instantly workspace. Set it in services/dashboard/.env.production ` +
  `(${SENDING_DOMAINS_FALLBACK_ENV_VAR} is still read as a fallback).`;

export function parseSendingDomains(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain !== "");
}

/** The allowlist for this deployment, canonical variable first. */
export function resolveSendingDomains(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const canonical = parseSendingDomains(env[SENDING_DOMAINS_ENV_VAR]);
  return canonical.length ? canonical : parseSendingDomains(env[SENDING_DOMAINS_FALLBACK_ENV_VAR]);
}
