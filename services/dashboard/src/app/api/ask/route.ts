import Anthropic from "@anthropic-ai/sdk";
import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedOperator } from "@/auth/operators";
import { createSupabaseServerClient } from "@/auth/server";
import { getDashboardTenantId } from "@/auth/tenant";
import { buildAskSystemPrompt } from "@/lib/ask/system-prompt";
import { buildAskTools, runAskTool } from "@/lib/ask/tools";
import {
  recordAskMessage,
  startAskConversation,
  type AskToolCallRecord,
} from "@/lib/ask/transcript";

/**
 * The ask panel's one endpoint.
 *
 * A manual agentic loop rather than the SDK tool runner, because the panel has
 * to show every read as it happens: the loop owns the tool calls, so each one
 * can be streamed to the UI before and after it runs. Events go out as
 * newline delimited JSON, one event per line.
 *
 * The model can only read. Nothing in the toolbox sends, pauses or writes, so
 * the worst case here is a wrong answer, not a wrong action.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sonnet, not Opus. It reads tools and summarises; the reasoning is shallow and the volume is high. */
const MODEL = "claude-sonnet-5";

/** Enough for a long answer with a table in it. */
const MAX_TOKENS = 8_000;

/**
 * A ceiling on tool rounds, not on tools per round. A question that needs more
 * than this is a question the panel cannot answer, and saying so beats looping
 * until the request times out.
 */
const MAX_TOOL_ROUNDS = 8;

const QUESTION_MAX_LENGTH = 2_000;

type AskEvent =
  | { type: "conversation"; conversationId: string | null }
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; failed: boolean; output: string }
  | { type: "done"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string };

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isAuthorizedOperator(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenantId = getDashboardTenantId();
  if (!tenantId) {
    return NextResponse.json({ error: "Dashboard tenant not configured" }, { status: 500 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured, so the ask panel cannot answer." },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const payload = body as { question?: unknown; conversationId?: unknown; history?: unknown };
  const question = typeof payload.question === "string" ? payload.question.trim() : "";

  if (!question) {
    return NextResponse.json({ error: "A question is required" }, { status: 400 });
  }

  if (question.length > QUESTION_MAX_LENGTH) {
    return NextResponse.json(
      { error: `A question must be ${QUESTION_MAX_LENGTH} characters or fewer.` },
      { status: 400 },
    );
  }

  const existingConversationId =
    typeof payload.conversationId === "string" && payload.conversationId.length > 0
      ? payload.conversationId
      : null;

  /**
   * History comes from the panel so a follow up ("and yesterday?") has the
   * thread behind it. Only the plain text of each turn is carried: tool
   * results are not replayed, because they are stale by the next question and
   * would be read again anyway.
   */
  const history = Array.isArray(payload.history)
    ? payload.history
        .filter(
          (entry): entry is { role: "user" | "assistant"; content: string } =>
            typeof entry === "object" &&
            entry !== null &&
            (("role" in entry && (entry as { role: unknown }).role === "user") ||
              (entry as { role: unknown }).role === "assistant") &&
            typeof (entry as { content: unknown }).content === "string",
        )
        .slice(-10)
        .map((entry) => ({ role: entry.role, content: entry.content.slice(0, 4_000) }))
    : [];

  const tools = buildAskTools();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AskEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      const toolCallRecords: AskToolCallRecord[] = [];
      let answer = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let failureReason: string | null = null;

      const conversationId =
        existingConversationId ??
        (await startAskConversation({
          tenantId,
          operatorEmail: user.email ?? "unknown",
          title: question,
        }));

      emit({ type: "conversation", conversationId });

      try {
        const messages: Anthropic.MessageParam[] = [
          ...history,
          { role: "user", content: question },
        ];

        const apiTools: Anthropic.Tool[] = tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
        }));

        for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
          const messageStream = client.messages.stream({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: buildAskSystemPrompt({ tenantId }),
            tools: apiTools,
            messages,
          });

          messageStream.on("text", (delta) => {
            answer += delta;
            emit({ type: "text", text: delta });
          });

          const message = await messageStream.finalMessage();
          inputTokens += message.usage.input_tokens;
          outputTokens += message.usage.output_tokens;

          messages.push({ role: "assistant", content: message.content });

          const toolUses = message.content.filter(
            (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
          );

          if (toolUses.length === 0) {
            break;
          }

          const results: Anthropic.ToolResultBlockParam[] = [];

          for (const use of toolUses) {
            emit({ type: "tool_start", id: use.id, name: use.name, input: use.input });

            const result = await runAskTool(
              use.name,
              (use.input ?? {}) as Record<string, unknown>,
              { tenantId },
            );

            toolCallRecords.push({
              name: use.name,
              input: use.input,
              failed: result.isError,
              reason: result.isError ? result.text : null,
            });

            emit({
              type: "tool_end",
              id: use.id,
              failed: result.isError,
              /** Trimmed for the panel only. The model gets the whole result. */
              output: result.text.slice(0, 4_000),
            });

            results.push({
              type: "tool_result",
              tool_use_id: use.id,
              content: result.text,
              is_error: result.isError,
            });
          }

          messages.push({ role: "user", content: results });

          if (round === MAX_TOOL_ROUNDS - 1) {
            const stopped = `\n\nI stopped after ${MAX_TOOL_ROUNDS} rounds of reads without finishing. Ask me something narrower and I will get there.`;
            answer += stopped;
            emit({ type: "text", text: stopped });
            failureReason = "tool round limit reached";
          }
        }

        emit({ type: "done", inputTokens, outputTokens });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        failureReason = message;
        console.error("Ask panel failed to answer", { message });
        emit({ type: "error", message });
      } finally {
        await recordAskMessage({
          conversationId,
          tenantId,
          question,
          answer: answer.length > 0 ? answer : null,
          toolCalls: toolCallRecords,
          model: MODEL,
          inputTokens,
          outputTokens,
          failureReason,
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
