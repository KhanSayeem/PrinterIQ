import { describe, expect, it, vi } from "vitest";
import {
  advanceLeadToReplied,
  archiveLeadForSuppression,
  fetchCheckoutSession,
  fetchEscalationContext,
  findOutreachTargetByEmail,
  findOutreachTargetByInstantlyLeadId,
  findOutreachTargetByLeadId,
  hasCompletedPayment,
  insertInboundConversation,
  markConversationEscalated,
  recordCheckoutSession,
  recordInstantlyBounce,
  recordInstantlyUnsubscribe,
  recordCompletedPayment,
} from "../src/db/queries.js";

describe("worker escalation and checkout-session queries", () => {
  it("marks a conversation escalated without rewriting the classifier's agent_action", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ body: "Yep send me the link" }] });

    const result = await markConversationEscalated("tenant-id", "conversation-id", "send_checkout_requires_operator", {
      query,
    });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("UPDATE conversations");
    expect(sql).toContain("escalated = TRUE");
    expect(sql).not.toContain("agent_action");
    expect(sql).toContain("WHERE tenant_id = $1");
    expect(sql).toContain("RETURNING body");
    expect(params).toEqual(["tenant-id", "conversation-id", "send_checkout_requires_operator"]);
    expect(result).toEqual({ body: "Yep send me the link" });
  });

  // An earlier reason such as low_confidence is the truthful record of why the
  // lead was escalated. Overwriting it would destroy the audit trail the rest
  // of this function's design goes out of its way to protect.
  it("keeps an existing escalation_reason instead of overwriting it", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ body: "Yep" }] });

    await markConversationEscalated("tenant-id", "conversation-id", "send_checkout_requires_operator", { query });

    const [sql] = query.mock.calls[0]!;
    expect(sql).toContain("escalation_reason = COALESCE(escalation_reason, $3)");
  });

  // The escalation SMS quotes this row's body back to the operator as the
  // lead's own words, so it must never be one of our outbound drafts.
  it("only reads the body of an inbound conversation", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ body: "Yep" }] });

    await markConversationEscalated("tenant-id", "conversation-id", "reason", { query });

    const [sql] = query.mock.calls[0]!;
    expect(sql).toContain("direction = 'inbound'");
  });

  it("refuses to report an escalation it did not write", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(
      markConversationEscalated("tenant-id", "conversation-id", "send_checkout_requires_operator", { query }),
    ).rejects.toThrow("conversation not found for tenant");
  });

  it("looks up an existing checkout session per lead, scoped by tenant", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "cs_1", url: "https://checkout" }] });

    const result = await fetchCheckoutSession("tenant-id", "lead-id", { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("FROM conversations");
    expect(sql).toContain("WHERE conversations.tenant_id = $1");
    expect(sql).toContain("AND conversations.lead_id = $2");
    expect(sql).toContain("stripe_session_id IS NOT NULL");
    expect(params).toEqual(["tenant-id", "lead-id"]);
    expect(result).toEqual({ id: "cs_1", url: "https://checkout" });
  });

  // Reusing a stored link must not become a way past the suppression flow.
  // The cache hit returns before fetchCheckoutLead, which holds the only other
  // copy of this gate, so an archived or already-paid lead would otherwise get
  // a live payment link back.
  it("will not hand back a session for a lead that is no longer eligible", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await fetchCheckoutSession("tenant-id", "lead-id", { query });

    const [sql] = query.mock.calls[0]!;
    expect(sql).toContain("JOIN leads");
    expect(sql).toContain("leads.status = 'replied'");
    expect(sql).toContain("leads.tenant_id = conversations.tenant_id");
  });

  it("reports no existing checkout session rather than throwing", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(fetchCheckoutSession("tenant-id", "lead-id", { query })).resolves.toBeNull();
  });

  it("stores a checkout session first-writer-wins and returns the stored one", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "cs_winner", url: "https://checkout/winner" }] });

    const result = await recordCheckoutSession(
      "tenant-id",
      "lead-id",
      "conversation-id",
      "cs_loser",
      "https://checkout/loser",
      { query },
    );

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("UPDATE conversations");
    expect(sql).toContain("stripe_session_id = COALESCE(stripe_session_id, $4)");
    expect(sql).toContain("stripe_session_url = COALESCE(stripe_session_url, $5)");
    expect(sql).toContain("WHERE tenant_id = $1");
    expect(params).toEqual(["tenant-id", "lead-id", "conversation-id", "cs_loser", "https://checkout/loser"]);
    expect(result).toEqual({ id: "cs_winner", url: "https://checkout/winner" });
  });

  // A conversation id alone does not prove the row belongs to this lead.
  // Stamping lead B's conversation with lead A's session would credit B's
  // payment to A, because the Stripe metadata carries A's lead_id.
  it("binds the session write to the lead, not just the conversation", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "cs_1", url: "https://checkout" }] });

    await recordCheckoutSession("tenant-id", "lead-id", "conversation-id", "cs_1", "https://checkout", { query });

    const [sql] = query.mock.calls[0]!;
    expect(sql).toContain("AND lead_id = $2");
    expect(sql).toContain("AND id = $3");
  });

  it("refuses to report a session it did not write", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(
      recordCheckoutSession("tenant-id", "lead-id", "conversation-id", "cs_1", "https://checkout", { query }),
    ).rejects.toThrow("conversation not found for tenant and lead");
  });
});

