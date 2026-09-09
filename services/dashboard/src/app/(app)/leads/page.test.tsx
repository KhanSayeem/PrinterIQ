import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getDashboardTenantIdMock,
  getLeadFilterCountsMock,
  getLeadListPageMock,
  getTodaySoFarSummaryMock,
  leadsWorkbenchMock,
} = vi.hoisted(() => ({
  getDashboardTenantIdMock: vi.fn(),
  getLeadFilterCountsMock: vi.fn(),
  getLeadListPageMock: vi.fn(),
  getTodaySoFarSummaryMock: vi.fn(),
  leadsWorkbenchMock: vi.fn<(props: Record<string, unknown>) => null>(() => null),
}));

const todaySummary = {
  dayLabel: "Mon 15 Jun",
  sent: 200,
  opens: null,
  opensTracked: false,
  replies: 7,
  bounces: 4,
  unsubscribes: 1,
  replyRate: 3.5,
  bounceRate: 2,
  unsubscribeRate: 0.5,
  bounceTone: "neutral" as const,
  unsubscribeTone: "neutral" as const,
  anySent: true,
  hasActivity: true,
};

vi.mock("@/auth/tenant", () => ({
  getDashboardTenantId: getDashboardTenantIdMock,
}));

vi.mock("@/db/queries", () => ({
  getLeadFilterCounts: getLeadFilterCountsMock,
  getLeadListPage: getLeadListPageMock,
  getTodaySoFarSummary: getTodaySoFarSummaryMock,
}));

vi.mock("@/components/LeadsWorkbench", () => ({
  LeadsWorkbench: leadsWorkbenchMock,
}));

import LeadsPage from "./page";

describe("LeadsPage", () => {
  beforeEach(() => {
    getDashboardTenantIdMock.mockReset();
    getLeadFilterCountsMock.mockReset();
    getLeadListPageMock.mockReset();
    getTodaySoFarSummaryMock.mockReset();
    leadsWorkbenchMock.mockClear();

    getDashboardTenantIdMock.mockReturnValue("10000000-0000-0000-0000-000000000001");
    getLeadFilterCountsMock.mockResolvedValue({ all: 5, qualified: 2, replied: 1, paid: 1, archived: 1 });
    getLeadListPageMock.mockResolvedValue({
      rows: [],
      total: 1,
      page: 1,
      totalPages: 1,
      pageSize: 25,
    });
    getTodaySoFarSummaryMock.mockResolvedValue(todaySummary);
  });

  it("passes the search parameter into the server-rendered lead list query", async () => {
    await LeadsPage({
      searchParams: Promise.resolve({ q: "coolcats", page: "2" }),
    });

    expect(getLeadListPageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "10000000-0000-0000-0000-000000000001",
        search: "coolcats",
        page: 2,
        pageSize: 25,
      }),
    );
  });

  it("hands the workbench today's numbers for the operator's own day", async () => {
    render(await LeadsPage({ searchParams: Promise.resolve({}) }));

    expect(getTodaySoFarSummaryMock).toHaveBeenCalledWith({
      tenantId: "10000000-0000-0000-0000-000000000001",
    });
    expect(leadsWorkbenchMock.mock.calls[0]?.[0]).toMatchObject({ todaySummary });
  });

  it("still renders the lead list when today's numbers cannot be read", async () => {
    getTodaySoFarSummaryMock.mockRejectedValue(new Error("today window query failed"));

    render(await LeadsPage({ searchParams: Promise.resolve({}) }));

    expect(leadsWorkbenchMock).toHaveBeenCalledTimes(1);
    expect(leadsWorkbenchMock.mock.calls[0]?.[0]).toMatchObject({ todaySummary: null });
  });
});
