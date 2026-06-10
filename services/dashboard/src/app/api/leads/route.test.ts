import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getUserMock, getLeadFilterCountsMock, getLeadListPageMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  getLeadFilterCountsMock: vi.fn(),
  getLeadListPageMock: vi.fn(),
}));

vi.mock("@/auth/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: getUserMock },
  }),
}));

vi.mock("@/db/queries", () => ({
  getLeadFilterCounts: getLeadFilterCountsMock,
  getLeadListPage: getLeadListPageMock,
}));

import { GET } from "./route";

describe("GET /api/leads", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    getLeadFilterCountsMock.mockReset();
    getLeadListPageMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 when there is no authenticated user", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const response = await GET(new NextRequest("http://localhost/api/leads"));

    expect(response.status).toBe(401);
    expect(getLeadListPageMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the authenticated user is not in the operator allowlist", async () => {
    vi.stubEnv("DASHBOARD_OPERATOR_EMAILS", "operator@presciaiq.com");
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "intruder@example.com" } } });

    const response = await GET(new NextRequest("http://localhost/api/leads"));

    expect(response.status).toBe(403);
    expect(getLeadFilterCountsMock).not.toHaveBeenCalled();
    expect(getLeadListPageMock).not.toHaveBeenCalled();
  });

  it("fails closed before DB reads when TENANT_ID is missing in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DASHBOARD_OPERATOR_EMAILS", "operator@presciaiq.com");
    vi.stubEnv("TENANT_ID", "");
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const response = await GET(new NextRequest("http://localhost/api/leads"));

    expect(response.status).toBe(500);
    expect(getLeadFilterCountsMock).not.toHaveBeenCalled();
    expect(getLeadListPageMock).not.toHaveBeenCalled();
  });

  it("scopes the lead list by the server-derived tenant id, ignoring any client tenant param", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    getLeadFilterCountsMock.mockResolvedValue({ all: 5, qualified: 2, replied: 1, paid: 1, archived: 1 });
    getLeadListPageMock.mockResolvedValue({
      rows: [],
      total: 5,
      page: 1,
      totalPages: 1,
      pageSize: 25,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/leads?status=qualified&tenantId=evil-tenant&page=2"),
    );
    const body = await response.json();

    expect(getLeadListPageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "10000000-0000-0000-0000-000000000001",
        status: "qualified",
        page: 2,
        pageSize: 25,
      }),
    );
    expect(getLeadFilterCountsMock).toHaveBeenCalledWith({ tenantId: "10000000-0000-0000-0000-000000000001" });
    expect(body).toEqual({
      rows: [],
      counts: { all: 5, qualified: 2, replied: 1, paid: 1, archived: 1 },
      total: 5,
      page: 1,
      totalPages: 1,
      pageSize: 25,
    });
  });
});
