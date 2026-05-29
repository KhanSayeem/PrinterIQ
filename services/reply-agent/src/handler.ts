import type {
  ClaudeReplyClassification,
  ConversationClassificationUpdate,
  ConversationHistoryItem,
  CompletedPaymentInput,
  CompletedPaymentResult,
  CheckoutLead,
  LeadContext,
  ProcessReplyJob,
  RetryCheckoutJob,
  SendReplyJob,
} from "./types.js";
import { claudeAgent } from "./claude_agent.js";
import { queries as defaultQueries } from "./db/queries.js";
import { escalate as defaultEscalate, type EscalationInput } from "./escalation.js";
import { stripePayments } from "./stripe.js";

export type ReplyQueries = {
  insertInboundConversation(
    tenantId: string,
    leadId: string,
    channel: string,
    body: string,
    metadata?: {
      instantly_lead_id?: string | null;
      instantly_email_id?: string | null;
      instantly_account_id?: string | null;
    },
  ): Promise<{ id: string }>;
  fetchLeadContext(tenantId: string, leadId: string): Promise<LeadContext>;
  fetchConversationHistory(tenantId: string, leadId: string): Promise<ConversationHistoryItem[]>;
  countInboundReplies(tenantId: string, leadId: string): Promise<number>;
  hasCheckoutAction(tenantId: string, leadId: string): Promise<boolean>;
  updateConversationClassification(
    tenantId: string,
    conversationId: string,
    update: ConversationClassificationUpdate,
  ): Promise<void>;
  advanceLeadToReplied(tenantId: string, leadId: string): Promise<void>;
  archiveLeadForSuppression(tenantId: string, leadId: string): Promise<void>;
  conversationExists(tenantId: string, conversationId: string): Promise<boolean>;
  fetchCheckoutLead(tenantId: string, leadId: string): Promise<CheckoutLead>;
  hasCompletedPayment(tenantId: string, leadId: string): Promise<boolean>;
  recordCompletedPayment(input: CompletedPaymentInput): Promise<CompletedPaymentResult>;
};

export type EscalationService = {
  escalate(input: EscalationInput): Promise<void>;
};

export type ClaudeClassifier = {
  classifyReply(input: {
    leadContext: LeadContext;
    conversationHistory: ConversationHistoryItem[];
    inboundBody: string;
  }): Promise<ClaudeReplyClassification>;
};

export type ReplyQueue = {
  add(name: string, payload: SendReplyJob, options?: { jobId: string }): Promise<unknown>;
};

type HandlerDeps = {
  queries?: ReplyQueries;
  claude?: ClaudeClassifier;
  queue?: ReplyQueue;
  escalation?: EscalationService;
  stripe?: {
    createCheckoutSession(input: { tenant_id: string; lead_id: string }): Promise<{ id: string; url: string }>;
  };
};

const escalationPhrases = ["call me", "speak to", "too expensive", "can you do a deal", "talk to a human"];

function containsHardEscalationPhrase(body: string): boolean {
  const normalized = body.toLowerCase();

  return escalationPhrases.some((phrase) => normalized.includes(phrase));
}

function escalationUpdate(
  reason: string,
  classification?: Partial<ClaudeReplyClassification>,
): ConversationClassificationUpdate {
  return {
    intent: classification?.intent ?? null,
    intent_confidence: classification?.confidence ?? null,
    agent_action: "escalate",
    prompt_version: classification?.prompt_version ?? null,
    model_used: classification?.model_used ?? null,
    cost_usd: classification?.cost_usd ?? 0,
    escalated: true,
    escalation_reason: reason,
  };
}

function classificationUpdate(classification: ClaudeReplyClassification): ConversationClassificationUpdate {
  return {
    intent: classification.intent,
    intent_confidence: classification.confidence,
    agent_action: classification.action,
    prompt_version: classification.prompt_version,
    model_used: classification.model_used,
    cost_usd: classification.cost_usd,
    escalated: classification.action === "escalate",
    escalation_reason: classification.escalation_reason,
  };
}

