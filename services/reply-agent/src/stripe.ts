import Stripe from "stripe";
import { queries as defaultQueries } from "./db/queries.js";
import { resendClient, type WelcomeEmailSender } from "./resend.js";
import type { CheckoutLead, CompletedPaymentInput, CompletedPaymentResult } from "./types.js";
import { offerPriceCents } from "./offer.js";


export type PaymentQueries = {
  fetchCheckoutLead(tenantId: string, leadId: string): Promise<CheckoutLead>;
  recordCompletedPayment(input: CompletedPaymentInput): Promise<CompletedPaymentResult>;
  fetchCheckoutSession(tenantId: string, leadId: string): Promise<{ id: string; url: string } | null>;
  recordCheckoutSession(
    tenantId: string,
    leadId: string,
    conversationId: string,
    sessionId: string,
    sessionUrl: string,
  ): Promise<{ id: string; url: string }>;
};

export type StripeCheckoutClient = {
  checkout: {
    sessions: {
      create(input: Stripe.Checkout.SessionCreateParams): Promise<{ id: string; url: string | null }>;
    };
  };
};

export type StripeWebhookClient = {
  webhooks: {
    constructEvent(rawBody: string | Buffer, signature: string, secret: string): Stripe.Event;
  };
};

type StripeDeps = {
  queries?: PaymentQueries;
  resend?: WelcomeEmailSender;
  stripe?: StripeCheckoutClient & StripeWebhookClient;
  webhookSecret?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function stripeMode(): "test" | "live" {
  return process.env.STRIPE_MODE === "test" ? "test" : "live";
}

function stripeEnv(suffix: "SECRET_KEY" | "WEBHOOK_SECRET"): string {
  const modeSpecificName = `STRIPE_${stripeMode().toUpperCase()}_${suffix}`;
  const modeSpecificValue = process.env[modeSpecificName];
  if (modeSpecificValue) {
    return modeSpecificValue;
  }

  return requiredEnv(`STRIPE_${suffix}`);
}

function stripeClient(): Stripe {
  return new Stripe(stripeEnv("SECRET_KEY"));
}

function checkoutUrlEnv(name: string): string {
  return process.env[name] ?? "https://presciaiq.com/checkout";
}

/** Create the lead's checkout session, or hand back the one they already have.
 *
 * Idempotency guard. The BullMQ jobId dedupes *enqueues*, but a job that fails
 * after Stripe returned a session is retried and would mint a second one, so
 * the same lead could receive two live payment links. The session is persisted
 * against the conversation and looked up per lead before Stripe is called,
 * mirroring how the payment side guards double-onboarding with
 * `should_send_welcome`. `conversation_id` is required rather than optional on
 * purpose: an optional key would silently disable the guard at any call site
 * that forgot to pass it.
 *
 * `fetchCheckoutSession` re-applies the `status = 'replied'` eligibility gate,
 * so a cache hit cannot become a route around suppression: an archived or
 * already paid lead falls through to `fetchCheckoutLead`, which throws before
 * Stripe is called.
 */
export async function createCheckoutSession(
  input: { tenant_id: string; lead_id: string; conversation_id: string },
  deps: Pick<StripeDeps, "queries" | "stripe"> = {},
): Promise<{ id: string; url: string }> {
  const db = deps.queries ?? defaultQueries;
  const stripe = deps.stripe ?? stripeClient();

  const existing = await db.fetchCheckoutSession(input.tenant_id, input.lead_id);
  if (existing) {
    return existing;
  }

  const lead = await db.fetchCheckoutLead(input.tenant_id, input.lead_id);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: lead.email,
    success_url: checkoutUrlEnv("STRIPE_CHECKOUT_SUCCESS_URL"),
    cancel_url: checkoutUrlEnv("STRIPE_CHECKOUT_CANCEL_URL"),
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "aud",
          unit_amount: offerPriceCents(),
          product_data: {
            name: "Done-for-you tradie website",
          },
        },
      },
    ],
    metadata: {
      tenant_id: input.tenant_id,
      lead_id: input.lead_id,
      business_name: lead.business_name ?? "",
    },
  });

  if (!session.url) {
    throw new Error("Stripe checkout session did not include a URL");
  }

  // The write is first-writer-wins, so it returns whichever session is stored,
  // which is not necessarily the one just created. Returning the stored session
  // is what keeps a race from handing the lead two different payment links.
  return db.recordCheckoutSession(
    input.tenant_id,
    input.lead_id,
    input.conversation_id,
    session.id,
    session.url,
  );
}

function paymentIntentId(session: Stripe.Checkout.Session): string | null {
  return typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
}

export async function handleStripeWebhookEvent(
  event: Pick<Stripe.Event, "type" | "data">,
  deps: Pick<StripeDeps, "queries" | "resend"> = {},
): Promise<{ handled: boolean }> {
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return { handled: false };
  }

  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== "paid") {
    return { handled: true };
  }

  const tenantId = session.metadata?.tenant_id;
  const leadId = session.metadata?.lead_id;
  if (!tenantId || !leadId) {
    throw new Error("Stripe session is missing tenant metadata");
  }

  const db = deps.queries ?? defaultQueries;
  const resend = deps.resend ?? resendClient;
  const payment = await db.recordCompletedPayment({
    tenant_id: tenantId,
    lead_id: leadId,
    stripe_session_id: session.id,
    stripe_payment_intent_id: paymentIntentId(session),
    amount_aud: (session.amount_total ?? offerPriceCents()) / 100,
  });

  if (payment.should_send_welcome) {
    await resend.sendWelcomeEmail({
      tenant_id: payment.tenant_id,
      lead_id: payment.lead_id,
      business_name: payment.business_name,
      email: payment.email,
    });
  }

  return { handled: true };
}

export async function handleStripeWebhook(
  rawBody: string | Buffer,
  signature: string,
  deps: StripeDeps = {},
): Promise<{ handled: boolean }> {
  const stripe = deps.stripe ?? stripeClient();
  const secret = deps.webhookSecret ?? stripeEnv("WEBHOOK_SECRET");
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);

  return handleStripeWebhookEvent(event, deps);
}

export const stripePayments = {
  createCheckoutSession,
  handleWebhook: handleStripeWebhook,
};
