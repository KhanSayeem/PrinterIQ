import type pg from "pg";
import { getPool } from "./client.js";
import type {
  CheckoutLead,
  CompletedPaymentInput,
  CompletedPaymentResult,
  ConversationClassificationUpdate,
  ConversationHistoryItem,
  EscalationContext,
  LeadContext,
  OutreachTarget,
  PreviewViewState,
} from "../types.js";

type Queryable = Pick<pg.Pool, "query">;
type InstantlyReplyMetadata = {
  instantly_lead_id?: string | null;
  instantly_email_id?: string | null;
  instantly_account_id?: string | null;
  /** Makes one inbound reply one row across BullMQ retries. See migration 0015. */
  dedupe_key?: string | null;
};

function db(client?: Queryable): Queryable {
  return client ?? getPool();
}

export async function insertInboundConversation(
  tenantId: string,
  leadId: string,
  channel: string,
  body: string,
  metadata: InstantlyReplyMetadata = {},
  client?: Queryable,
): Promise<{ id: string }> {
  const result = await db(client).query<{ id: string }>(
    `
      INSERT INTO conversations (
        tenant_id,
        lead_id,
        direction,
        channel,
        body,
        instantly_email_id,
        instantly_account_id,
        dedupe_key
      )
      SELECT
        tenant_id,
        id,
        'inbound',
        $3,
        $4,
        $5,
        $6,
        $8
      FROM leads
      WHERE tenant_id = $1
        AND id = $2
        AND EXISTS (
          SELECT 1
          FROM outreach_sends
          WHERE outreach_sends.tenant_id = leads.tenant_id
            AND outreach_sends.lead_id = leads.id
            AND outreach_sends.instantly_lead_id = $7
        )
      -- One reply, one row. A BullMQ retry runs this insert again with the same
      -- key, and Postgres refuses the copy rather than recording it.
      ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      RETURNING id
    `,
    [
      tenantId,
      leadId,
      channel,
      body,
      metadata.instantly_email_id ?? null,
      metadata.instantly_account_id ?? null,
      metadata.instantly_lead_id ?? null,
      metadata.dedupe_key ?? null,
    ],
  );

  const row = result.rows[0];
  if (row) {
    return row;
  }

  // No row means one of two things, and they must not be conflated: the key was
  // already used, which is a retry of the same reply, or the lead does not
  // belong to this tenant. Only the second is an error.
  const dedupeKey = metadata.dedupe_key ?? null;
  if (dedupeKey) {
    const existing = await db(client).query<{ id: string }>(
      `
        SELECT id
        FROM conversations
        WHERE tenant_id = $1
          AND dedupe_key = $2
      `,
      [tenantId, dedupeKey],
    );

    const alreadyRecorded = existing.rows[0];
    if (alreadyRecorded) {
      return alreadyRecorded;
    }
  }

  throw new Error("lead not found for tenant");
}

export async function fetchLeadContext(
  tenantId: string,
  leadId: string,
  client?: Queryable,
): Promise<LeadContext> {
  const result = await db(client).query<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string;
    phone: string | null;
    business_name: string | null;
    website_url: string | null;
    city: string | null;
    state: string | null;
    top_weakness: string | null;
    claude_voice_prompt: string | null;
  }>(
    `
      SELECT
        leads.id,
        leads.first_name,
        leads.last_name,
        leads.email,
        leads.phone,
        leads.business_name,
        leads.website_url,
        leads.city,
        leads.state,
        qualifications.top_weakness,
        tenants.claude_voice_prompt
      FROM leads
      JOIN tenants
        ON tenants.tenant_id = leads.tenant_id
      LEFT JOIN qualifications
        ON qualifications.tenant_id = leads.tenant_id
       AND qualifications.lead_id = leads.id
      WHERE leads.tenant_id = $1
        AND leads.id = $2
      LIMIT 1
    `,
    [tenantId, leadId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("lead not found for tenant");
  }

  const { top_weakness: topWeakness, claude_voice_prompt: voicePrompt, ...lead } = row;

  return {
    lead,
    top_weakness: topWeakness,
    tenant_voice_prompt: voicePrompt,
  };
}

export async function fetchConversationHistory(
  tenantId: string,
  leadId: string,
  client?: Queryable,
): Promise<ConversationHistoryItem[]> {
  const result = await db(client).query<ConversationHistoryItem>(
    `
      SELECT
        direction,
        channel,
        body,
        intent,
        agent_action,
        created_at::text
      FROM conversations
      WHERE tenant_id = $1
        AND lead_id = $2
      ORDER BY created_at ASC
    `,
    [tenantId, leadId],
  );

  return result.rows;
}

