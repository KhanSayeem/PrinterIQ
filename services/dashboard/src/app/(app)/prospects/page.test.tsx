import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDashboardTenantIdMock, getLatestDiscoveryRunMock, workbenchMock } = vi.hoisted(() => ({
  getDashboardTenantIdMock: vi.fn(),
  getLatestDiscoveryRunMock: vi.fn(),
  workbenchMock: vi.fn(() => null),
}));

vi.mock("@/auth/tenant", () => ({ getDashboardTenantId: getDashboardTenantIdMock }));
vi.mock("@/db/queries", () => ({ getLatestDiscoveryRun: getLatestDiscoveryRunMock }));
vi.mock("@/components/ProspectsWorkbench", () => ({ ProspectsWorkbench: workbenchMock }));
vi.mock("@/components/ShadowModeBanner", () => ({ ShadowModeBanner: () => null }));

import ProspectsPage from "./page";
import ProspectsLoading from "./loading";
import ProspectsError from "./error";

describe("ProspectsPage", () => {
  beforeEach(() => {
    getDashboardTenantIdMock.mockReset();
    getLatestDiscoveryRunMock.mockReset();
    workbenchMock.mockClear();
    getDashboardTenantIdMock.mockReturnValue("10000000-0000-0000-0000-000000000001");
    getLatestDiscoveryRunMock.mockResolvedValue(null);
  });

  it("loads the latest run for the configured tenant", async () => {
    render(await ProspectsPage());

    expect(getLatestDiscoveryRunMock).toHaveBeenCalledWith({
      tenantId: "10000000-0000-0000-0000-000000000001",
    });
    expect(workbenchMock).toHaveBeenCalledWith(expect.objectContaining({ initialRun: null }), undefined);
  });

  it("throws when no dashboard tenant is configured", async () => {
    getDashboardTenantIdMock.mockReturnValue("");

    await expect(ProspectsPage()).rejects.toThrow("Dashboard tenant not configured");
  });

  it("renders an explicit loading state", () => {
    render(<ProspectsLoading />);

    expect(screen.getByRole("status")).toHaveTextContent(/Loading discovery run status/i);
  });

  it("offers recovery from a route-level loading failure", () => {
    const reset = vi.fn();
    render(<ProspectsError error={new Error("database unavailable")} reset={reset} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/could not load prospects/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalled();
  });
});
