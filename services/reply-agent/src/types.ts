export type ReplyChannel = "email" | "sms";

/** One outreach send, reduced to the ids needed to act on an Instantly event.
 *
 * `instantly_lead_id` is non-null in every row this shape is read from: it is
 * what both suppression writes match on, and a send without it was reserved
 * and never completed.
 */
export type OutreachTarget = {
  tenant_id: string;
  lead_id: string;
  instantly_lead_id: string;
};

export type ProcessReplyJob = {
  job_type: "process_reply";
  tenant_id: string;
  lead_id: string;
  channel: ReplyChannel;
  direction: "inbound";
  body: string;
  raw_webhook: Record<string, unknown>;
  instantly_lead_id?: string | null;
  instantly_email_id?: string | null;
  instantly_account_id?: string | null;
};

export type SendReplyJob = {
  job_type: "send_reply";
  tenant_id: string;
  lead_id: string;
  conversation_id?: string | null;
  channel: ReplyChannel;
  action: "reply" | "send_checkout";
  body: string;
  instantly_lead_id?: string | null;
  stripe_session_url?: string | null;
};

export type RetryCheckoutJob = {
  job_type: "retry_checkout";
  tenant_id: string;
  lead_id: string;
  original_session: string;
  scheduled_at: string;
};

export type ClaudeReplyClassification = {
  intent: "interested" | "question" | "objection" | "not_interested" | "unsubscribe" | "abusive";
  confidence: number;
  reply_body: string;
  action: "reply" | "send_checkout" | "escalate" | "suppress";
  escalation_reason: string | null;
  prompt_version: string;
  model_used: string;
  cost_usd: number;
};

export type ConversationClassificationUpdate = {
  intent: string | null;
  intent_confidence: number | null;
  agent_action: string;
  prompt_version: string | null;
  model_used: string | null;
  cost_usd: number;
  escalated: boolean;
  escalation_reason: string | null;
};

export type LeadContext = {
  lead: Record<string, unknown>;
  top_weakness: string | null;
  tenant_voice_prompt: string | null;
};

export type CheckoutLead = {
  tenant_id: string;
  lead_id: string;
  business_name: string | null;
  email: string;
};

export type CompletedPaymentInput = {
  tenant_id: string;
  lead_id: string;
  stripe_session_id: string;
  stripe_payment_intent_id: string | null;
  amount_aud: number;
};

export type CompletedPaymentResult = CheckoutLead & {
  should_send_welcome: boolean;
};

export type EscalationContext = {
  tenant_id: string;
  lead_id: string;
  first_name: string | null;
  last_name: string | null;
  business_name: string | null;
  city: string | null;
  email: string;
  instantly_lead_id: string;
  instantly_campaign_id: string;
};

/** What a lead has done with the preview page that was sent to them.
 *
 * `preview_seen` is the operator-facing question: with open and click
 * tracking off, this is the only per-lead evidence that an email arrived and
 * was read. `view_count` separates a glance from a lead who came back.
 */
export type PreviewViewState = {
  lead_id: string;
  first_viewed_at: Date | null;
  last_viewed_at: Date | null;
  view_count: number;
  preview_seen: boolean;
};

export type ConversationHistoryItem = {
  direction: string;
  channel: string;
  body: string;
  intent: string | null;
  agent_action: string | null;
  created_at: string;
};