export async function countInboundReplies(
  tenantId: string,
  leadId: string,
  client?: Queryable,
): Promise<number> {
  const result = await db(client).query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM conversations
      WHERE tenant_id = $1
        AND lead_id = $2
        AND direction = 'inbound'
    `,
    [tenantId, leadId],
  );

  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
}

export async function hasCheckoutAction(
  tenantId: string,
  leadId: string,
  client?: Queryable,
): Promise<boolean> {
  const result = await db(client).query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM conversations
        WHERE tenant_id = $1
          AND lead_id = $2
          AND agent_action = 'send_checkout'
      ) AS exists
    `,
    [tenantId, leadId],
  );

  return result.rows[0]?.exists ?? false;
}

export async function updateConversationClassification(
  tenantId: string,
  conversationId: string,
  update: ConversationClassificationUpdate,
  client?: Queryable,
): Promise<void> {
  await db(client).query(
    `
      UPDATE conversations
      SET
        intent = $3,
        intent_confidence = $4,
        agent_action = $5,
        prompt_version = $6,
        model_used = $7,
        cost_usd = $8,
        escalated = $9,
        escalation_reason = $10
      WHERE tenant_id = $1
        AND id = $2
    `,
    [
      tenantId,
      conversationId,
      update.intent,
      update.intent_confidence,
      update.agent_action,
      update.prompt_version,
      update.model_used,
      update.cost_usd,
      update.escalated,
      update.escalation_reason,
    ],
  );
}

/** Mark a conversation escalated without touching the classifier's own verdict.
 *
 * `updateConversationClassification` rewrites `agent_action`, which is the
 * audit record of what Claude decided and the input to `hasCheckoutAction`.
 * When the worker overrides a delivery decision it must not rewrite that
 * verdict, so this sets only the escalation fields. `escalation_reason` is
 * COALESCEd for the same reason: an earlier, more specific reason such as
 * `low_confidence` is the truthful record and must not be overwritten, and it
 * keeps the write idempotent across retries.
 *
 * The inbound body is returned in the same round trip because the escalation
 * SMS quotes the lead's own words, and a `send_reply` job carries only the
 * drafted outbound copy. `direction = 'inbound'` enforces that: an outbound
 * conversation id would otherwise quote our own copy back at the operator.
 */
export async function markConversationEscalated(
  tenantId: string,
  conversationId: string,
  reason: string,
  client?: Queryable,
): Promise<{ body: string }> {
  const result = await db(client).query<{ body: string }>(
    `
      UPDATE conversations
      SET
        escalated = TRUE,
        escalation_reason = COALESCE(escalation_reason, $3)
      WHERE tenant_id = $1
        AND id = $2
        AND direction = 'inbound'
      RETURNING body
    `,
    [tenantId, conversationId, reason],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("conversation not found for tenant");
  }

  return row;
}

/** Return the checkout session already minted for this lead, if any.
 *
 * Scoped to the lead rather than a single conversation so that a second
 * conversation cannot mint a second Stripe session for the same lead.
 *
 * The `leads.status = 'replied'` join is not redundant. It is the same
 * eligibility gate `fetchCheckoutLead` applies, and without it a cached
 * session would be handed back for a lead the suppression flow has since
 * archived, or one that has already paid, since the cache hit returns before
 * `fetchCheckoutLead` is ever reached. Reusing a link must not be a way around
 * "unsubscribe means no further message".
 */
export async function fetchCheckoutSession(
  tenantId: string,
  leadId: string,
  client?: Queryable,
): Promise<{ id: string; url: string } | null> {
  const result = await db(client).query<{ id: string; url: string }>(
    `
      SELECT
        conversations.stripe_session_id AS id,
        conversations.stripe_session_url AS url
      FROM conversations
      JOIN leads
        ON leads.tenant_id = conversations.tenant_id
       AND leads.id = conversations.lead_id
      WHERE conversations.tenant_id = $1
        AND conversations.lead_id = $2
        AND leads.status = 'replied'
        AND conversations.stripe_session_id IS NOT NULL
        AND conversations.stripe_session_url IS NOT NULL
      ORDER BY conversations.created_at DESC
      LIMIT 1
    `,
    [tenantId, leadId],
  );

  return result.rows[0] ?? null;
}

