import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, queryEvents } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  queryEvents: [] as Array<{ type: "list"; offset: number }>,
}));

vi.mock("./client", () => ({
  getDb: getDbMock,
}));

import { getLeadListPage } from "./queries";

function createQuery(type: "count" | "list" | "latest") {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: (offset: number) => {
      queryEvents.push({ type: "list", offset });
      return chain;
    },
    groupBy: () => chain,
    then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) => {
      const rows =
        type === "count"
          ? [{ total: "73" }]
          : type === "list"
            ? [{ id: "lead-1", weaknesses: null }]
            : [];

      return Promise.resolve(rows).then(resolve, reject);
    },
  };

  return chain;
}

function createDb() {
  return {
    select: (shape: Record<string, unknown>) =>
      "total" in shape ? createQuery("count") : createQuery("list"),
    selectDistinctOn: () => createQuery("latest"),
  };
}

describe("getLeadListPage", () => {
  beforeEach(() => {
    queryEvents.length = 0;
    getDbMock.mockReturnValue(createDb());
  });

  it("clamps the requested page before issuing the lead-list offset query", async () => {
    const result = await getLeadListPage({
      tenantId: "10000000-0000-0000-0000-000000000001",
      page: 1_000_000_000,
      pageSize: 25,
    });

    expect(result.page).toBe(3);
    expect(queryEvents).toEqual([{ type: "list", offset: 50 }]);
  });
});
