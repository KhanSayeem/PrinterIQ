export type ReplyChannel = "email" | "sms";

export type ProcessReplyJob = {
  job_type: "process_reply";
  tenant_id: string;
  lead_id: string;
  channel: ReplyChannel;
  direction: "inbound";
  body: string;
  raw_webhook: Record<string, unknown>;
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

export type ConversationHistoryItem = {
  direction: string;
  channel: string;
  body: string;
  intent: string | null;
  agent_action: string | null;
  created_at: string;
};
