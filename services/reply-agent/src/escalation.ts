import { queries as defaultQueries } from "./db/queries.js";
import type { EscalationContext } from "./types.js";

const DEFAULT_OPERATOR_ESCALATION_PHONE = "+61400457006";
const DEFAULT_DASHBOARD_URL = "http://localhost:3000";
const TWILIO_BASE_URL = "https://api.twilio.com";
const INSTANTLY_BASE_URL = "https://api.instantly.ai";

export type EscalationInput = {
  tenant_id: string;
  lead_id: string;
  conversation_id: string;
  reason: string;
  inbound_body: string;
};

export type EscalationQueries = {
  fetchEscalationContext(tenantId: string, leadId: string): Promise<EscalationContext>;
};

export type SmsClient = {
  sendSms(input: { to: string; body: string }): Promise<void>;
};

export type InstantlyClient = {
  pauseLead(instantlyLeadId: string, instantlyCampaignId: string): Promise<void>;
};

type EscalationLogger = {
  error(context: Record<string, unknown>, message: string): void;
};

type EscalationDeps = {
  queries?: EscalationQueries;
  sms?: SmsClient;
  instantly?: InstantlyClient;
  logger?: EscalationLogger;
  dashboardUrl?: string;
};

class MissingEnvError extends Error {}

/** The number the operator escalation SMS is sent to.
 *
 * ESCALATION_PHONE was already present in the deployed environment while this
 * module ignored it in favour of a hardcoded constant, so changing the number
 * in .env had no effect and nothing said so. Read at call time, not at module
 * load, so a PM2 restart picks up a change. The constant remains as a fallback
 * so an unset or blank variable cannot page an empty number.
 */
export function operatorEscalationPhone(): string {
  const configured = process.env.ESCALATION_PHONE?.trim();
  return configured ? configured : DEFAULT_OPERATOR_ESCALATION_PHONE;
}

export class TwilioSmsClient implements SmsClient {
  constructor(
    private readonly accountSid = process.env.TWILIO_ACCOUNT_SID,
    private readonly authToken = process.env.TWILIO_AUTH_TOKEN,
    private readonly fromNumber = process.env.TWILIO_FROM_NUMBER,
    private readonly baseUrl = TWILIO_BASE_URL,
  ) {}

  async sendSms(input: { to: string; body: string }): Promise<void> {
    if (!this.accountSid || !this.authToken) {
      throw new MissingEnvError("Missing Twilio credentials");
    }
    if (!this.fromNumber) {
      throw new MissingEnvError("Missing env var: TWILIO_FROM_NUMBER");
    }

    const body = new URLSearchParams({
      To: input.to,
      From: this.fromNumber,
      Body: input.body,
    });

    const response = await fetch(
      `${this.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
    );

    if (!response.ok) {
      throw new Error(`Twilio SMS send failed with ${response.status}; response body omitted`);
    }
  }
}

export class InstantlyHttpClient implements InstantlyClient {
  constructor(
    private readonly apiKey = process.env.INSTANTLY_API_KEY,
    private readonly baseUrl = INSTANTLY_BASE_URL,
    private readonly pausedListId = process.env.INSTANTLY_PAUSED_LIST_ID,
  ) {}

  async pauseLead(instantlyLeadId: string, instantlyCampaignId: string): Promise<void> {
    if (!this.apiKey) {
      throw new MissingEnvError("Missing env var: INSTANTLY_API_KEY");
    }
    if (!this.pausedListId) {
      throw new MissingEnvError("Missing env var: INSTANTLY_PAUSED_LIST_ID");
    }

    const response = await fetch(`${this.baseUrl}/api/v2/leads/move`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ids: [instantlyLeadId],
        campaign: instantlyCampaignId,
        to_list_id: this.pausedListId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Instantly lead pause failed with ${response.status}; response body omitted`);
    }
  }
}

export async function escalate(input: EscalationInput, deps: EscalationDeps = {}): Promise<void> {
  const db = deps.queries ?? defaultQueries;
  const sms = deps.sms ?? new TwilioSmsClient();
  const instantly = deps.instantly ?? new InstantlyHttpClient();
  const logger = deps.logger ?? console;
  const dashboardUrl = (deps.dashboardUrl ?? process.env.DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL).replace(/\/+$/, "");

  const context = await db.fetchEscalationContext(input.tenant_id, input.lead_id);
  const body = formatEscalationSms(context, input.reason, input.inbound_body, dashboardUrl);

  await sms.sendSms({
    to: operatorEscalationPhone(),
    body,
  });

  try {
    await instantly.pauseLead(context.instantly_lead_id, context.instantly_campaign_id);
  } catch (error) {
    logger.error(
      {
        tenant_id: input.tenant_id,
        lead_id: input.lead_id,
        conversation_id: input.conversation_id,
        error: serializeError(error),
      },
      "Instantly lead pause failed after escalation SMS succeeded",
    );
    throw new Error("Instantly unavailable");
  }
}

function formatEscalationSms(
  context: EscalationContext,
  reason: string,
  inboundBody: string,
  dashboardUrl: string,
): string {
  const businessName = context.business_name ?? "Unknown business";
  const city = context.city ?? "Unknown city";
  const leadName = maskLeadName(context.first_name, context.last_name);
  const truncatedBody = maskSnippetPii(inboundBody).slice(0, 100);

  return `Reply from ${businessName} (${city}) needs attention: "${truncatedBody}". Lead: ${leadName}. Reason: ${reason}. View: ${dashboardUrl}/leads/${context.lead_id}`;
}

function maskLeadName(firstName: string | null, lastName: string | null): string {
  const masked = [firstName, lastName]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => `${value.trim()[0]}***`);
  return masked.length > 0 ? masked.join(" ") : "Unknown lead";
}

/** Replace obvious emails and phone numbers in free text before it is logged.
 *
 * Exported so every path that logs third-party text uses the same masking
 * rather than each one reinventing it.
 */
export function maskSnippetPii(snippet: string): string {
  return snippet
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?\d[\s().-]*){8,}\d/g, "[phone]");
}

function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: maskSnippetPii(error.message),
    };
  }
  return {
    name: "UnknownError",
    message: maskSnippetPii(String(error)),
  };
}