describe("reply-agent DB queries", () => {
  it("inserts inbound conversations only through a tenant-scoped lead lookup", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "conversation-id" }] });

    await insertInboundConversation(
      "tenant-id",
      "lead-id",
      "email",
      "Hi",
      {
        instantly_lead_id: "instantly-lead-123",
        instantly_email_id: "email-uuid-123",
        instantly_account_id: "sender@presciaiq.com",
      },
      { query },
    );

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO conversations");
    expect(sql).toContain("SELECT");
    expect(sql).toContain("FROM leads");
    expect(sql).toContain("WHERE tenant_id = $1");
    expect(sql).toContain("AND id = $2");
    expect(sql).toContain("FROM outreach_sends");
    expect(sql).toContain("outreach_sends.instantly_lead_id = $7");
    expect(params).toEqual([
      "tenant-id",
      "lead-id",
      "email",
      "Hi",
      "email-uuid-123",
      "sender@presciaiq.com",
      "instantly-lead-123",
    ]);
  });

  it("persists Instantly reply metadata on inbound conversations when present", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "conversation-id" }] });

    await insertInboundConversation(
      "tenant-id",
      "lead-id",
      "email",
      "Hi",
      {
        instantly_lead_id: "instantly-lead-123",
        instantly_email_id: "email-uuid-123",
        instantly_account_id: "sender@presciaiq.com",
      },
      { query },
    );

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("instantly_email_id");
    expect(sql).toContain("instantly_account_id");
    expect(sql).toContain("FROM outreach_sends");
    expect(sql).toContain("outreach_sends.instantly_lead_id = $7");
    expect(params).toEqual([
      "tenant-id",
      "lead-id",
      "email",
      "Hi",
      "email-uuid-123",
      "sender@presciaiq.com",
      "instantly-lead-123",
    ]);
  });

  it("fails when the lead does not belong to the tenant", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(
      insertInboundConversation(
        "tenant-id",
        "lead-id",
        "email",
        "Hi",
        {
          instantly_lead_id: "instantly-lead-123",
          instantly_email_id: "email-uuid-123",
          instantly_account_id: "sender@presciaiq.com",
        },
        { query },
      ),
    ).rejects.toThrow("lead not found for tenant");
  });

  it("advances a lead to replied only from contacted within the tenant", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await advanceLeadToReplied("tenant-id", "lead-id", { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("UPDATE leads");
    expect(sql).toMatch(/SET\s+status = 'replied'/);
    expect(sql).toContain("WHERE tenant_id = $1");
    expect(sql).toContain("AND id = $2");
    expect(sql).toContain("AND status = 'contacted'");
    expect(params).toEqual(["tenant-id", "lead-id"]);
  });

  it("archives suppressed leads only from valid pre-payment states within the tenant", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await archiveLeadForSuppression("tenant-id", "lead-id", { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("UPDATE leads");
    expect(sql).toMatch(/SET\s+status = 'archived'/);
    expect(sql).toContain("WHERE tenant_id = $1");
    expect(sql).toContain("AND id = $2");
    expect(sql).toContain("status IN ('qualified', 'contacted', 'replied')");
    expect(params).toEqual(["tenant-id", "lead-id"]);
  });

  it("records Instantly bounces against a tenant-scoped outreach send and archives the lead", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ lead_id: "lead-id" }] });

    await recordInstantlyBounce("tenant-id", "lead-id", "instantly-lead-123", { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("UPDATE outreach_sends");
    expect(sql).toMatch(/SET\s+bounced = TRUE/);
    expect(sql).toContain("WHERE tenant_id = $1");
    expect(sql).toContain("AND lead_id = $2");
    expect(sql).toContain("AND instantly_lead_id = $3");
    expect(sql).toContain("UPDATE leads");
    expect(sql).toMatch(/SET\s+status = 'archived'/);
    expect(sql).toContain("leads.tenant_id = $1");
    expect(sql).toContain("leads.id = $2");
    expect(sql).toContain("leads.status IN ('qualified', 'contacted', 'replied')");
    expect(sql).toContain("EXISTS (SELECT 1 FROM marked_send)");
    expect(params).toEqual(["tenant-id", "lead-id", "instantly-lead-123"]);
  });

  it("records Instantly unsubscribes against a tenant-scoped outreach send and archives the lead", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ lead_id: "lead-id" }] });

    await recordInstantlyUnsubscribe("tenant-id", "lead-id", "instantly-lead-123", { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("UPDATE outreach_sends");
    expect(sql).toMatch(/SET\s+unsubscribed = TRUE/);
    expect(sql).toContain("WHERE tenant_id = $1");
    expect(sql).toContain("AND lead_id = $2");
    expect(sql).toContain("AND instantly_lead_id = $3");
    expect(sql).toContain("UPDATE leads");
    expect(sql).toMatch(/SET\s+status = 'archived'/);
    expect(sql).toContain("leads.tenant_id = $1");
    expect(sql).toContain("leads.id = $2");
    expect(sql).toContain("leads.status IN ('qualified', 'contacted', 'replied')");
    expect(sql).toContain("EXISTS (SELECT 1 FROM marked_send)");
    expect(params).toEqual(["tenant-id", "lead-id", "instantly-lead-123"]);
  });

  it("fails bounce handling when no tenant-scoped Instantly send matches", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(recordInstantlyBounce("tenant-id", "lead-id", "missing-instantly-lead", { query })).rejects.toThrow(
      "outreach send not found for tenant",
    );
  });

  it("records completed payments through a tenant-scoped lead lookup and guarded onboarding update", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          tenant_id: "tenant-id",
          lead_id: "lead-id",
          email: "lead@example.com",
          business_name: "Test Plumbing",
          should_send_welcome: true,
        },
      ],
    });

    await recordCompletedPayment(
      {
        tenant_id: "tenant-id",
        lead_id: "lead-id",
        stripe_session_id: "cs_test",
        stripe_payment_intent_id: "pi_test",
        amount_aud: 1500,
      },
      { query },
    );

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("FROM leads");
    expect(sql).toContain("leads.tenant_id = $1");
    expect(sql).toContain("leads.id = $2");
    expect(sql).toContain("leads.status = 'replied'");
    expect(sql).toContain("payments.stripe_session_id = $3");
    expect(sql).toContain("INSERT INTO payments");
    expect(sql).toContain("tenant_id");
    expect(sql).toContain("ON CONFLICT (stripe_session_id) DO UPDATE");
    expect(sql).toContain("payments.tenant_id = $1");
    expect(sql).toContain("payments.lead_id = $2");
    expect(sql).toContain("onboarding_triggered = FALSE");
    expect(sql).toMatch(/SET\s+status = 'paid'/);
    expect(sql).toContain("leads.status = 'replied'");
    expect(params).toEqual(["tenant-id", "lead-id", "cs_test", "pi_test", 1500]);
  });

  it("checks completed payments within the tenant before retrying checkout", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ exists: true }] });

    const completed = await hasCompletedPayment("tenant-id", "lead-id", { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(completed).toBe(true);
    expect(sql).toContain("FROM payments");
    expect(sql).toContain("tenant_id = $1");
    expect(sql).toContain("lead_id = $2");
    expect(sql).toContain("status = 'completed'");
    expect(params).toEqual(["tenant-id", "lead-id"]);
  });

  it("fetches escalation context through tenant-scoped lead and outreach send filters", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          tenant_id: "tenant-id",
          lead_id: "lead-id",
          first_name: "Brett",
          last_name: "Stone",
          business_name: "Stone Builders",
          city: "Newcastle",
          email: "brett@example.com",
          instantly_lead_id: "instantly-lead-123",
          instantly_campaign_id: "campaign-456",
        },
      ],
    });

    const context = await fetchEscalationContext("tenant-id", "lead-id", { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("FROM leads");
    expect(sql).toContain("WHERE leads.tenant_id = $1");
    expect(sql).toContain("AND leads.id = $2");
    expect(sql).toContain("FROM outreach_sends");
    expect(sql).toContain("outreach_sends.tenant_id = leads.tenant_id");
    expect(sql).toContain("outreach_sends.lead_id = leads.id");
    expect(sql).toContain("outreach_sends.instantly_lead_id IS NOT NULL");
    expect(sql).toContain("outreach_sends.instantly_campaign_id");
    expect(sql).toContain("outreach_sends.sent_at DESC NULLS LAST");
    expect(sql).toContain("outreach_sends.created_at DESC");
    expect(sql).toContain("outreach_sends.id DESC");
    expect(params).toEqual(["tenant-id", "lead-id"]);
    expect(context.instantly_lead_id).toBe("instantly-lead-123");
    expect(context.instantly_campaign_id).toBe("campaign-456");
  });

  it("fails when escalation context has no Instantly lead id", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(fetchEscalationContext("tenant-id", "lead-id", { query })).rejects.toThrow(
      "escalation context not found for tenant or missing Instantly lead id",
    );
  });
});