/** Persist a checkout session, and hand back whichever session actually won.
 *
 * COALESCE makes the write first-writer-wins *within one conversation row*.
 * Across two conversations for the same lead that is not enough on its own, so
 * migration 0012 carries a partial UNIQUE index on `(tenant_id, lead_id) WHERE
 * stripe_session_id IS NOT NULL`. The second writer gets a unique violation,
 * its job fails and retries, and the retry's `fetchCheckoutSession` returns the
 * winner. The DB, not this statement, is what makes "one live payment link per
 * lead" true.
 *
 * `lead_id` is in the WHERE clause because a conversation id alone does not
 * prove the row belongs to the lead the session was minted for: stamping lead
 * B's conversation with lead A's session would credit B's payment to A.
 */
export async function recordCheckoutSession(
  tenantId: string,
  leadId: string,
  conversationId: string,
  sessionId: string,
  sessionUrl: string,
  client?: Queryable,
): Promise<{ id: string; url: string }> {
  const result = await db(client).query<{ id: string; url: string }>(
    `
      UPDATE conversations
      SET
        stripe_session_id = COALESCE(stripe_session_id, $4),
        stripe_session_url = COALESCE(stripe_session_url, $5)
      WHERE tenant_id = $1
        AND lead_id = $2
        AND id = $3
      RETURNING stripe_session_id AS id, stripe_session_url AS url
    `,
    [tenantId, leadId, conversationId, sessionId, sessionUrl],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("conversation not found for tenant and lead");
  }

  return row;
}

export async function advanceLeadToReplied(
  tenantId: string,
  leadId: string,
  client?: Queryable,
): Promise<void> {
  await db(client).query(
    `
      UPDATE leads
      SET
        status = 'replied',
        updated_at = NOW()
      WHERE tenant_id = $1
        AND id = $2
        AND status = 'contacted'
    `,
    [tenantId, leadId],
  );
}

export async function archiveLeadForSuppression(
  tenantId: string,
  leadId: string,
  client?: Queryable,
): Promise<void> {
  await db(client).query(
    `
      UPDATE leads
      SET
        status = 'archived',
        updated_at = NOW()
      WHERE tenant_id = $1
        AND id = $2
        AND status IN ('qualified', 'contacted', 'replied')
    `,
    [tenantId, leadId],
  );
}

/**
 * Flags the send, stamps the event time and archives the lead, in one
 * statement.
 *
 * `${column}_at` is written with COALESCE rather than plainly, so a redelivered
 * webhook cannot move the suppression to the day it was retried. Instantly
 * redelivers, and the whole point of the column is that the dashboard stops
 * dating a suppression by the row's last write: overwriting it here would
 * reintroduce that in a new place.
 *
 * The columns are `bounced_at` and `unsubscribed_at`, added by migration
 * `0014_add_suppression_event_times.sql`. `column` is a closed union rather
 * than a string, so the interpolation cannot name anything else.
 */
async function recordInstantlySuppressionEvent(
  column: "bounced" | "unsubscribed",
  tenantId: string,
  leadId: string,
  instantlyLeadId: string,
  client?: Queryable,
): Promise<void> {
  const result = await db(client).query<{ lead_id: string }>(
    `
      WITH marked_send AS (
        UPDATE outreach_sends
        SET
          ${column} = TRUE,
          ${column}_at = COALESCE(${column}_at, NOW()),
          updated_at = NOW()
        WHERE tenant_id = $1
          AND lead_id = $2
          AND instantly_lead_id = $3
        RETURNING lead_id
      ),
      archived_lead AS (
        UPDATE leads
        SET
          status = 'archived',
          updated_at = NOW()
        WHERE leads.tenant_id = $1
          AND leads.id = $2
          AND leads.status IN ('qualified', 'contacted', 'replied')
          AND EXISTS (SELECT 1 FROM marked_send)
        RETURNING id
      )
      SELECT lead_id
      FROM marked_send
    `,
    [tenantId, leadId, instantlyLeadId],
  );

  if (!result.rows[0]) {
    throw new Error("outreach send not found for tenant");
  }
}

export async function recordInstantlyBounce(
  tenantId: string,
  leadId: string,
  instantlyLeadId: string,
  client?: Queryable,
): Promise<void> {
  await recordInstantlySuppressionEvent("bounced", tenantId, leadId, instantlyLeadId, client);
}

export async function recordInstantlyUnsubscribe(
  tenantId: string,
  leadId: string,
  instantlyLeadId: string,
  client?: Queryable,
): Promise<void> {
  await recordInstantlySuppressionEvent("unsubscribed", tenantId, leadId, instantlyLeadId, client);
}

