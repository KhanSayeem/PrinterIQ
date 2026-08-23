import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/webhook.js";
import { handleRetryCheckout } from "../src/handler.js";
import { createCheckoutSession, handleStripeWebhook, handleStripeWebhookEvent } from "../src/stripe.js";
import { offerPriceAud, offerPriceCents } from "../src/offer.js";

describe("offer price", () => {
  // The email copy quoted $1,499 while checkout charged a hardcoded $1,500,
  // so a lead would have been billed more than they were quoted. The price now
  // comes from one place, OFFER_PRICE_AUD, shared by checkout and the prompts.
  it("defaults to the quoted price", () => {
    expect(offerPriceAud()).toBe(1499);
    expect(offerPriceCents()).toBe(149900);
  });

  it("is driven by OFFER_PRICE_AUD", () => {
    vi.stubEnv("OFFER_PRICE_AUD", "1799");

    expect(offerPriceAud()).toBe(1799);
    expect(offerPriceCents()).toBe(179900);
  });

  it("rejects a non-numeric OFFER_PRICE_AUD rather than silently charging a default", () => {
    vi.stubEnv("OFFER_PRICE_AUD", "1,499");

    expect(() => offerPriceAud()).toThrow(/OFFER_PRICE_AUD/);
  });

  it("charges the quoted price on the checkout session", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://checkout" });

    await createCheckoutSession(
      { tenant_id: tenantId, lead_id: leadId, conversation_id: conversationId },
      {
        queries: checkoutQueries(),
        stripe: { checkout: { sessions: { create } } } as never,
      },
    );

    const params = create.mock.calls[0][0];
    expect(params.line_items[0].price_data.unit_amount).toBe(149900);
  });
});

function checkoutQueries(overrides: Record<string, unknown> = {}) {
  return {
    fetchCheckoutLead: vi.fn().mockResolvedValue({
      email: "owner@example.com",
      business_name: "Test Plumbing",
    }),
    recordCompletedPayment: vi.fn(),
    fetchCheckoutSession: vi.fn().mockResolvedValue(null),
    recordCheckoutSession: vi
      .fn()
      .mockImplementation(
        async (_tenant: string, _lead: string, _conversation: string, id: string, url: string) => ({ id, url }),
      ),
    ...overrides,
  } as never;
}

// The BullMQ jobId dedupes enqueues, but a retry after a partial failure would
// otherwise mint a second Stripe session and hand the same lead two payment
// links. The payment side already guards this way via should_send_welcome.
describe("checkout session idempotency", () => {
  it("reuses the session already stored for the lead and never calls Stripe again", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cs_second", url: "https://checkout/second" });
    const queries = checkoutQueries({
      fetchCheckoutSession: vi.fn().mockResolvedValue({ id: "cs_first", url: "https://checkout/first" }),
    }) as unknown as {
      fetchCheckoutSession: ReturnType<typeof vi.fn>;
      fetchCheckoutLead: ReturnType<typeof vi.fn>;
      recordCheckoutSession: ReturnType<typeof vi.fn>;
    };

    const result = await createCheckoutSession(
      { tenant_id: tenantId, lead_id: leadId, conversation_id: conversationId },
      { queries: queries as never, stripe: { checkout: { sessions: { create } } } as never },
    );

    expect(result).toEqual({ id: "cs_first", url: "https://checkout/first" });
    expect(create).not.toHaveBeenCalled();
    expect(queries.recordCheckoutSession).not.toHaveBeenCalled();
    expect(queries.fetchCheckoutSession).toHaveBeenCalledWith(tenantId, leadId);
  });

  it("persists a newly created session against the conversation", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cs_first", url: "https://checkout/first" });
    const queries = checkoutQueries() as unknown as { recordCheckoutSession: ReturnType<typeof vi.fn> };

    const result = await createCheckoutSession(
      { tenant_id: tenantId, lead_id: leadId, conversation_id: conversationId },
      { queries: queries as never, stripe: { checkout: { sessions: { create } } } as never },
    );

    expect(queries.recordCheckoutSession).toHaveBeenCalledWith(
      tenantId,
      leadId,
      conversationId,
      "cs_first",
      "https://checkout/first",
    );
    expect(result).toEqual({ id: "cs_first", url: "https://checkout/first" });
  });

  it("returns the session that actually won the write when another worker got there first", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cs_loser", url: "https://checkout/loser" });
    const queries = checkoutQueries({
      recordCheckoutSession: vi.fn().mockResolvedValue({ id: "cs_winner", url: "https://checkout/winner" }),
    });

    const result = await createCheckoutSession(
      { tenant_id: tenantId, lead_id: leadId, conversation_id: conversationId },
      { queries: queries as never, stripe: { checkout: { sessions: { create } } } as never },
    );

    expect(result).toEqual({ id: "cs_winner", url: "https://checkout/winner" });
  });

  it("looks for an existing session before it asks Stripe for a new one", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cs_first", url: "https://checkout/first" });
    const queries = checkoutQueries() as unknown as { fetchCheckoutSession: ReturnType<typeof vi.fn> };

    await createCheckoutSession(
      { tenant_id: tenantId, lead_id: leadId, conversation_id: conversationId },
      { queries: queries as never, stripe: { checkout: { sessions: { create } } } as never },
    );

    expect(queries.fetchCheckoutSession.mock.invocationCallOrder[0]!).toBeLessThan(
      create.mock.invocationCallOrder[0]!,
    );
  });
});

