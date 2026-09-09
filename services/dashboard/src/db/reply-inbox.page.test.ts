import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, queryEvents, listRows, countRows } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  queryEvents: [] as Array<{ type: "list"; offset: number } | { type: "list"; limit: number }>,
  listRows: [] as Array<Record<string, unknown>>,
  countRows: [{ total: "73" }] as Array<Record<string, unknown>>,
}));

vi.mock("./client", () => ({
  getDb: getDbMock,
}));

import { getReplyInboxFilterCounts, getReplyInboxPage } from "./queries";

function replyRow(id: string, createdAt: string) {
  return {
    id,
    leadId: `lead-${id}`,
    body: `body ${id}`,
    channel: "email",
    intent: null,
    intentConfidence: null,
    agentAction: null,
    escalated: false,
    escalationReason: null,
    createdAt,
    firstName: "Jo",
    lastName: "Nguyen",
    businessName: "Nguyen Plumbing",
    email: "jo@nguyenplumbing.com.au",
  };
}

function createQuery(type: "count" | "list" | "counts") {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: (limit: number) => {
      queryEvents.push({ type: "list", limit });
      return chain;
    },
    offset: (offset: number) => {
      queryEvents.push({ type: "list", offset });
      return chain;
    },
    groupBy: () => chain,
    then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) => {
      const rows = type === "count" ? countRows : type === "counts" ? [{ all: "2", needsAttention: "1" }] : listRows;
      return Promise.resolve(rows).then(resolve, reject);
    },
  };

  return chain;
}

function createDb() {
  return {
    select: (shape: Record<string, unknown>) => {
      if ("total" in shape) return createQuery("count");
      if ("needsAttention" in shape) return createQuery("counts");
      return createQuery("list");
    },
  };
}

describe("getReplyInboxPage", () => {
  beforeEach(() => {
    queryEvents.length = 0;
    listRows.length = 0;
    countRows.length = 0;
    countRows.push({ total: "73" });
    getDbMock.mockReturnValue(createDb());
  });

  it("clamps the requested page before issuing the offset query", async () => {
    const result = await getReplyInboxPage({
      tenantId: "10000000-0000-0000-0000-000000000001",
      filter: "all",
      page: 1_000_000_000,
      pageSize: 25,
    });

    expect(result.page).toBe(3);
    expect(result.total).toBe(73);
    expect(result.totalPages).toBe(3);
    expect(queryEvents).toContainEqual({ type: "list", offset: 50 });
  });

  it("returns replies in the order the database supplied, newest first", async () => {
    listRows.push(replyRow("c3", "2026-09-03T00:00:00.000Z"));
    listRows.push(replyRow("c2", "2026-09-02T00:00:00.000Z"));
    listRows.push(replyRow("c1", "2026-09-01T00:00:00.000Z"));

    const result = await getReplyInboxPage({
      tenantId: "10000000-0000-0000-0000-000000000001",
      filter: "all",
    });

    expect(result.rows.map((row) => row.id)).toEqual(["c3", "c2", "c1"]);
    expect(result.rows[0].createdAt).toEqual(new Date("2026-09-03T00:00:00.000Z"));
    expect(result.rows[0].leadId).toBe("lead-c3");
  });

  it("reports an empty inbox without error", async () => {
    countRows.length = 0;
    countRows.push({ total: "0" });

    const result = await getReplyInboxPage({
      tenantId: "10000000-0000-0000-0000-000000000001",
      filter: "needs_attention",
    });

    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(1);
  });
});

describe("getReplyInboxFilterCounts", () => {
  beforeEach(() => {
    getDbMock.mockReturnValue(createDb());
  });

  it("normalizes the aggregate row into a full count set", async () => {
    await expect(
      getReplyInboxFilterCounts({ tenantId: "10000000-0000-0000-0000-000000000001" }),
    ).resolves.toEqual({
      all: 2,
      needs_attention: 1,
      interested: 0,
      question: 0,
      objection: 0,
      not_interested: 0,
      unsubscribe: 0,
      abusive: 0,
    });
  });
});