export async function conversationExists(
  tenantId: string,
  conversationId: string,
  client?: Queryable,
): Promise<boolean> {
  const result = await db(client).query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM conversations
        WHERE tenant_id = $1
          AND id = $2
      ) AS exists
    `,
    [tenantId, conversationId],
  );

  return result.rows[0]?.exists ?? false;
}

export async function fetchCheckoutLead(
  tenantId: string,
  leadId: string,
  client?: Queryable,
): Promise<CheckoutLead> {
  const result = await db(client).query<CheckoutLead>(
    `
      SELECT
        tenant_id,
        id AS lead_id,
        business_name,
        email
      FROM leads
      WHERE tenant_id = $1
        AND id = $2
        AND status = 'replied'
      LIMIT 1
    `,
    [tenantId, leadId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("lead not eligible for checkout");
  }

  return row;
}

export async function fetchEscalationContext(
  tenantId: string,
  leadId: string,
  client?: Queryable,
): Promise<EscalationContext> {
  const result = await db(client).query<EscalationContext>(
    `
      SELECT
        leads.tenant_id,
        leads.id AS lead_id,
        leads.first_name,
        leads.last_name,
        leads.business_name,
        leads.city,
        leads.email,
        latest_send.instantly_lead_id,
        latest_send.instantly_campaign_id
      FROM leads
      JOIN LATERAL (
        SELECT outreach_sends.instantly_lead_id, outreach_sends.instantly_campaign_id
        FROM outreach_sends
        WHERE outreach_sends.tenant_id = leads.tenant_id
          AND outreach_sends.lead_id = leads.id
          AND outreach_sends.instantly_lead_id IS NOT NULL
        ORDER BY outreach_sends.sent_at DESC NULLS LAST,
                 outreach_sends.created_at DESC,
                 outreach_sends.id DESC
        LIMIT 1
      ) AS latest_send ON TRUE
      WHERE leads.tenant_id = $1
        AND leads.id = $2
      LIMIT 1
    `,
    [tenantId, leadId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("escalation context not found for tenant or missing Instantly lead id");
  }

  return row;
}

export async function hasCompletedPayment(
  tenantId: string,
  leadId: string,
  client?: Queryable,
): Promise<boolean> {
  const result = await db(client).query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM payments
        WHERE tenant_id = $1
          AND lead_id = $2
          AND status = 'completed'
      ) AS exists
    `,
    [tenantId, leadId],
  );

  return result.rows[0]?.exists ?? false;
}

