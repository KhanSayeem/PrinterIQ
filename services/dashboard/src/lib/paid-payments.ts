/**
 * What the dashboard treats as a sale, in one place.
 *
 * A sale is a `payments` row, never a `leads.status`. `leads.status` is a
 * single mutually exclusive current state written by one CTE in the reply
 * agent, gated on the lead already being `replied`, and any later write moves
 * the lead out of it. A payments row is the record of the money and is never
 * removed, so it is the only figure that can be shown on more than one screen
 * without the screens disagreeing.
 *
 * `payments.status` is `'completed'` and not `'paid'`. That is not a preference,
 * it is what the only writer writes: `recordCompletedPayment` in
 * `services/reply-agent/src/db/queries.ts` inserts `'completed'` and updates to
 * `'completed'` on conflict, the partial index
 * `idx_payments_tenant_paid` in `database/migrations/0002_add_indexes.sql` is
 * declared `WHERE status = 'completed'`, and `docs/queue-payloads.md` documents
 * `status = 'completed'` as the paid state. The column has no CHECK constraint,
 * so nothing in the database rejects the wrong literal: a reader that asks for
 * `'paid'` simply matches no row, on every sale, for ever, and reports zero.
 *
 * The literal lives here so the pill, the pill's filter and the pipeline funnel
 * cannot drift apart, and so that correcting a reader is a one line change
 * rather than a search.
 */
export const PAID_PAYMENT_STATUS = "completed";

/**
 * The `status` value in `/leads?status=paid`, which is also the pill's key and
 * the target of the Total revenue card's link on `/revenue`. It stays "paid"
 * because it is a URL an operator can already have bookmarked; only what it
 * resolves to has changed, from `leads.status` to a payments row.
 */
export const PAID_LEAD_FILTER = "paid";
