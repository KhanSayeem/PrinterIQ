import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getUserMock, listProspectReviewExportRowsMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  listProspectReviewExportRowsMock: vi.fn(),
}));

vi.mock("@/auth/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: getUserMock },
  }),
}));

vi.mock("@/db/queries", () => ({
  listProspectReviewExportRows: listProspectReviewExportRowsMock,
}));

import { GET } from "./route";

function request(runId = "20000000-0000-0000-0000-000000000001") {
  return new NextRequest(`http://localhost/api/prospects/export?runId=${runId}`);
}

describe("GET /api/prospects/export", () => {
  beforeEach(() => {
    vi.stubEnv("DASHBOARD_OPERATOR_EMAILS", "operator@presciaiq.com");
    vi.stubEnv("TENANT_ID", "11111111-1111-4111-8111-111111111111");
    getUserMock.mockReset().mockResolvedValue({
      data: { user: { id: "user-1", email: "operator@presciaiq.com" } },
    });
    listProspectReviewExportRowsMock.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 when unauthenticated", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 for non-operator users", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "user-1", email: "intruder@example.com" } },
    });

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
  });

  it("fails closed when tenant id is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TENANT_ID", "");

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Dashboard tenant not configured" });
    expect(listProspectReviewExportRowsMock).not.toHaveBeenCalled();
  });

  it("requires selected run id", async () => {
    const response = await GET(new NextRequest("http://localhost/api/prospects/export"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "runId is required" });
  });

  it("exports safe review cohort CSV fields", async () => {
    listProspectReviewExportRowsMock.mockResolvedValue([
      {
        businessName: 'Northside "Plumbing"',
        normalizedName: "northside plumbing",
        primaryCategory: "Plumber",
        locality: "Brisbane",
        state: "QLD",
        postcode: "4000",
        googleProfileUrl: "https://google.example/place",
        sourceWebsiteUrl: "https://northside.example",
        normalizedDomain: "northside.example",
        route: "B",
        status: "review_ready",
        validationCohort: "B",
        outcomeReason: "owned_website",
        totalScore: 82,
        contactStatus: "verified",
        contactPersonName: "Alex Owner",
        contactPersonTitle: "Owner",
        contactEmail: "alex@northside.example",
        contactEmailStatus: "verified",
        reviewDecision: "correct",
        correctedRoute: null,
        reviewNote: "Looks right",
        reviewedAt: "2026-07-23T00:00:00.000Z",
        prospectCreatedAt: "2026-07-22T00:00:00.000Z",
        prospectUpdatedAt: "2026-07-23T00:00:00.000Z",
      },
    ]);

    const response = await GET(request());
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(listProspectReviewExportRowsMock).toHaveBeenCalledWith({
      tenantId: "11111111-1111-4111-8111-111111111111",
      discoveryRunId: "20000000-0000-0000-0000-000000000001",
    });
    expect(csv).toContain('"Northside ""Plumbing"""');
    expect(csv).toContain("review_decision");
    expect(csv).toContain("contact_email");
    expect(csv).not.toContain("provider_payload");
    expect(csv).not.toContain("source_payload");
    expect(csv).not.toContain("secret");
  });
});
