import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, selectedShapes } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  selectedShapes: [] as string[][],
}));

vi.mock("./client", () => ({
  getDb: getDbMock,
}));

import { getTodaySoFarSummary } from "./queries";

const TENANT = "10000000-0000-0000-0000-000000000001";
/** 09:00 on 16 June in Sydney, which is still 15 June in UTC. */
const NOW = new Date("2026-06-15T23:00:00.000Z");

/**
 * Enough of the drizzle chain for the two remaining today-bar queries, and a
 * record of every column shape asked for. Sends and bounces must not appear in
 * that record at all: the whole point of this change is that the database
 * cannot answer them.
 */
function createDb() {
  const rowsFor = (keys: string[]) => {
    if (keys.includes("replyCount")) {
      return [{ replyCount: "7" }];
    }
    if (keys.includes("unsubscribeCount")) {
      return [{ unsubscribeCount: "1" }];
    }
    return [{}];
  };

  return {
    select: (shape: Record<string, unknown>) => {
      const keys = Object.keys(shape);
      selectedShapes.push(keys);

      const chain = {
        from: () => chain,
        where: () => chain,
        then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
          Promise.resolve(rowsFor(keys)).then(resolve, reject),
      };

      return chain;
    },
  };
}

describe("getTodaySoFarSummary", () => {
  beforeEach(() => {
    selectedShapes.length = 0;
    getDbMock.mockReturnValue(createDb());
  });

  it("reports the send and bounce counts it was handed, and asks the database for neither", async () => {
    const summary = await getTodaySoFarSummary({
      tenantId: TENANT,
      sendTotals: {
        sent: { available: true, value: 30 },
        bounces: { available: true, value: 3 },
      },
      now: NOW,
    });

    expect(summary.sent).toEqual({ available: true, value: 30 });
    expect(summary.bounces).toEqual({ available: true, value: 3 });
    expect(summary.replies).toBe(7);
    expect(summary.unsubscribes).toBe(1);

    const everyColumn = selectedShapes.flat();
    expect(everyColumn).toEqual(expect.arrayContaining(["replyCount", "unsubscribeCount"]));
    expect(everyColumn).not.toContain("sentCount");
    expect(everyColumn).not.toContain("bounceCount");
    expect(selectedShapes).toHaveLength(2);
  });

  it("passes an unavailable send count straight through instead of substituting a database count", async () => {
    const reason = "Instantly daily analytics did not load.";

    const summary = await getTodaySoFarSummary({
      tenantId: TENANT,
      sendTotals: {
        sent: { available: false, reason },
        bounces: { available: false, reason },
      },
      now: NOW,
    });

    expect(summary.sent).toEqual({ available: false, reason });
    expect(summary.bounces).toEqual({ available: false, reason });
    expect(summary.replyRate.available).toBe(false);
    expect(summary.hasActivity).toBe(true);
    expect(selectedShapes).toHaveLength(2);
  });

  it("labels the day in Sydney time even when UTC is still on yesterday", async () => {
    const summary = await getTodaySoFarSummary({
      tenantId: TENANT,
      sendTotals: {
        sent: { available: true, value: 30 },
        bounces: { available: true, value: 3 },
      },
      now: NOW,
    });

    expect(summary.dayLabel).toBe("Tue 16 Jun");
  });
});
