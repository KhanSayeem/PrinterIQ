import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDashboardTenantIdMock, getLeadFilterCountsMock, getLeadListPageMock, leadsWorkbenchMock } = vi.hoisted(
  () => ({
    getDashboardTenantIdMock: vi.fn(),
    getLeadFilterCountsMock: vi.fn(),
    getLeadListPageMock: vi.fn(),
    leadsWorkbenchMock: vi.fn(() => null),
  }),
);

vi.mock("@/auth/tenant", () => ({
  getDashboardTenantId: getDashboardTenantIdMock,
}));

vi.mock("@/db/queries", () => ({
  getLeadFilterCounts: getLeadFilterCountsMock,
  getLeadListPage: getLeadListPageMock,
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
});
