import { describe, expect, it, vi } from "vitest";
import {
  handleRetryCheckout,
  handleProcessReply,
  handleSendReply,
  type ClaudeClassifier,
  type ReplyQueries,
  type ReplyQueue,
} from "../src/handler.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const leadId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";

function processJob(body = "How much is it?") {
  return {
    job_type: "process_reply" as const,
    tenant_id: tenantId,
    lead_id: leadId,
    channel: "email" as const,
    direction: "inbound" as const,
    body,
    raw_webhook: { event: "reply" },
  };
}

function createQueries(overrides: Partial<ReplyQueries> = {}): ReplyQueries {
  return {
    insertInboundConversation: vi.fn().mockResolvedValue({ id: conversationId }),
    fetchLeadContext: vi.fn().mockResolvedValue({
      lead: { id: leadId, business_name: "Test Plumbing", email: "lead@example.com" },
      top_weakness: "Missing mobile-friendly layout",
      tenant_voice_prompt: "Write like Macauley.",
    }),
    fetchConversationHistory: vi.fn().mockResolvedValue([]),
    countInboundReplies: vi.fn().mockResolvedValue(1),
    hasCheckoutAction: vi.fn().mockResolvedValue(false),
    updateConversationClassification: vi.fn().mockResolvedValue(undefined),
    conversationExists: vi.fn().mockResolvedValue(true),
    advanceLeadToReplied: vi.fn().mockResolvedValue(undefined),
    archiveLeadForSuppression: vi.fn().mockResolvedValue(undefined),
    fetchCheckoutLead: vi.fn().mockResolvedValue({
      tenant_id: tenantId,
      lead_id: leadId,
      business_name: "Test Plumbing",
      email: "lead@example.com",
    }),
    hasCompletedPayment: vi.fn().mockResolvedValue(false),
    recordCompletedPayment: vi.fn().mockResolvedValue({
      tenant_id: tenantId,
      lead_id: leadId,
      business_name: "Test Plumbing",
      email: "lead@example.com",
      should_send_welcome: true,
    }),
    ...overrides,
  };
}

function createClaude(overrides = {}) {
  return {
    classifyReply: vi.fn().mockResolvedValue({
      intent: "question",
      confidence: 85,
      reply_body: "Yeah mate, it is $1,500 fixed.",
      action: "reply",
      escalation_reason: null,
      prompt_version: "reply-agent-v1",
      model_used: "claude-3-5-sonnet-latest",
      cost_usd: 0.01,
      ...overrides,
    }),
  } satisfies ClaudeClassifier;
}

function createQueue(): ReplyQueue {
  return {
    add: vi.fn().mockResolvedValue(undefined),
  };
}