export async function handleProcessReply(
  job: ProcessReplyJob,
  deps: HandlerDeps = {},
): Promise<{ action: string; conversation_id: string }> {
  const db = deps.queries ?? defaultQueries;
  const claude = deps.claude ?? claudeAgent;
  const queue = deps.queue;
  const escalation = deps.escalation ?? { escalate: defaultEscalate };

  const conversation = await db.insertInboundConversation(job.tenant_id, job.lead_id, job.channel, job.body, {
    instantly_lead_id: job.instantly_lead_id ?? null,
    instantly_email_id: job.instantly_email_id ?? null,
    instantly_account_id: job.instantly_account_id ?? null,
  });
  await db.advanceLeadToReplied(job.tenant_id, job.lead_id);

  if (containsHardEscalationPhrase(job.body)) {
    await db.updateConversationClassification(
      job.tenant_id,
      conversation.id,
      escalationUpdate("hardcoded_escalation_phrase"),
    );
    await escalation.escalate({
      tenant_id: job.tenant_id,
      lead_id: job.lead_id,
      conversation_id: conversation.id,
      reason: "hardcoded_escalation_phrase",
      inbound_body: job.body,
    });

    return { action: "escalate", conversation_id: conversation.id };
  }

  const [inboundCount, checkoutSent] = await Promise.all([
    db.countInboundReplies(job.tenant_id, job.lead_id),
    db.hasCheckoutAction(job.tenant_id, job.lead_id),
  ]);

  if (inboundCount >= 3 && !checkoutSent) {
    await db.updateConversationClassification(
      job.tenant_id,
      conversation.id,
      escalationUpdate("three_inbound_replies_without_checkout"),
    );
    await escalation.escalate({
      tenant_id: job.tenant_id,
      lead_id: job.lead_id,
      conversation_id: conversation.id,
      reason: "three_inbound_replies_without_checkout",
      inbound_body: job.body,
    });

    return { action: "escalate", conversation_id: conversation.id };
  }

  const [leadContext, conversationHistory] = await Promise.all([
    db.fetchLeadContext(job.tenant_id, job.lead_id),
    db.fetchConversationHistory(job.tenant_id, job.lead_id),
  ]);
  const classification = await claude.classifyReply({
    leadContext,
    conversationHistory,
    inboundBody: job.body,
  });

  if (classification.confidence < 60) {
    await db.updateConversationClassification(
      job.tenant_id,
      conversation.id,
      escalationUpdate("low_confidence", classification),
    );
    await escalation.escalate({
      tenant_id: job.tenant_id,
      lead_id: job.lead_id,
      conversation_id: conversation.id,
      reason: "low_confidence",
      inbound_body: job.body,
    });

    return { action: "escalate", conversation_id: conversation.id };
  }

  await db.updateConversationClassification(job.tenant_id, conversation.id, classificationUpdate(classification));

  if (classification.action === "escalate") {
    await escalation.escalate({
      tenant_id: job.tenant_id,
      lead_id: job.lead_id,
      conversation_id: conversation.id,
      reason: classification.escalation_reason ?? "claude_escalate",
      inbound_body: job.body,
    });
  }

  if (classification.action === "suppress") {
    await db.archiveLeadForSuppression(job.tenant_id, job.lead_id);
  }

  if ((classification.action === "reply" || classification.action === "send_checkout") && queue) {
    await queue.add(
      "send_reply",
      {
        job_type: "send_reply",
        tenant_id: job.tenant_id,
        lead_id: job.lead_id,
        conversation_id: conversation.id,
        channel: job.channel,
        action: classification.action,
        body: classification.reply_body,
        instantly_lead_id: null,
        stripe_session_url: null,
      },
      { jobId: `send_reply:${job.tenant_id}:${conversation.id}` },
    );
  }

  return { action: classification.action, conversation_id: conversation.id };
}

export async function handleSendReply(
  job: SendReplyJob,
  deps: Pick<HandlerDeps, "queries" | "stripe"> = {},
): Promise<{ action: "noop"; conversation_id: string; stripe_session_url?: string }> {
  const db = deps.queries ?? defaultQueries;
  const stripe = deps.stripe ?? stripePayments;

  if (!job.conversation_id) {
    throw new Error("conversation_id is required");
  }

  const exists = await db.conversationExists(job.tenant_id, job.conversation_id);
  if (!exists) {
    throw new Error("conversation_id was not found");
  }

  if (job.action === "send_checkout") {
    const session = await stripe.createCheckoutSession({
      tenant_id: job.tenant_id,
      lead_id: job.lead_id,
    });

    return {
      action: "noop",
      conversation_id: job.conversation_id,
      stripe_session_url: session.url,
    };
  }

  return { action: "noop", conversation_id: job.conversation_id };
}

export async function handleRetryCheckout(
  job: RetryCheckoutJob,
  deps: Pick<HandlerDeps, "queries"> = {},
): Promise<{ action: "noop"; reason: "payment_completed" | "retry_deferred" }> {
  const db = deps.queries ?? defaultQueries;
  const completed = await db.hasCompletedPayment(job.tenant_id, job.lead_id);

  if (completed) {
    return { action: "noop", reason: "payment_completed" };
  }

  return { action: "noop", reason: "retry_deferred" };
}
