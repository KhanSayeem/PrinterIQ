import type pg from "pg";
import { getPool } from "./client.js";
import type { ConversationClassificationUpdate, ConversationHistoryItem, LeadContext } from "../types.js";

type Queryable = Pick<pg.Pool, "query">;

function db(client?: Queryable): Queryable {
  return client ?? getPool();
}

export async function insertInboundConversation(
  tenantId: string,
  leadId: string,
  channel: string,
  body: string,
  client?: Queryable,
): Promise<{ id: string }> {
  const result = await db(client).query<{ id: string }>(
    `
      INSERT INTO conversations (
        tenant_id,
        lead_id,
        direction,
        channel,
        body
      )
      SELECT
        tenant_id,
        id,
        'inbound',
        $3,
        $4
      FROM leads
      WHERE tenant_id = $1
        AND id = $2
      RETURNING id
    `,
    [tenantId, leadId, channel, body],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("lead not found for tenant");
  }

  return row;
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

export const queries = {
  insertInboundConversation,
  fetchLeadContext,
  fetchConversationHistory,
  countInboundReplies,
  hasCheckoutAction,
  updateConversationClassification,
  advanceLeadToReplied,
  archiveLeadForSuppression,
  conversationExists,
};
