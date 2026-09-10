/** Whether the inbound reply path can be shown to have worked, and when.
 *
 * The /replies empty state used to tell the operator that Instantly posts
 * every inbound reply here as it arrives, so a zero was the correct number
 * and not a fault. That reassurance was on screen for the months a webhook
 * payload bug was dropping every inbound reply. The bug is fixed, but the copy
 * would still talk an operator out of investigating the most important signal
 * in the business, so nothing here reassures. It reports a fact and leaves the
 * judgement to the reader.
 *
 * Two facts are available, and neither of them is a health check Instantly
 * answers:
 *
 * - `lastInboundAt` is MAX(conversations.created_at) over inbound rows. The
 *   reply agent writes exactly one of those per accepted inbound reply, in
 *   `insertInboundConversation` (services/reply-agent/src/db/queries.ts), so a
 *   timestamp there is proof the whole path worked at that moment: Instantly
 *   posted, the webhook authenticated, the lead resolved and the row landed.
 *   It is the only such proof the dashboard holds.
 * - `firstHandoffAt` is MIN(outreach_sends.sent_at). `sent_at` is the handoff
 *   to Instantly and not a send or a delivery, but it is the earliest instant
 *   a reply could have come back, so it separates "no reply is expected yet"
 *   from "replies were expected and none arrived".
 *
 * A quiet inbox is therefore reported as a gap since a known write, or as an
 * unproven path, and never as a number that is correct.
 */

export type ReplyIngestSignal = {
  readonly lastInboundAt: Date | null;
  readonly firstHandoffAt: Date | null;
};

export type ReplyIngestStatus = "nothing_sent" | "never_received" | "recent" | "stale";

export type ReplyIngestHealth = {
  readonly status: ReplyIngestStatus;
  readonly message: string;
};

/** How long a gap in inbound writes may run before the copy asks for a check.
 *
 * A campaign sending every weekday can go a night without a reply, so a day is
 * the shortest gap that is worth a second look rather than noise.
 */
export const REPLY_INGEST_STALE_HOURS = 24;

/** Shown when the signal itself could not be read, rather than assuming health. */
export const REPLY_INGEST_UNKNOWN_MESSAGE =
  "No replies recorded yet. The inbound reply check could not be read, so nothing here shows whether inbound replies are arriving.";

const CHECK_THE_WEBHOOK =
  "Check the Instantly reply webhook before reading this zero as correct.";

export function describeReplyIngestHealth(
  signal: ReplyIngestSignal,
  now: Date = new Date(),
): ReplyIngestHealth {
  const { lastInboundAt, firstHandoffAt } = signal;

  if (lastInboundAt) {
    const since = `No inbound reply has been recorded since ${formatSydney(lastInboundAt)}, ${formatAgo(lastInboundAt, now)}.`;

    if (hoursBetween(lastInboundAt, now) > REPLY_INGEST_STALE_HOURS) {
      return { status: "stale", message: `${since} ${CHECK_THE_WEBHOOK}` };
    }

    return {
      status: "recent",
      message: `${since} That write is the last proof the inbound path reached this dashboard.`,
    };
  }

  if (firstHandoffAt) {
    return {
      status: "never_received",
      message:
        `No inbound reply has ever been recorded. The first lead was handed to Instantly on ${formatSydney(firstHandoffAt)}, ` +
        `so nothing here shows an inbound reply reaching this dashboard. ${CHECK_THE_WEBHOOK}`,
    };
  }

  return {
    status: "nothing_sent",
    message:
      "No replies recorded yet. No lead has been handed to Instantly yet, so there is nothing to have replied to.",
  };
}

function hoursBetween(from: Date, to: Date) {
  return Math.max(to.getTime() - from.getTime(), 0) / 3_600_000;
}

/** The operator reads this page in Sydney, so the timestamp is stated there. */
function formatSydney(value: Date) {
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Australia/Sydney",
  }).format(value);
}

function formatAgo(from: Date, now: Date) {
  const minutes = Math.floor(Math.max(now.getTime() - from.getTime(), 0) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
