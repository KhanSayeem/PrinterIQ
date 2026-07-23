import { describe, expect, it, vi } from "vitest";
import {
  advanceLeadToReplied,
  archiveLeadForSuppression,
  fetchEscalationContext,
  hasCompletedPayment,
  insertInboundConversation,
  recordInstantlyBounce,
  recordInstantlyUnsubscribe,
  recordCompletedPayment,
} from "../src/db/queries.js";

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
