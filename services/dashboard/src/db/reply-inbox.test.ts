import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import {
  buildReplyInboxCountQuery,
  buildReplyInboxFilterCountsQuery,
  buildReplyInboxQuery,
  normalizeReplyInboxFilterCounts,
  normalizeReplyInboxRow,
} from "./queries";

const sql = postgres("postgres://user:pass@localhost:5432/printeriq", { prepare: false });
const db = drizzle(sql);
const tenantId = "10000000-0000-0000-0000-000000000001";

describe("reply inbox queries", () => {
  it("reads inbound conversations for one tenant and skips deleted leads", () => {
    const query = buildReplyInboxQuery(db, { tenantId, filter: "all" }).toSQL();

    expect(query.sql).toContain('"conversations"."tenant_id" =');
    expect(query.sql).toContain('"conversations"."direction" =');
    expect(query.sql).toContain('"leads"."is_deleted" =');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain("inbound");
    expect(query.params).toContain(false);
  });

  it("selects everything the inbox row needs, including the lead id it links to", () => {
    const query = buildReplyInboxQuery(db, { tenantId, filter: "all" }).toSQL();

    for (const column of [
      '"conversations"."lead_id"',
      '"conversations"."body"',
      '"conversations"."intent"',
      '"conversations"."escalated"',
      '"conversations"."created_at"',
      '"leads"."first_name"',
      '"leads"."business_name"',
      '"leads"."email"',
    ]) {
      expect(query.sql).toContain(column);
    }
  });

  it("orders newest first", () => {
    const query = buildReplyInboxQuery(db, { tenantId, filter: "all" }).toSQL();

    expect(query.sql).toMatch(/order by "conversations"\."created_at" desc, "conversations"\."id" desc/);
    expect(query.sql).not.toContain('"conversations"."created_at" asc');
  });

  it("adds no intent predicate for the all filter", () => {
    const query = buildReplyInboxQuery(db, { tenantId, filter: "all" }).toSQL();

    expect(query.sql).not.toContain('"conversations"."intent" =');
    expect(query.sql).not.toContain('"conversations"."intent" is null');
  });

  it("narrows the needs-attention filter to unclassified, interested or escalated replies", () => {
    const query = buildReplyInboxQuery(db, { tenantId, filter: "needs_attention" }).toSQL();

    expect(query.sql).toContain('"conversations"."intent" is null');
    expect(query.sql).toContain('"conversations"."intent" =');
    expect(query.sql).toContain('"conversations"."escalated" =');
    expect(query.sql).toContain(" or ");
    expect(query.params).toContain("interested");
    expect(query.params).toContain(true);
  });

  it("narrows an intent filter to that single classification", () => {
    const query = buildReplyInboxQuery(db, { tenantId, filter: "not_interested" }).toSQL();

    expect(query.sql).toContain('"conversations"."intent" =');
    expect(query.sql).not.toContain('"conversations"."intent" is null');
    expect(query.params).toContain("not_interested");
    expect(query.params).not.toContain("interested");
  });

  it("keeps the unsubscribe filter on the unsubscribe intent", () => {
    const query = buildReplyInboxQuery(db, { tenantId, filter: "unsubscribe" }).toSQL();

    expect(query.params).toContain("unsubscribe");
  });

  it("paginates with a stable page size", () => {
    const query = buildReplyInboxQuery(db, { tenantId, filter: "all", page: 3, pageSize: 25 }).toSQL();

    expect(query.sql).toContain("limit");
    expect(query.sql).toContain("offset");
    expect(query.params).toContain(50);
  });

  it("counts the same filtered set the list query returns", () => {
    const query = buildReplyInboxCountQuery(db, { tenantId, filter: "interested" }).toSQL();

    expect(query.sql).toContain("count(*)");
    expect(query.sql).toContain('"conversations"."direction" =');
    expect(query.sql).toContain('"conversations"."intent" =');
    expect(query.sql).not.toContain("limit");
    expect(query.params).toContain("interested");
  });

  it("tallies every filter in one pass", () => {
    const query = buildReplyInboxFilterCountsQuery(db, { tenantId }).toSQL();

    expect(query.sql).toContain("count(*) filter (where");
    expect(query.sql).toContain('"conversations"."direction" =');
    expect(query.params).toContain(tenantId);
    for (const intent of ["interested", "question", "objection", "not_interested", "unsubscribe", "abusive"]) {
      expect(query.params).toContain(intent);
    }
  });
});

describe("normalizeReplyInboxFilterCounts", () => {
  it("reads the single aggregate row and defaults every missing tally to zero", () => {
    expect(
      normalizeReplyInboxFilterCounts([
        {
          all: "12",
          needsAttention: "5",
          interested: "3",
          question: "2",
          objection: null,
          notInterested: "4",
          unsubscribe: "1",
          abusive: null,
        },
      ]),
    ).toEqual({
      all: 12,
      needs_attention: 5,
      interested: 3,
      question: 2,
      objection: 0,
      not_interested: 4,
      unsubscribe: 1,
      abusive: 0,
    });
  });

  it("returns all zeroes when the table is empty", () => {
    expect(normalizeReplyInboxFilterCounts([])).toEqual({
      all: 0,
      needs_attention: 0,
      interested: 0,
      question: 0,
      objection: 0,
      not_interested: 0,
      unsubscribe: 0,
      abusive: 0,
    });
  });
});

describe("normalizeReplyInboxRow", () => {
  it("coerces the driver row into the shape the inbox renders", () => {
    expect(
      normalizeReplyInboxRow({
        id: "conv-1",
        leadId: "lead-1",
        body: "Sounds good, send the link",
        channel: "email",
        intent: "interested",
        intentConfidence: "88",
        agentAction: "send_checkout",
        escalated: false,
        escalationReason: null,
        createdAt: "2026-09-01T04:00:00.000Z",
        firstName: "Jo",
        lastName: "Nguyen",
        businessName: "Nguyen Plumbing",
        email: "jo@nguyenplumbing.com.au",
      }),
    ).toEqual({
      id: "conv-1",
      leadId: "lead-1",
      body: "Sounds good, send the link",
      channel: "email",
      intent: "interested",
      intentConfidence: 88,
      agentAction: "send_checkout",
      escalated: false,
      escalationReason: null,
      createdAt: new Date("2026-09-01T04:00:00.000Z"),
      firstName: "Jo",
      lastName: "Nguyen",
      businessName: "Nguyen Plumbing",
      email: "jo@nguyenplumbing.com.au",
    });
  });

  it("keeps an unclassified reply unclassified rather than inventing an intent", () => {
    const row = normalizeReplyInboxRow({
      id: "conv-2",
      leadId: "lead-2",
      body: "who is this",
      channel: "email",
      intent: null,
      intentConfidence: null,
      agentAction: null,
      escalated: true,
      escalationReason: "hardcoded_escalation_phrase",
      createdAt: new Date("2026-09-02T04:00:00.000Z"),
      firstName: null,
      lastName: null,
      businessName: null,
      email: "someone@example.com",
    });

    expect(row.intent).toBeNull();
    expect(row.intentConfidence).toBeNull();
    expect(row.escalated).toBe(true);
  });
});
