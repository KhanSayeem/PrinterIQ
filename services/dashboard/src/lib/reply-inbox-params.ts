/** Inbound reply intents Claude can assign, plus the two view-only filters.
 *
 * The intent values must stay in step with the enum in
 * `services/reply-agent/src/claude_agent.ts` and `prompts/reply-agent-v1.txt`.
 * Nothing else is ever written to `conversations.intent`, so a filter outside
 * this list would silently return zero rows.
 */
export const REPLY_INTENTS = [
  "interested",
  "question",
  "objection",
  "not_interested",
  "unsubscribe",
  "abusive",
] as const;

export const REPLY_INBOX_FILTERS = ["all", "needs_attention", ...REPLY_INTENTS] as const;

export type ReplyIntent = (typeof REPLY_INTENTS)[number];
export type ReplyInboxFilter = (typeof REPLY_INBOX_FILTERS)[number];

export type ReplyInboxSearchParams = Record<string, string | undefined>;

export type ReplyInboxFilterParams = {
  filter: ReplyInboxFilter;
  page: number;
};

/** Replies that a human still has to look at.
 *
 * There is no read/unread column on `conversations`, so "unread" cannot be
 * answered from the database. This is the honest substitute: not classified
 * yet, classified as interested, or escalated by the reply agent.
 */
export const DEFAULT_REPLY_INBOX_FILTER: ReplyInboxFilter = "needs_attention";

function asFilter(value: string | undefined): ReplyInboxFilter {
  return REPLY_INBOX_FILTERS.includes(value as ReplyInboxFilter)
    ? (value as ReplyInboxFilter)
    : DEFAULT_REPLY_INBOX_FILTER;
}

function asPage(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(Math.floor(parsed), 1);
}

export function parseReplyInboxParams(params: ReplyInboxSearchParams): ReplyInboxFilterParams {
  return {
    filter: asFilter(params.filter),
    page: asPage(params.page),
  };
}
