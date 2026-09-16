import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadContext } from "../src/types.js";

const sdk = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async (params: Record<string, unknown>) => {
        sdk.calls.push(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                intent: "objection",
                confidence: 82,
                reply_body: "No worries at all.",
                action: "reply",
                escalation_reason: null,
              }),
            },
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
