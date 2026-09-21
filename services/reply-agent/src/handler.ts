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
import {
  escalate as defaultEscalate,
  InstantlyHttpClient,
  type EscalationInput,
} from "./escalation.js";
import { stripePayments } from "./stripe.js";
import { createHash } from "node:crypto";

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
  findOutreachTargetByLeadId(
    tenantId: string,
    leadId: string,
  ): Promise<{ instantly_lead_id: string } | null>;
  recordInstantlyUnsubscribe(tenantId: string, leadId: string, instantlyLeadId: string): Promise<void>;
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

export type SuppressionClient = {
  blockEmail(email: string): Promise<void>;
};

type HandlerDeps = {
  queries?: ReplyQueries;
  instantly?: SuppressionClient;
  claude?: ClaudeClassifier;
  queue?: ReplyQueue;
  escalation?: EscalationService;
  stripe?: {
    createCheckoutSession(input: {
      tenant_id: string;
      lead_id: string;
      conversation_id: string;
    }): Promise<{ id: string; url: string }>;
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

/** The key that makes one inbound reply one row, however often the job runs.
 *
 * This insert is the first thing `handleProcessReply` does, deliberately: the
 * lead's own words are recorded before anything that can fail. But a BullMQ
 * retry re-runs the whole handler, and on 2026-09-16 that turned one reply
 * into three rows, which the three-replies rule below then read as three
 * replies from the lead.
 *
 * The Instantly email id is the right key when the webhook carries one, since
 * it is unique per email. It is often absent, and then the key is a hash of
 * the tenant, lead, channel and body. The tradeoff, stated rather than hidden:
 * a lead who sends a byte-identical message twice is recorded once. That is a
 * better failure than one message counted three times, and it disappears
 * whenever Instantly sends the email id.
 */
export function inboundDedupeKey(job: ProcessReplyJob): string {
  if (job.instantly_email_id) {
    return `reply:email:${job.instantly_email_id}`;
  }

  const digest = createHash("sha256")
    .update(JSON.stringify([job.tenant_id, job.lead_id, job.channel, job.body]))
    .digest("hex");

  return `reply:body:${digest}`;
}

/**
 * A reply asking to be removed counts exactly like a click on the unsubscribe
 * link, and then some.
 *
 * Until 2026-09-22 this only archived the lead. Beyond Training replied
 * "Please remove me from your mailing list" on 17 September: the send was
 * never marked unsubscribed and the address was never blocked, so another
 * campaign could have emailed her again. Australian law gives five business
 * days to honour that.
 *
 * Every step is idempotent, so a retry after a failed block repeats nothing
 * harmful: the unsubscribe keeps its first timestamp (COALESCE), archiving an
 * archived lead is a no-op, and a second block list entry for one address is
 * harmless. The block is last and allowed to throw, so a failure fails the job
 * and BullMQ retries it, rather than leaving the address half suppressed.
 */
async function suppressLead(
  job: ProcessReplyJob,
  leadContext: LeadContext,
  db: ReplyQueries,
  instantly: SuppressionClient,
): Promise<void> {
  const target = await db.findOutreachTargetByLeadId(job.tenant_id, job.lead_id);

  if (target) {
    await db.recordInstantlyUnsubscribe(job.tenant_id, job.lead_id, target.instantly_lead_id);
  } else {
    // Never went out through Instantly, so there is no send to mark.
    await db.archiveLeadForSuppression(job.tenant_id, job.lead_id);
  }

  const email = leadContext.lead.email;
  if (typeof email === "string" && email.includes("@")) {
    await instantly.blockEmail(email);
  }
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
    dedupe_key: inboundDedupeKey(job),
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
    await suppressLead(job, leadContext, db, deps.instantly ?? new InstantlyHttpClient());
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
      conversation_id: job.conversation_id,
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
