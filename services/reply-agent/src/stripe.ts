import Stripe from "stripe";
import { queries as defaultQueries } from "./db/queries.js";
import { resendClient, type WelcomeEmailSender } from "./resend.js";
import type { CheckoutLead, CompletedPaymentInput, CompletedPaymentResult } from "./types.js";

const CHECKOUT_AMOUNT_CENTS = 150000;
const CHECKOUT_AMOUNT_AUD = 1500;

export type PaymentQueries = {
  fetchCheckoutLead(tenantId: string, leadId: string): Promise<CheckoutLead>;
  recordCompletedPayment(input: CompletedPaymentInput): Promise<CompletedPaymentResult>;
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

function stripeClient(): Stripe {
  return new Stripe(requiredEnv("STRIPE_SECRET_KEY"));
}

function checkoutUrlEnv(name: string): string {
  return process.env[name] ?? "https://printeriq.com/checkout";
}

export async function createCheckoutSession(
  input: { tenant_id: string; lead_id: string },
  deps: Pick<StripeDeps, "queries" | "stripe"> = {},
): Promise<{ id: string; url: string }> {
  const db = deps.queries ?? defaultQueries;
  const stripe = deps.stripe ?? stripeClient();
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
          unit_amount: CHECKOUT_AMOUNT_CENTS,
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

  return { id: session.id, url: session.url };
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
    amount_aud: (session.amount_total ?? CHECKOUT_AMOUNT_CENTS) / 100,
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
  const secret = deps.webhookSecret ?? requiredEnv("STRIPE_WEBHOOK_SECRET");
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);

  return handleStripeWebhookEvent(event, deps);
}

export const stripePayments = {
  createCheckoutSession,
  handleWebhook: handleStripeWebhook,
};
