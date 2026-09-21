import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadContext } from "../src/types.js";

const CLASSIFICATION = {
  intent: "objection",
  confidence: 82,
  reply_body: "No worries at all.",
  action: "reply",
  escalation_reason: null,
};

const sdk = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  content: null as unknown[] | null,
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async (params: Record<string, unknown>) => {
        sdk.calls.push(params);
        return {
          content: sdk.content ?? [
            { type: "tool_use", id: "toolu_1", name: "classify_reply", input: CLASSIFICATION },
          ],
          usage: { input_tokens: 1200, output_tokens: 150 },
        };
      },
    };
  }

  return { default: FakeAnthropic };
});

const { classifyReply } = await import("../src/claude_agent.js");

const leadContext = {
  lead: { id: "lead-1", business_name: "Enlightening Education", email: "lead@example.com" },
  top_weakness: "no_meta_description",
} as unknown as LeadContext;

describe("classifyReply request shape", () => {
  beforeEach(() => {
    sdk.calls.length = 0;
    sdk.content = null;
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.CLAUDE_REPLY_MODEL = "claude-opus-5";
  });

  /**
   * Production on 2026-09-16, the first real inbound reply this handler ever
   * saw: every classification failed with
   * `400 invalid_request_error: temperature is deprecated for this model`.
   * Sampling parameters were removed from the current models, so sending one
   * is a hard rejection, not a warning. Every test mocked the classifier, so
   * nothing here ever exercised the request itself.
   */
  it("sends no temperature, because current models reject it", async () => {
    await classifyReply({ leadContext, conversationHistory: [], inboundBody: "No funds right now." });

    const params = sdk.calls[0]!;
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
    expect(params).not.toHaveProperty("top_k");
  });

  it("asks the configured model and leaves room for the answer", async () => {
    await classifyReply({ leadContext, conversationHistory: [], inboundBody: "No funds right now." });

    const params = sdk.calls[0]!;
    expect(params.model).toBe("claude-opus-5");
    expect(typeof params.max_tokens).toBe("number");
  });

  it("returns the classification with the model and cost recorded", async () => {
    const result = await classifyReply({
      leadContext,
      conversationHistory: [],
      inboundBody: "No funds right now.",
    });

    expect(result.intent).toBe("objection");
    expect(result.model_used).toBe("claude-opus-5");
    expect(result.cost_usd).toBeGreaterThan(0);
  });
});

describe("classifyReply output", () => {
  beforeEach(() => {
    sdk.calls.length = 0;
    sdk.content = null;
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.CLAUDE_REPLY_MODEL = "claude-opus-5";
  });

  /**
   * Production on 2026-09-17: a reply from Beyond Training failed three times
   * with "Claude returned invalid JSON" and was dropped. The classifier asked
   * for JSON in prose and parsed the text, so any preamble or code fence broke
   * it. Forcing a tool call makes the API hand back an object instead.
   */
  it("forces the answer through the classify tool", async () => {
    await classifyReply({ leadContext, conversationHistory: [], inboundBody: "Not now thanks." });

    const params = sdk.calls[0] as {
      tools?: { name: string; input_schema: { required?: string[] } }[];
      tool_choice?: { type: string; name?: string };
    };

    expect(params.tool_choice).toEqual({ type: "tool", name: "classify_reply" });
    expect(params.tools?.map((tool) => tool.name)).toEqual(["classify_reply"]);
    expect(params.tools?.[0]?.input_schema.required).toEqual(
      expect.arrayContaining(["intent", "confidence", "reply_body", "action", "escalation_reason"]),
    );
  });

  it("reads the classification from the tool call, not from text", async () => {
    const result = await classifyReply({ leadContext, conversationHistory: [], inboundBody: "Not now thanks." });

    expect(result.intent).toBe("objection");
    expect(result.action).toBe("reply");
  });

  /** The exact shape that failed: JSON wrapped in a fence, with no tool call. */
  it("says what went wrong when the model answers in text instead", async () => {
    const fenced = ["```json", JSON.stringify(CLASSIFICATION), "```"].join("\n");
    sdk.content = [{ type: "text", text: fenced }];

    await expect(
      classifyReply({ leadContext, conversationHistory: [], inboundBody: "Not now thanks." }),
    ).rejects.toThrow(/did not call the classify tool/i);
  });

  it("still rejects a classification outside the allowed values", async () => {
    sdk.content = [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "classify_reply",
        input: { ...CLASSIFICATION, intent: "delighted" },
      },
    ];

    await expect(
      classifyReply({ leadContext, conversationHistory: [], inboundBody: "Not now thanks." }),
    ).rejects.toThrow();
  });
});
