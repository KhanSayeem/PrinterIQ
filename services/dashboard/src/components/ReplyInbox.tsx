import Link from "next/link";
import type { ReplyInboxFilterCounts, ReplyInboxRow } from "@/db/queries";
import type { ReplyInboxFilter } from "@/lib/reply-inbox-params";

/** Labels for the intents `services/reply-agent` writes to conversations.intent.
 *
 * An intent outside this map is shown verbatim rather than hidden, so a new
 * classification added to the reply agent shows up here as itself instead of
 * disappearing from the operator's view.
 */
const intentLabels: Record<string, string> = {
  interested: "Interested",
  question: "Question",
  objection: "Objection",
  not_interested: "Not interested",
  unsubscribe: "Unsubscribe request",
  abusive: "Abusive",
};

const filterTabs: ReadonlyArray<{ key: ReplyInboxFilter; label: string }> = [
  { key: "needs_attention", label: "Needs a human" },
  { key: "all", label: "All" },
  { key: "interested", label: "Interested" },
  { key: "question", label: "Question" },
  { key: "objection", label: "Objection" },
  { key: "not_interested", label: "Not interested" },
  { key: "unsubscribe", label: "Unsubscribe" },
  { key: "abusive", label: "Abusive" },
];

function displayName(reply: ReplyInboxRow) {
  return [reply.firstName, reply.lastName].filter(Boolean).join(" ") || reply.email;
}

function intentLabel(intent: string | null) {
  if (!intent) return "Unclassified";
  return intentLabels[intent] ?? intent;
}

function intentClass(intent: string | null) {
  return `intent-${intent ?? "unclassified"}`;
}

function formatRelativeTime(createdAt: Date, now: Date) {
  const diffMs = Math.max(now.getTime() - createdAt.getTime(), 0);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatSydneyTime(createdAt: Date) {
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Australia/Sydney",
  }).format(createdAt);
}

function replyInboxHref(filter: ReplyInboxFilter, page?: number) {
  return page && page > 1 ? `/replies?filter=${filter}&page=${page}` : `/replies?filter=${filter}`;
}

export function ReplyInbox({
  replies,
  counts,
  filter,
  page,
  totalPages,
  total,
  now = new Date(),
}: {
  replies: ReplyInboxRow[];
  counts: ReplyInboxFilterCounts;
  filter: ReplyInboxFilter;
  page: number;
  totalPages: number;
  total: number;
  now?: Date;
}) {
  return (
    <div className="reply-inbox">
      <div className="filters">
        {filterTabs.map((tab) => (
          <Link
            key={tab.key}
            className={`pill ${tab.key === filter ? "active" : ""}`}
            href={replyInboxHref(tab.key)}
          >
            {tab.label}
            <span className="filter-count">{counts[tab.key]}</span>
          </Link>
        ))}
      </div>
      {replies.length === 0 ? (
        <div className="empty-state">
          {counts.all === 0
            ? "No replies yet. Instantly posts every inbound reply here as it arrives, so zero before the campaign is live is the correct number, not a fault."
            : "No replies match this filter."}
        </div>
      ) : (
        <ul className="reply-list" aria-label="Inbound replies">
          {replies.map((reply) => {
            const name = displayName(reply);

            return (
              <li className="reply-item" key={reply.id}>
                <div className="reply-item-head">
                  <Link
                    className="reply-lead-link"
                    href={`/leads/${reply.leadId}`}
                    aria-label={`Open ${name} in leads`}
                  >
                    {name}
                  </Link>
                  <span className="reply-company">{reply.businessName ?? "Unknown business"}</span>
                  <span className="reply-email">{reply.email}</span>
                  <span className="reply-item-spacer" aria-hidden="true" />
                  <span className={`badge ${intentClass(reply.intent)}`}>{intentLabel(reply.intent)}</span>
                  {reply.escalated ? <span className="badge intent-escalated">Escalated</span> : null}
                  <time
                    className="reply-time"
                    dateTime={reply.createdAt.toISOString()}
                    title={formatSydneyTime(reply.createdAt)}
                  >
                    {formatRelativeTime(reply.createdAt, now)}
                  </time>
                </div>
                <p className="reply-body">{reply.body}</p>
              </li>
            );
          })}
        </ul>
      )}
      <ReplyPagination filter={filter} page={page} totalPages={totalPages} total={total} />
    </div>
  );
}

function ReplyPagination({
  filter,
  page,
  totalPages,
  total,
}: {
  filter: ReplyInboxFilter;
  page: number;
  totalPages: number;
  total: number;
}) {
  if (totalPages <= 1) {
    return <div className="lead-pagination muted">{total.toLocaleString()} matching replies</div>;
  }

  return (
    <nav className="lead-pagination" aria-label="Reply inbox pagination">
      {page > 1 ? (
        <Link className="btn btn-ghost" href={replyInboxHref(filter, page - 1)}>
          Previous
        </Link>
      ) : (
        <span className="btn btn-ghost disabled-link">Previous</span>
      )}
      <span className="lead-pagination-status">
        Page {page.toLocaleString()} of {totalPages.toLocaleString()} · {total.toLocaleString()} replies
      </span>
      {page < totalPages ? (
        <Link className="btn btn-ghost" href={replyInboxHref(filter, page + 1)}>
          Next
        </Link>
      ) : (
        <span className="btn btn-ghost disabled-link">Next</span>
      )}
    </nav>
  );
}