// Instantly does not echo our tenant_id and lead_id on every webhook, so a
// bounce, unsubscribe or reply has to be traced back to one of our leads from
// the identifiers Instantly certainly does send. These three queries are that
// route back. Before them, three real bounces were dropped on the floor.
describe("Instantly webhook lead resolution queries", () => {
  const target = {
    tenant_id: "tenant-id",
    lead_id: "lead-id",
    instantly_lead_id: "instantly-lead-123",
  };

  it("resolves a lead from the Instantly lead id stored at send time", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [target] });

    const result = await findOutreachTargetByInstantlyLeadId("instantly-lead-123", null, { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("FROM outreach_sends");
    expect(sql).toContain("outreach_sends.instantly_lead_id = $1");
    expect(sql).toContain("JOIN leads");
    expect(params).toEqual(["instantly-lead-123", null]);
    expect(result).toEqual(target);
  });

  // The Instantly lead id is ours and unique across the table, so an unscoped
  // lookup is safe. Passing a tenant still has to narrow the query, because a
  // caller that knows the tenant is asserting the row must belong to it.
  it("narrows the Instantly lead id lookup to a tenant when one is known", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [target] });

    await findOutreachTargetByInstantlyLeadId("instantly-lead-123", "tenant-id", { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("outreach_sends.tenant_id = $2");
    expect(params).toEqual(["instantly-lead-123", "tenant-id"]);
  });

  it("returns null when no send carries that Instantly lead id", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    expect(await findOutreachTargetByInstantlyLeadId("unknown", null, { query })).toBeNull();
  });

  // The email address is the one identifier every one of these events must
  // carry, which also makes it the one that could reach across tenants. Two
  // tenants working the same trade in the same city will share leads.
  it("scopes the email lookup to a single tenant", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [target] });

    const result = await findOutreachTargetByEmail("tenant-id", "owner@example.com", { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("leads.tenant_id = $1");
    expect(params).toEqual(["tenant-id", "owner@example.com"]);
    expect(result).toEqual(target);
  });

  it("matches an email address without regard to case", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [target] });

    await findOutreachTargetByEmail("tenant-id", "Owner@Example.com", { query });

    const [sql] = query.mock.calls[0]!;
    expect(sql).toContain("LOWER(leads.email) = LOWER($2)");
  });

  // Only a lead we actually handed to Instantly can have bounced or
  // unsubscribed, and the row is also where the Instantly lead id comes from
  // when the payload does not carry one.
  it("only resolves an email that belongs to a lead we sent to", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [target] });

    await findOutreachTargetByEmail("tenant-id", "owner@example.com", { query });

    const [sql] = query.mock.calls[0]!;
    expect(sql).toContain("JOIN outreach_sends");
    expect(sql).toContain("outreach_sends.tenant_id = leads.tenant_id");
    expect(sql).toContain("outreach_sends.lead_id = leads.id");
    expect(sql).toContain("outreach_sends.instantly_lead_id IS NOT NULL");
  });

  // Nothing stops one tenant holding the same address on two leads. Guessing
  // which one bounced would archive the wrong lead, so the answer is neither.
  it("refuses to resolve an email that matches more than one lead", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [target, { ...target, lead_id: "other-lead-id" }],
    });

    expect(await findOutreachTargetByEmail("tenant-id", "owner@example.com", { query })).toBeNull();
  });

  it("returns null when no lead in the tenant holds that email", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    expect(await findOutreachTargetByEmail("tenant-id", "nobody@example.com", { query })).toBeNull();
  });

  // For the case where Instantly echoes our own tenant_id and lead_id but no
  // Instantly lead id: the ids are known, the send row still has to be found.
  it("resolves the latest send for a tenant and lead", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [target] });

    const result = await findOutreachTargetByLeadId("tenant-id", "lead-id", { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("outreach_sends.tenant_id = $1");
    expect(sql).toContain("outreach_sends.lead_id = $2");
    expect(sql).toContain("outreach_sends.instantly_lead_id IS NOT NULL");
    expect(sql).toContain("outreach_sends.sent_at DESC NULLS LAST");
    expect(params).toEqual(["tenant-id", "lead-id"]);
    expect(result).toEqual(target);
  });

  it("returns null when a tenant and lead have no completed send", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    expect(await findOutreachTargetByLeadId("tenant-id", "lead-id", { query })).toBeNull();
  });
});
