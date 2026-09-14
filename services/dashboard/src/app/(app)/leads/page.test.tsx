import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getDashboardTenantIdMock,
  getLeadFilterCountsMock,
  getLeadListPageMock,
  getTodaySoFarSummaryMock,
  loadTodayInstantlySendTotalsMock,
  loadSendsToDateMock,
  leadsWorkbenchMock,
} = vi.hoisted(() => ({
  getDashboardTenantIdMock: vi.fn(),
  getLeadFilterCountsMock: vi.fn(),
  getLeadListPageMock: vi.fn(),
  getTodaySoFarSummaryMock: vi.fn(),
  loadTodayInstantlySendTotalsMock: vi.fn(),
  loadSendsToDateMock: vi.fn(),
  leadsWorkbenchMock: vi.fn<(props: Record<string, unknown>) => null>(() => null),
}));

const sendTotals = {
  sent: { available: true as const, value: 200 },
  bounces: { available: true as const, value: 4 },
};

const todaySummary = {
  dayLabel: "Mon 15 Jun",
  sent: sendTotals.sent,
  opens: null,
  opensTracked: false,
  replies: 7,
  bounces: sendTotals.bounces,
  unsubscribes: 1,
  replyRate: { available: true as const, value: 3.5 },
  bounceRate: { available: true as const, value: 2 },
  unsubscribeRate: { available: true as const, value: 0.5 },
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

/**
 * Only the network call is faked. `unavailableTodaySendTotals` is a pure
 * shape helper and the page's fallback depends on the real one, so a stub
 * would prove nothing about what the bar receives.
 */
vi.mock("@/lib/today-sends", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/today-sends")>()),
  loadTodayInstantlySendTotals: loadTodayInstantlySendTotalsMock,
}));

vi.mock("@/lib/sends-to-date", () => ({
  loadSendsToDate: loadSendsToDateMock,
}));

const sendsToDate = {
  available: true as const,
  value: { sent: 75, bounced: 7, delivered: 68, contacted: 67 },
};

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
    loadTodayInstantlySendTotalsMock.mockReset();
    loadSendsToDateMock.mockReset();
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
    loadTodayInstantlySendTotalsMock.mockResolvedValue(sendTotals);
    loadSendsToDateMock.mockResolvedValue(sendsToDate);
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

  it("passes a contacted status from the URL into the server-rendered lead query", async () => {
    await LeadsPage({ searchParams: Promise.resolve({ status: "contacted" }) });

    expect(getLeadListPageMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "contacted", page: 1 }),
    );
  });

  it("hands the workbench the emails delivered to date", async () => {
    render(await LeadsPage({ searchParams: Promise.resolve({}) }));

    expect(loadSendsToDateMock).toHaveBeenCalledTimes(1);
    expect(leadsWorkbenchMock.mock.calls[0]?.[0]).toMatchObject({ sendsToDate });
  });

  it("keeps the lead list when the lifetime figure throws, and says why", async () => {
    loadSendsToDateMock.mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(await LeadsPage({ searchParams: Promise.resolve({}) }));

    const props = leadsWorkbenchMock.mock.calls[0]?.[0] as { sendsToDate?: { available: boolean } };
    expect(props.sendsToDate?.available).toBe(false);
    errorSpy.mockRestore();
  });

  it("hands the workbench today's numbers for the operator's own day", async () => {
    render(await LeadsPage({ searchParams: Promise.resolve({}) }));

    expect(getTodaySoFarSummaryMock).toHaveBeenCalledWith({
      tenantId: "10000000-0000-0000-0000-000000000001",
      sendTotals,
      now: expect.any(Date),
    });
    expect(leadsWorkbenchMock.mock.calls[0]?.[0]).toMatchObject({ todaySummary });
  });

  it("reads today's sends from Instantly and gives the same instant to both halves", async () => {
    render(await LeadsPage({ searchParams: Promise.resolve({}) }));

    expect(loadTodayInstantlySendTotalsMock).toHaveBeenCalledTimes(1);
    const loadedNow = loadTodayInstantlySendTotalsMock.mock.calls[0]?.[0]?.now as Date;
    const summaryNow = getTodaySoFarSummaryMock.mock.calls[0]?.[0]?.now as Date;

    expect(loadedNow).toBeInstanceOf(Date);
    expect(summaryNow.getTime()).toBe(loadedNow.getTime());
  });

  it("still renders the bar with unavailable sends when Instantly cannot be read", async () => {
    const unavailable = {
      sent: { available: false as const, reason: "Instantly daily analytics did not load." },
      bounces: { available: false as const, reason: "Instantly daily analytics did not load." },
    };
    loadTodayInstantlySendTotalsMock.mockResolvedValue(unavailable);
    getTodaySoFarSummaryMock.mockResolvedValue({ ...todaySummary, ...unavailable, anySent: false });

    render(await LeadsPage({ searchParams: Promise.resolve({}) }));

    expect(getTodaySoFarSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({ sendTotals: unavailable }),
    );
    expect(leadsWorkbenchMock.mock.calls[0]?.[0]).toMatchObject({
      todaySummary: expect.objectContaining({ sent: unavailable.sent }),
    });
  });

  /**
   * The loader is written not to throw, but the lead list must not depend on
   * that promise holding. An unexpected throw used to reject through the page's
   * own Promise.all and render "Failed to load leads. Check DATABASE_URL",
   * which blames the database for an Instantly problem and hides the whole
   * list.
   */
  it("keeps the lead list and the rest of the bar when the Instantly loader throws", async () => {
    loadTodayInstantlySendTotalsMock.mockRejectedValue(new Error("fetch failed"));

    render(await LeadsPage({ searchParams: Promise.resolve({}) }));

    expect(leadsWorkbenchMock).toHaveBeenCalledTimes(1);
    const sendTotalsArg = getTodaySoFarSummaryMock.mock.calls[0]?.[0]?.sendTotals as {
      sent: { available: boolean; reason?: string };
      bounces: { available: boolean };
    };
    expect(sendTotalsArg.sent.available).toBe(false);
    expect(sendTotalsArg.bounces.available).toBe(false);
    expect(sendTotalsArg.sent.reason).toMatch(/Instantly/);
  });

  it("does not blame the database when only Instantly failed", async () => {
    loadTodayInstantlySendTotalsMock.mockRejectedValue(new Error("fetch failed"));

    const { container } = render(await LeadsPage({ searchParams: Promise.resolve({}) }));

    expect(container.querySelector(".error-state")).toBeNull();
  });

  it("still renders the lead list when today's numbers cannot be read", async () => {
    getTodaySoFarSummaryMock.mockRejectedValue(new Error("today window query failed"));

    render(await LeadsPage({ searchParams: Promise.resolve({}) }));

    expect(leadsWorkbenchMock).toHaveBeenCalledTimes(1);
    expect(leadsWorkbenchMock.mock.calls[0]?.[0]).toMatchObject({ todaySummary: null });
  });
});
