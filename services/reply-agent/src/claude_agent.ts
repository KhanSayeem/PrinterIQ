import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ClaudeReplyClassification, ConversationHistoryItem, LeadContext } from "./types.js";
import { offerPriceDisplay } from "./offer.js";
import { estimateCostUsd } from "./model_pricing.js";

const promptVersion = "reply-agent-v1";
/** Fallback when CLAUDE_REPLY_MODEL is unset.
 *
 * This was claude-3-5-sonnet-latest, two generations behind, on the path that
 * classifies an inbound sales reply and drafts the auto-reply that is then
 * queued and sent to the prospect. Production sets CLAUDE_REPLY_MODEL
 * explicitly; this value is what runs if that is ever missing, so it should
 * not be the oldest model in the family.
 */
const defaultModel = "claude-opus-5";

const claudeSchema = z.object({
  intent: z.enum(["interested", "question", "objection", "not_interested", "unsubscribe", "abusive"]),
  confidence: z.number().int().min(0).max(100),
  reply_body: z.string(),
  action: z.enum(["reply", "send_checkout", "escalate", "suppress"]),
  escalation_reason: z.string().nullable(),
});

type ClassifyInput = {
  leadContext: LeadContext;
  conversationHistory: ConversationHistoryItem[];
  inboundBody: string;
};

let promptTemplate: string | null = null;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function loadPrompt(): Promise<string> {
  if (!promptTemplate) {
    promptTemplate = await readFile(path.resolve(moduleDir, "..", "..", "..", "prompts", "reply-agent-v1.txt"), "utf8");
  }

  return promptTemplate;
}

function fillPrompt(template: string, input: ClassifyInput): string {
  return template
    .replace("{lead_json}", JSON.stringify(input.leadContext.lead, null, 2))
    .replace("{top_weakness}", input.leadContext.top_weakness ?? "Unknown")
    .replace("{conversation_history}", JSON.stringify(input.conversationHistory, null, 2))
    .replace("{price_aud}", offerPriceDisplay())
    .replace("{inbound_body}", input.inboundBody);
}

export async function classifyReply(input: ClassifyInput): Promise<ClaudeReplyClassification> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_REPLY_MODEL ?? defaultModel;
  const prompt = fillPrompt(await loadPrompt(), input);
  // No temperature, top_p or top_k. Sampling parameters were removed from the
  // current models and are rejected outright: production on 2026-09-16 failed
  // every classification with
  // `400 invalid_request_error: temperature is deprecated for this model`,
  // on claude-opus-5. The first real inbound reply this agent ever handled was
  // retried three times and never classified because of this one line.
  const response = await client.messages.create({
    model,
    max_tokens: 700,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    throw new Error("Claude returned invalid JSON", { cause: error });
  }

  const parsed = claudeSchema.parse(parsedJson);
  const usage = response.usage;

  return {
    ...parsed,
    prompt_version: promptVersion,
    model_used: model,
    cost_usd: estimateCostUsd(model, usage.input_tokens, usage.output_tokens),
  };
}

export const claudeAgent = {
  classifyReply,
};
