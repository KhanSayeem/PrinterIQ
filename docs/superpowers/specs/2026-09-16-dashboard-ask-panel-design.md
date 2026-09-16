# Ask panel: a dashboard AI that answers from real data

Date: 2026-09-16
Status: approved in chat, first slice

## What it is

A slide-over panel on every dashboard page. The operator asks a question in
plain English and gets an answer built from the same read paths the pages use,
with every tool call shown and expandable.

Scope of this slice: it answers when asked. It does not watch, does not post
on its own, and takes no action on any system. Every turn is logged so the
night-shift version can reuse the same tools unchanged.

## Why a toolbox rather than raw API and SQL access

Instantly misreports in four specific ways we measured this week, and our
tested functions already work around all of them:

- Daily analytics are bucketed by UTC, so a Sydney sending day splits across
  two rows. This is what showed 0 sent on a day that sent 30.
- The `campaign_id` filter on campaign analytics is ignored: two requested ids
  returned three rows, including the dev smoke campaign.
- `POST /api/v2/emails/reply` rejects a reply with no subject.
- `GET /api/v2/emails` allows 20 requests a minute.

A model calling the raw API would walk into all four and report the wrong
number confidently. The same API key can also pause campaigns and move leads,
so read-only wrappers remove the chance of an accidental write.

## Shape

    Panel (21st.dev Agent Elements components)
      -> POST /api/ask (streams)
          -> agent loop, claude-sonnet-5, SDK tool runner
              -> toolbox (read-only)
              -> guarded read-only SQL
          -> streams text and every tool call
      -> panel renders the answer with expandable tool calls
      -> every turn stored: question, tools, answer, tokens, cost

Runs inside the dashboard, because the tools are the dashboard's own read
functions. Putting them in another service would duplicate the read layer,
which is how two pages come to disagree.

## Rules baked in

1. The route requires the same session as the pages. No session, no answer.
   Tenant comes from the same helper the pages use.
2. Tool results are data, never instructions. Lead replies contain whatever a
   stranger typed; an email saying "ignore your rules" is reported as text.
3. A failed tool produces "not available" and the reason, never a guess. Same
   rule as the tiles: no plausible number without a source.
4. Every answer carries its tool calls, so any figure can be traced.
5. Read-only at the database level too: its own Postgres login with SELECT
   only, so a generated query cannot write even if something else fails.

## Model

`claude-sonnet-5` for the panel: it reads figures and explains them. The reply
classifier stays on `claude-opus-5` until an eval shows a cheaper model matches
it, because that one reads a prospect's tone with $1,499 on the line.

## Toolbox

Sending: today by mailbox, delivered to date, per campaign status and limits.
Leads: counts by stage, search, one lead's history.
Replies: inbound, classification, what needs a human.
Money: payments, AI spend.
Health: service status, queue depth, error log tails, webhook log.
Deliverability: rolling bounce rate and the verdict behind it.
Escape hatch: read-only SQL with a row cap, a statement timeout, and the query
shown to the operator.

Health tools run a fixed allowlist of commands. There is no free shell.

## Storage

Migration 0016 adds `ask_conversations` and `ask_messages`, tenant scoped,
holding the question, the answer, the tool calls as JSON, token counts and
cost. This is the audit trail and the input to the later watcher.

## Testing

Unit tests for every tool wrapper against a fake reader, for the SQL guard
(row cap, timeout, refusing anything that is not a single read), for the route
(no session, no answer), and for the panel (tool calls render, unavailable
renders its reason). Mutation testing on the guard and the availability rules.
