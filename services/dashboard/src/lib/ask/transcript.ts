import "server-only";

import { sql } from "drizzle-orm";

import { getDb } from "@/db/client";

/**
 * Writes what was asked and what came back.
 *
 * Nothing here is allowed to break an answer: a failure to record is logged
 * and swallowed, because losing the transcript is a smaller loss than losing
 * the answer the operator was waiting for.
 */

/** Dollars per million tokens, matching services/reply-agent/src/model_pricing.ts. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

export function askAnswerCostUsd({
  model,
  inputTokens,
  outputTokens,
}: {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}): number | null {
  const price = PRICES[model];
  if (!price) {
    return null;
  }

  const dollars = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}

export type AskToolCallRecord = {
  readonly name: string;
  readonly input: unknown;
  readonly failed: boolean;
  /** The reason a read failed, or null. Never the rows themselves. */
  readonly reason: string | null;
};

export async function startAskConversation({
  tenantId,
  operatorEmail,
  title,
}: {
  readonly tenantId: string;
  readonly operatorEmail: string;
  readonly title: string;
}): Promise<string | null> {
  try {
    const rows = await getDb().execute(sql`
      insert into ask_conversations (tenant_id, operator_email, title)
      values (${tenantId}, ${operatorEmail}, ${title.slice(0, 200)})
      returning id
    `);

    const id = (rows as unknown as { id?: string }[])[0]?.id;
    return id ?? null;
  } catch (error) {
    console.error("Failed to open an ask conversation", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return null;
  }
}

export async function recordAskMessage({
  conversationId,
  tenantId,
  question,
  answer,
  toolCalls,
  model,
  inputTokens,
  outputTokens,
  failureReason,
}: {
  readonly conversationId: string | null;
  readonly tenantId: string;
  readonly question: string;
  readonly answer: string | null;
  readonly toolCalls: readonly AskToolCallRecord[];
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly failureReason: string | null;
}): Promise<void> {
  if (!conversationId) {
    return;
  }

  const cost = askAnswerCostUsd({ model, inputTokens, outputTokens });

  try {
    await getDb().execute(sql`
      insert into ask_messages (
        conversation_id, tenant_id, question, answer, tool_calls,
        model_used, input_tokens, output_tokens, cost_usd, failure_reason
      )
      values (
        ${conversationId}, ${tenantId}, ${question}, ${answer},
        ${JSON.stringify(toolCalls)}::jsonb,
        ${model}, ${inputTokens}, ${outputTokens}, ${cost}, ${failureReason}
      )
    `);

    await getDb().execute(sql`
      update ask_conversations set last_message_at = now() where id = ${conversationId}
    `);
  } catch (error) {
    console.error("Failed to record an ask message", {
      message: error instanceof Error ? error.message : "unknown error",
    });
  }
}
