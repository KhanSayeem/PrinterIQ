import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import {
  buildLatestConversationsForLeadsQuery,
  buildLeadDetailQuery,
  buildLeadListQuery,
  buildRelatedLeadDataQueries,
} from "./queries";

const sql = postgres("postgres://user:pass@localhost:5432/printeriq", { prepare: false });
const db = drizzle(sql);
const tenantId = "10000000-0000-0000-0000-000000000001";
const leadId = "00000000-0000-0000-0001-000000000001";

describe("dashboard lead queries", () => {
  it("scopes lead list queries by tenant_id and filters", () => {
    const query = buildLeadListQuery(db, {
      tenantId,
      status: "qualified",
      state: "NSW",
      tradeType: "tradies",
      scoreMin: 50,
      scoreMax: 90,
      page: 2,
      pageSize: 25,
    }).toSQL();

    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"enrichments"."tenant_id" =');
    expect(query.sql).toContain('"weaknesses"');
    expect(query.sql).toContain('"leads"."status" =');
    expect(query.sql).toContain('"leads"."state" =');
    expect(query.sql).toContain('"leads"."vertical" =');
    expect(query.params).toContain(tenantId);
  });

  it("scopes latest conversation lookups by tenant_id and visible lead ids", () => {
    const query = buildLatestConversationsForLeadsQuery(db, {
      tenantId,
      leadIds: [leadId, "00000000-0000-0000-0001-000000000002"],
    }).toSQL();

    expect(query.sql).toContain('"conversations"."tenant_id" =');
    expect(query.sql).toContain('"conversations"."lead_id" in');
    expect(query.sql).toContain("distinct on");
    expect(query.sql).toContain('order by "conversations"."lead_id", "conversations"."created_at" desc');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain(leadId);
  });

  it("scopes lead detail queries by tenant_id and lead id", () => {
    const query = buildLeadDetailQuery(db, { tenantId, leadId }).toSQL();

    expect(query.sql).toContain('"leads"."tenant_id" =');
    expect(query.sql).toContain('"leads"."id" =');
    expect(query.params).toContain(tenantId);
    expect(query.params).toContain(leadId);
  });

  it("scopes related tab data by the same tenant_id and lead id", () => {
    const queries = buildRelatedLeadDataQueries(db, { tenantId, leadId }).map((query) => query.toSQL());

    expect(queries).toHaveLength(5);
    for (const query of queries) {
      expect(query.sql).toContain('"tenant_id" = $1');
      expect(query.sql).toContain('"lead_id" = $2');
      expect(query.params).toContain(tenantId);
      expect(query.params).toContain(leadId);
    }
  });
});