export async function recordCompletedPayment(
  input: CompletedPaymentInput,
  client?: Queryable,
): Promise<CompletedPaymentResult> {
  const result = await db(client).query<CompletedPaymentResult>(
    `
      WITH lead_match AS (
        SELECT
          leads.tenant_id,
          leads.id AS lead_id,
          leads.business_name,
          leads.email
        FROM leads
        WHERE leads.tenant_id = $1
          AND leads.id = $2
          AND (
            leads.status = 'replied'
            OR EXISTS (
              SELECT 1
              FROM payments
              WHERE payments.tenant_id = leads.tenant_id
                AND payments.lead_id = leads.id
                AND payments.stripe_session_id = $3
            )
          )
      ),
      upserted AS (
        INSERT INTO payments (
          tenant_id,
          lead_id,
          stripe_session_id,
          stripe_payment_intent_id,
          amount_aud,
          status,
          paid_at
        )
        SELECT
          tenant_id,
          lead_id,
          $3,
          $4,
          $5,
          'completed',
          NOW()
        FROM lead_match
        ON CONFLICT (stripe_session_id) DO UPDATE
        SET
          stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id,
          status = 'completed',
          paid_at = COALESCE(payments.paid_at, NOW()),
          updated_at = NOW()
        WHERE payments.tenant_id = $1
          AND payments.lead_id = $2
        RETURNING tenant_id, lead_id
      ),
      onboarding_guard AS (
        UPDATE payments
        SET
          onboarding_triggered = TRUE,
          updated_at = NOW()
        WHERE tenant_id = $1
          AND lead_id = $2
          AND stripe_session_id = $3
          AND status = 'completed'
          AND onboarding_triggered = FALSE
          AND EXISTS (SELECT 1 FROM upserted)
        RETURNING id
      ),
      paid_lead AS (
        UPDATE leads
        SET
          status = 'paid',
          updated_at = NOW()
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'replied'
          AND EXISTS (SELECT 1 FROM onboarding_guard)
        RETURNING id
      )
      SELECT
        lead_match.tenant_id,
        lead_match.lead_id,
        lead_match.business_name,
        lead_match.email,
        EXISTS (SELECT 1 FROM onboarding_guard) AS should_send_welcome
      FROM lead_match
      WHERE EXISTS (SELECT 1 FROM upserted)
    `,
    [
      input.tenant_id,
      input.lead_id,
      input.stripe_session_id,
      input.stripe_payment_intent_id,
      input.amount_aud,
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("payment lead not found for tenant or invalid state");
  }

  return row;
}

/** Count one view of a preview page.
 *
 * `first_viewed_at` is written with COALESCE rather than a read-then-write so
 * the "only on the first view" rule is decided by Postgres inside the row
 * lock, not by application code. Two concurrent hits, which is normal when a
 * prospect reloads or opens the link on a phone and a laptop, would otherwise
 * both read NULL and both claim to be the first view.
 *
 * Scoped by tenant_id even though preview_slug is globally unique. The tenant
 * comes from configuration, not from the request, so a slug belonging to
 * another tenant matches nothing here instead of being written to.
 *
 * Returns null when the slug matches no preview for this tenant, which is the
 * caller's signal that the hit was for a page we do not own.
 */
export async function recordWebsitePreviewView(
  tenantId: string,
  previewSlug: string,
  client?: Queryable,
): Promise<{ lead_id: string } | null> {
  const result = await db(client).query<{ lead_id: string }>(
    `
      UPDATE website_previews
      SET
        first_viewed_at = COALESCE(first_viewed_at, NOW()),
        last_viewed_at  = NOW(),
        view_count      = view_count + 1
      WHERE tenant_id = $1
        AND preview_slug = $2
      RETURNING lead_id
    `,
    [tenantId, previewSlug],
  );

  return result.rows[0] ?? null;
}

/** Per-lead preview view state, for splitting "delivered and ignored" from
 * "never arrived".
 *
 * `preview_seen` is derived here rather than left to each caller so that one
 * definition of seen exists. A lead with a preview row and no first_viewed_at
 * is unseen; a lead with no preview row at all does not appear, because
 * nothing was ever sent for it to have seen.
 *
 * Pass null for leadIds to read the whole tenant, or a list to narrow to a
 * page of leads without a second round trip per row.
 */
export async function fetchPreviewViewStates(
  tenantId: string,
  leadIds: string[] | null = null,
  client?: Queryable,
): Promise<PreviewViewState[]> {
  const result = await db(client).query<PreviewViewState>(
    `
      SELECT
        website_previews.lead_id,
        website_previews.first_viewed_at,
        website_previews.last_viewed_at,
        website_previews.view_count,
        website_previews.first_viewed_at IS NOT NULL AS preview_seen
      FROM website_previews
      WHERE website_previews.tenant_id = $1
        AND (
          $2::uuid[] IS NULL
          OR website_previews.lead_id = ANY($2::uuid[])
        )
      ORDER BY website_previews.last_viewed_at DESC NULLS LAST
    `,
    [tenantId, leadIds],
  );

  return result.rows;
}

/** Find the send an Instantly webhook is about, from Instantly's own lead id.
 *
 * `outreach_sends.instantly_lead_id` is written on every completed send and
 * is the one identifier we can be sure an Instantly event carries, so this is
 * the primary route from a webhook back to one of our leads. Instantly does
 * not echo our `tenant_id` or `lead_id`, and depending on it doing so is what
 * silently discarded every bounce, unsubscribe and reply.
 *
 * The id is Instantly's, unique across our table, so an unscoped lookup is
 * correct: the row it finds is what tells us which tenant the event belongs
 * to. Passing a tenant narrows the query anyway, because a caller that
 * already knows the tenant is asserting the row has to be inside it.
 *
 * The join to `leads` is not decoration. The lead row is what the callers go
 * on to archive or attach a conversation to, and a send whose lead has been
 * hard deleted must resolve to nothing rather than to a dangling id.
 */
export async function findOutreachTargetByInstantlyLeadId(
  instantlyLeadId: string,
  tenantId: string | null = null,
  client?: Queryable,
): Promise<OutreachTarget | null> {
  const result = await db(client).query<OutreachTarget>(
    `
      SELECT
        outreach_sends.tenant_id,
        outreach_sends.lead_id,
        outreach_sends.instantly_lead_id
      FROM outreach_sends
      JOIN leads
        ON leads.tenant_id = outreach_sends.tenant_id
       AND leads.id = outreach_sends.lead_id
      WHERE outreach_sends.instantly_lead_id = $1
        AND (
          $2::uuid IS NULL
          OR outreach_sends.tenant_id = $2::uuid
        )
      ORDER BY outreach_sends.sent_at DESC NULLS LAST,
               outreach_sends.created_at DESC,
               outreach_sends.id DESC
      LIMIT 1
    `,
    [instantlyLeadId, tenantId],
  );

  return result.rows[0] ?? null;
}

/** Find the send an Instantly webhook is about, from the lead's email address.
 *
 * The fallback for a payload that carries no id we recognise. Every bounce,
 * unsubscribe and reply is an event about an email address, so this is the
 * identifier most certain to be present whatever shape the payload takes.
 *
 * Tenant scoping is mandatory here and the parameter is not optional.
 * Addresses are not unique across tenants, two operators working the same
 * trade in the same city will hold the same lead, and an unscoped match would
 * archive or reply to the wrong company's lead. Nothing in the request may
 * choose the tenant that is not itself already proven.
 *
 * Two leads inside one tenant can also share an address, and there is no
 * constraint preventing it. Guessing between them would suppress the wrong
 * lead, so more than one match resolves to nothing and the caller reports the
 * event as unresolved.
 *
 * The join to `outreach_sends` restricts this to leads we actually handed to
 * Instantly, which is the only population these events can be about, and it
 * is also where the Instantly lead id comes from when the payload has none.
 */
export async function findOutreachTargetByEmail(
  tenantId: string,
  email: string,
  client?: Queryable,
): Promise<OutreachTarget | null> {
  const result = await db(client).query<OutreachTarget>(
    `
      SELECT DISTINCT ON (leads.id)
        leads.tenant_id,
        leads.id AS lead_id,
        outreach_sends.instantly_lead_id
      FROM leads
      JOIN outreach_sends
        ON outreach_sends.tenant_id = leads.tenant_id
       AND outreach_sends.lead_id = leads.id
      WHERE leads.tenant_id = $1
        AND LOWER(leads.email) = LOWER($2)
        AND outreach_sends.instantly_lead_id IS NOT NULL
      ORDER BY leads.id,
               outreach_sends.sent_at DESC NULLS LAST,
               outreach_sends.created_at DESC,
               outreach_sends.id DESC
      LIMIT 2
    `,
    [tenantId, email],
  );

  if (result.rows.length !== 1) {
    return null;
  }

  return result.rows[0] ?? null;
}

/** Find the latest completed send for a tenant and lead we already know.
 *
 * For the case where Instantly echoes our own `tenant_id` and `lead_id`, from
 * `metadata` or from the custom variables the pipeline attaches, but no
 * Instantly lead id. Both suppression writes match on
 * `outreach_sends.instantly_lead_id`, so knowing our own ids is not by itself
 * enough to record anything, and this is the round trip that completes them.
 */
export async function findOutreachTargetByLeadId(
  tenantId: string,
  leadId: string,
  client?: Queryable,
): Promise<OutreachTarget | null> {
  const result = await db(client).query<OutreachTarget>(
    `
      SELECT
        outreach_sends.tenant_id,
        outreach_sends.lead_id,
        outreach_sends.instantly_lead_id
      FROM outreach_sends
      WHERE outreach_sends.tenant_id = $1
        AND outreach_sends.lead_id = $2
        AND outreach_sends.instantly_lead_id IS NOT NULL
      ORDER BY outreach_sends.sent_at DESC NULLS LAST,
               outreach_sends.created_at DESC,
               outreach_sends.id DESC
      LIMIT 1
    `,
    [tenantId, leadId],
  );

  return result.rows[0] ?? null;
}

export const queries = {
  insertInboundConversation,
  fetchLeadContext,
  fetchConversationHistory,
  countInboundReplies,
  hasCheckoutAction,
  updateConversationClassification,
  markConversationEscalated,
  fetchCheckoutSession,
  recordCheckoutSession,
  advanceLeadToReplied,
  archiveLeadForSuppression,
  recordInstantlyBounce,
  recordInstantlyUnsubscribe,
  findOutreachTargetByInstantlyLeadId,
  findOutreachTargetByEmail,
  findOutreachTargetByLeadId,
  conversationExists,
  fetchCheckoutLead,
  fetchEscalationContext,
  hasCompletedPayment,
  recordCompletedPayment,
  recordWebsitePreviewView,
  fetchPreviewViewStates,
};