describe("process_reply handler", () => {
  it("escalates call-me replies without calling Claude", async () => {
    const queries = createQueries();
    const claude = createClaude();
    const queue = createQueue();

    const result = await handleProcessReply(processJob("Can you call me?"), {
      queries,
      claude,
      queue,
    });

    expect(claude.classifyReply).not.toHaveBeenCalled();
    expect(queries.updateConversationClassification).toHaveBeenCalledWith(
      tenantId,
      conversationId,
      expect.objectContaining({
        agent_action: "escalate",
        escalated: true,
      }),
    );
    expect(result.action).toBe("escalate");
  });

  it("inserts the inbound conversation before calling Claude", async () => {
    const events: string[] = [];
    const queries = createQueries({
      insertInboundConversation: vi.fn().mockImplementation(async () => {
        events.push("insert");
        return { id: conversationId };
      }),
    });
    const claude: ClaudeClassifier = {
      classifyReply: vi.fn().mockImplementation(async () => {
        events.push("claude");
        return {
          intent: "question",
          confidence: 85,
          reply_body: "Sure thing.",
          action: "reply",
          escalation_reason: null,
          prompt_version: "reply-agent-v1",
          model_used: "claude-3-5-sonnet-latest",
          cost_usd: 0.01,
        };
      }),
    };

    await handleProcessReply(processJob(), { queries, claude, queue: createQueue() });

    expect(events).toEqual(["insert", "claude"]);
  });

  it("advances the lead to replied after inserting the inbound conversation", async () => {
    const events: string[] = [];
    const queries = createQueries({
      insertInboundConversation: vi.fn().mockImplementation(async () => {
        events.push("insert");
        return { id: conversationId };
      }),
      advanceLeadToReplied: vi.fn().mockImplementation(async () => {
        events.push("advance");
      }),
    });

    await handleProcessReply(processJob(), {
      queries,
      claude: createClaude(),
      queue: createQueue(),
    });

    expect(queries.advanceLeadToReplied).toHaveBeenCalledWith(tenantId, leadId);
    expect(events.slice(0, 2)).toEqual(["insert", "advance"]);
  });

  it("escalates Claude classifications below 60 confidence", async () => {
    const queries = createQueries();
    const result = await handleProcessReply(processJob("Not sure"), {
      queries,
      claude: createClaude({ confidence: 59, action: "reply" }),
      queue: createQueue(),
    });

    expect(queries.updateConversationClassification).toHaveBeenCalledWith(
      tenantId,
      conversationId,
      expect.objectContaining({
        agent_action: "escalate",
        escalated: true,
        escalation_reason: "low_confidence",
      }),
    );
    expect(result.action).toBe("escalate");
  });

  it("escalates after three inbound replies when checkout has not happened", async () => {
    const queries = createQueries({
      countInboundReplies: vi.fn().mockResolvedValue(3),
      hasCheckoutAction: vi.fn().mockResolvedValue(false),
    });
    const claude = createClaude();

    const result = await handleProcessReply(processJob("Another question"), {
      queries,
      claude,
      queue: createQueue(),
    });

    expect(claude.classifyReply).not.toHaveBeenCalled();
    expect(queries.updateConversationClassification).toHaveBeenCalledWith(
      tenantId,
      conversationId,
      expect.objectContaining({
        agent_action: "escalate",
        escalated: true,
        escalation_reason: "three_inbound_replies_without_checkout",
      }),
    );
    expect(result.action).toBe("escalate");
  });

  it("enqueues send_reply for a clean reply action", async () => {
    const queue = createQueue();

    const result = await handleProcessReply(processJob("Sounds good"), {
      queries: createQueries(),
      claude: createClaude({ action: "reply", reply_body: "Yeah mate, here is the answer." }),
      queue,
    });

    expect(queue.add).toHaveBeenCalledWith(
      "send_reply",
      expect.objectContaining({
        job_type: "send_reply",
        tenant_id: tenantId,
        lead_id: leadId,
        conversation_id: conversationId,
        body: "Yeah mate, here is the answer.",
      }),
      { jobId: `send_reply:${tenantId}:${conversationId}` },
    );
    expect(result.action).toBe("reply");
  });

  it("archives the lead and does not enqueue a reply for suppress actions", async () => {
    const queries = createQueries();
    const queue = createQueue();

    const result = await handleProcessReply(processJob("Unsubscribe me"), {
      queries,
      claude: createClaude({
        intent: "unsubscribe",
        action: "suppress",
        reply_body: "",
      }),
      queue,
    });

    expect(queries.archiveLeadForSuppression).toHaveBeenCalledWith(tenantId, leadId);
    expect(queue.add).not.toHaveBeenCalled();
    expect(result.action).toBe("suppress");
  });
});

describe("send_reply handler", () => {
  it("fails when conversation_id is missing", async () => {
    await expect(
      handleSendReply({
        job_type: "send_reply",
        tenant_id: tenantId,
        lead_id: leadId,
        channel: "email",
        action: "reply",
        body: "Hi",
        instantly_lead_id: null,
        stripe_session_url: null,
      }),
    ).rejects.toThrow("conversation_id is required");
  });

  it("fails when conversation_id does not exist for the tenant", async () => {
    const queries = createQueries({
      conversationExists: vi.fn().mockResolvedValue(false),
    });

    await expect(
      handleSendReply(
        {
          job_type: "send_reply",
          tenant_id: tenantId,
          lead_id: leadId,
          conversation_id: conversationId,
          channel: "email",
          action: "reply",
          body: "Hi",
          instantly_lead_id: null,
          stripe_session_url: null,
        },
        { queries },
      ),
    ).rejects.toThrow("conversation_id was not found");
  });

  it("creates a Stripe checkout URL for send_checkout replies", async () => {
    const stripe = {
      createCheckoutSession: vi.fn().mockResolvedValue({
        id: "cs_test_123",
        url: "https://checkout.stripe.com/c/pay/cs_test_123",
      }),
    };

    const result = await handleSendReply(
      {
        job_type: "send_reply",
        tenant_id: tenantId,
        lead_id: leadId,
        conversation_id: conversationId,
        channel: "email",
        action: "send_checkout",
        body: "Here is the checkout link:",
        instantly_lead_id: null,
        stripe_session_url: null,
      },
      { queries: createQueries(), stripe },
    );

    expect(stripe.createCheckoutSession).toHaveBeenCalledWith({
      tenant_id: tenantId,
      lead_id: leadId,
    });
    expect(result).toEqual({
      action: "noop",
      conversation_id: conversationId,
      stripe_session_url: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
  });
});

describe("retry_checkout handler", () => {
  it("checks payment completion before doing any retry work", async () => {
    const queries = createQueries({
      hasCompletedPayment: vi.fn().mockResolvedValue(true),
    });

    const result = await handleRetryCheckout(
      {
        job_type: "retry_checkout",
        tenant_id: tenantId,
        lead_id: leadId,
        original_session: "cs_test_123",
        scheduled_at: "2026-05-21T09:00:00+10:00",
      },
      { queries },
    );

    expect(queries.hasCompletedPayment).toHaveBeenCalledWith(tenantId, leadId);
    expect(result).toEqual({ action: "noop", reason: "payment_completed" });
  });
});