const tenantId = "11111111-1111-4111-8111-111111111111";
const leadId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const instantlyWebhookIds = {
  reply: "reply-token",
  bounced: "bounced-token",
  unsubbed: "unsubbed-token",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

function checkoutCompletedEvent(sessionId = "cs_test_123") {
  return {
    id: "evt_test_123",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        payment_intent: "pi_test_123",
        amount_total: 150000,
        currency: "aud",
        payment_status: "paid",
        customer_details: {
          email: "owner@example.com",
        },
        metadata: {
          tenant_id: tenantId,
          lead_id: leadId,
          business_name: "Test Plumbing",
        },
      },
    },
  };
}

describe("Stripe webhook handling", () => {
  it("records a new completed checkout and sends the welcome email once", async () => {
    const queries = {
      recordCompletedPayment: vi.fn().mockResolvedValue({
        should_send_welcome: true,
        lead_id: leadId,
        tenant_id: tenantId,
        business_name: "Test Plumbing",
        email: "owner@example.com",
      }),
    };
    const resend = {
      sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
    };

    const result = await handleStripeWebhookEvent(checkoutCompletedEvent(), { queries, resend });

    expect(result).toEqual({ handled: true });
    expect(queries.recordCompletedPayment).toHaveBeenCalledWith({
      tenant_id: tenantId,
      lead_id: leadId,
      stripe_session_id: "cs_test_123",
      stripe_payment_intent_id: "pi_test_123",
      amount_aud: 1500,
    });
    expect(resend.sendWelcomeEmail).toHaveBeenCalledWith({
      tenant_id: tenantId,
      lead_id: leadId,
      business_name: "Test Plumbing",
      email: "owner@example.com",
    });
  });

  it("returns handled for duplicate checkout webhooks without sending a duplicate email", async () => {
    const queries = {
      recordCompletedPayment: vi.fn().mockResolvedValue({
        should_send_welcome: false,
        lead_id: leadId,
        tenant_id: tenantId,
        business_name: "Test Plumbing",
        email: "owner@example.com",
      }),
    };
    const resend = {
      sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
    };

    const result = await handleStripeWebhookEvent(checkoutCompletedEvent(), { queries, resend });

    expect(result).toEqual({ handled: true });
    expect(resend.sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it("does not fulfill checkout sessions until Stripe marks payment_status as paid", async () => {
    const queries = {
      recordCompletedPayment: vi.fn(),
    };
    const resend = {
      sendWelcomeEmail: vi.fn(),
    };
    const event = checkoutCompletedEvent();
    event.data.object.payment_status = "unpaid";

    const result = await handleStripeWebhookEvent(event, { queries, resend });

    expect(result).toEqual({ handled: true });
    expect(queries.recordCompletedPayment).not.toHaveBeenCalled();
    expect(resend.sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it("fulfills delayed checkout sessions when Stripe sends async payment succeeded", async () => {
    const queries = {
      recordCompletedPayment: vi.fn().mockResolvedValue({
        should_send_welcome: true,
        lead_id: leadId,
        tenant_id: tenantId,
        business_name: "Test Plumbing",
        email: "owner@example.com",
      }),
    };
    const resend = {
      sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
    };
    const event = checkoutCompletedEvent("cs_async_123");
    event.type = "checkout.session.async_payment_succeeded";

    const result = await handleStripeWebhookEvent(event, { queries, resend });

    expect(result).toEqual({ handled: true });
    expect(queries.recordCompletedPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: tenantId,
        lead_id: leadId,
        stripe_session_id: "cs_async_123",
      }),
    );
    expect(resend.sendWelcomeEmail).toHaveBeenCalledOnce();
  });

  it("returns 400 for invalid Stripe signatures and performs no DB or email work", async () => {
    const queries = {
      recordCompletedPayment: vi.fn(),
    };
    const resend = {
      sendWelcomeEmail: vi.fn(),
    };
    const server = buildServer({
      instantlyWebhookIds,
      queue: { add: vi.fn().mockResolvedValue(undefined) },
      stripeWebhookSecret: "whsec_test",
      stripe: {
        handleWebhook: vi.fn().mockRejectedValue(new Error("invalid stripe signature")),
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "bad-signature",
      },
      payload: JSON.stringify({ id: "evt_bad" }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid stripe signature" });
    expect(queries.recordCompletedPayment).not.toHaveBeenCalled();
    expect(resend.sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it("checks Stripe signatures before JSON parsing errors", async () => {
    const server = buildServer({
      instantlyWebhookIds,
      queue: { add: vi.fn().mockResolvedValue(undefined) },
      stripeWebhookSecret: "whsec_test",
      stripe: {
        handleWebhook: vi.fn().mockRejectedValue(new Error("invalid stripe signature")),
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "bad-signature",
      },
      payload: "{",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid stripe signature" });
  });

  it("uses the STRIPE_MODE-specific webhook secret when no explicit secret is provided", async () => {
    vi.stubEnv("STRIPE_MODE", "live");
    vi.stubEnv("STRIPE_LIVE_WEBHOOK_SECRET", "whsec_live");

    const constructEvent = vi.fn().mockReturnValue({
      type: "customer.created",
      data: { object: {} },
    });

    const result = await handleStripeWebhook("{}", "signature", {
      stripe: {
        webhooks: { constructEvent },
      } as never,
    });

    expect(result).toEqual({ handled: false });
    expect(constructEvent).toHaveBeenCalledWith("{}", "signature", "whsec_live");
  });
});

describe("retry_checkout handler", () => {
  it("checks completed payments first and no-ops when the lead already paid", async () => {
    const queries = {
      hasCompletedPayment: vi.fn().mockResolvedValue(true),
    };

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

    expect(result).toEqual({ action: "noop", reason: "payment_completed" });
    expect(queries.hasCompletedPayment).toHaveBeenCalledWith(tenantId, leadId);
  });
});
