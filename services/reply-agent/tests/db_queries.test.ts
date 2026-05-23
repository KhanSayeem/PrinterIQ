import { describe, expect, it, vi } from "vitest";
import { advanceLeadToReplied, archiveLeadForSuppression, insertInboundConversation } from "../src/db/queries.js";

describe("reply-agent DB queries", () => {
  it("inserts inbound conversations only through a tenant-scoped lead lookup", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "conversation-id" }] });

    await insertInboundConversation("tenant-id", "lead-id", "email", "Hi", { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO conversations");
    expect(sql).toContain("SELECT");
    expect(sql).toContain("FROM leads");
    expect(sql).toContain("WHERE tenant_id = $1");
    expect(sql).toContain("AND id = $2");
    expect(params).toEqual(["tenant-id", "lead-id", "email", "Hi"]);
  });

  it("fails when the lead does not belong to the tenant", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(insertInboundConversation("tenant-id", "lead-id", "email", "Hi", { query })).rejects.toThrow(
      "lead not found for tenant",
    );
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
});
