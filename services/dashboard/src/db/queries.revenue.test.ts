import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock("./client", () => ({
  getDb: getDbMock,
}));

import { getRevenueAnalytics } from "./queries";
import { leads, payments } from "./schema";

/**
 * Two payments, one paying lead: the shape the "per paying lead" figure has to
 * survive. `payments.lead_id` is UNIQUE today so the database cannot hold this
 * yet, which is exactly why it is pinned here rather than left to production.
 */
const paymentSummaryRow = {
  paidCount: "2",
  payingLeadCount: "1",
  totalRevenueAud: "2998",
};
const importedThisPeriodRow = { importedCount: "12" };
const allTimeLeadRow = { count: "7574" };
const allTimePayingLeadRow = { count: "3" };
const aiRow = {
  modelHaiku: "claude-haiku-4-5-20251001",
  modelSonnet: "claude-sonnet-4-5-20250929",
  promptVersion: "v3",
  calls: "900",
  costUsd: "9.5",
};

function rowsFor(shape: Record<string, unknown>, table: unknown) {
  if ("payingLeadCount" in shape) return [paymentSummaryRow];
  if ("importedCount" in shape) return [importedThisPeriodRow];
  if ("modelHaiku" in shape) return [aiRow];
  if ("count" in shape && table === leads) return [allTimeLeadRow];
  if ("count" in shape && table === payments) return [allTimePayingLeadRow];
  throw new Error(`Unexpected revenue query shape: ${Object.keys(shape).join(", ")}`);
}

function createDb() {
  return {
    select: (shape: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const rows = rowsFor(shape, table);
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          groupBy: () => chain,
          then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
            Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      },
    }),
  };
}

const tenantId = "10000000-0000-0000-0000-000000000001";

describe("getRevenueAnalytics", () => {
  beforeEach(() => {
    getDbMock.mockReturnValue(createDb());
  });

  it("counts paying leads apart from payment rows", async () => {
    const analytics = await getRevenueAnalytics({ tenantId, period: "today" });

    expect(analytics.paidCount).toBe(2);
    expect(analytics.payingLeadCount).toBe(1);
  });

  it("divides the conversion rate by every non-deleted lead, not by this period's imports", async () => {
    const analytics = await getRevenueAnalytics({ tenantId, period: "today" });

    expect(analytics.allTimePayingLeadCount).toBe(3);
    expect(analytics.allTimeLeadCount).toBe(7574);
    expect(analytics.paidConversionRate).toBeCloseTo((3 / 7574) * 100, 6);
    // The old figure, 2 payments over 12 imports, was 16.67%.
    expect(analytics.paidConversionRate).not.toBeCloseTo((2 / 12) * 100, 2);
  });

  it("keeps the imported count period scoped, so the cards can say so", async () => {
    const analytics = await getRevenueAnalytics({ tenantId, period: "today" });

    expect(analytics.importedCount).toBe(12);
  });

  it("carries both model names of a group rather than choosing one", async () => {
    const analytics = await getRevenueAnalytics({ tenantId, period: "today" });

    expect(analytics.aiCosts).toEqual([
      {
        haikuModelName: "claude-haiku-4-5-20251001",
        sonnetModelName: "claude-sonnet-4-5-20250929",
        promptVersion: "v3",
        calls: 900,
        costUsd: 9.5,
      },
    ]);
    expect(analytics.totalAiCostUsd).toBe(9.5);
  });
});
