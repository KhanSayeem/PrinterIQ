import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProspectsWorkbench } from "./ProspectsWorkbench";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const activeRun = {
  id: "run-1",
  status: "submitted",
  source: "outscraper",
  sourceRequestId: "provider-123",
  discoveredCount: 0,
  usableCount: 0,
  routeACount: 0,
  routeBCount: 0,
  verifiedContactCount: 0,
  failureCode: null,
  failureDetail: null,
  createdAt: "2026-07-22T08:00:00.000Z",
  updatedAt: "2026-07-22T08:00:00.000Z",
};
const socialProviderRecord = JSON.parse(
  readFileSync(
    path.resolve(process.cwd(), "../pipeline/tests/fixtures/route_a_social_provider_record.json"),
    "utf-8",
  ),
) as { name: string; site: string };

describe("ProspectsWorkbench", () => {
  beforeEach(() => refresh.mockReset());

  it("shows the fixed preset and start control in the empty state", () => {
    render(<ProspectsWorkbench initialRun={null} startAction={vi.fn()} />);

    expect(screen.getByText("Greater Brisbane plumbing")).toBeInTheDocument();
    expect(screen.getByText(/Brisbane, Logan, Ipswich, Moreton Bay, and Redlands/i)).toBeInTheDocument();
    expect(screen.getByText(/500 businesses maximum/i)).toBeInTheDocument();
    expect(screen.getByText(/No discovery runs yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start discovery run/i })).toBeInTheDocument();
  });

  it("does not offer another start while a run is active", () => {
    render(<ProspectsWorkbench initialRun={activeRun} startAction={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /start discovery run/i })).not.toBeInTheDocument();
    expect(screen.getByText(/A discovery run is active/i)).toBeInTheDocument();
  });

  it("allows another run after raw discovery results are persisted", () => {
    render(
      <ProspectsWorkbench
        initialRun={{ ...activeRun, status: "persisted" }}
        startAction={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /start discovery run/i })).toBeInTheDocument();
    expect(screen.queryByText(/A discovery run is active/i)).not.toBeInTheDocument();
  });

  it("surfaces a rejected start action", async () => {
    const startAction = vi.fn().mockResolvedValue({ ok: false, message: "A discovery run is already active." });
    render(<ProspectsWorkbench initialRun={null} startAction={startAction} />);

    fireEvent.click(screen.getByRole("button", { name: /start discovery run/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A discovery run is already active.");
  });

  it("refreshes after a successful start", async () => {
    const startAction = vi.fn().mockResolvedValue({ ok: true, message: "Discovery run started." });
    render(<ProspectsWorkbench initialRun={null} startAction={startAction} />);

    fireEvent.click(screen.getByRole("button", { name: /start discovery run/i }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByText("Discovery run started.")).toBeInTheDocument();
  });

  it("requests fresh server data from the run status control", () => {
    render(<ProspectsWorkbench initialRun={activeRun} startAction={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /refresh run status/i }));

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("shows Route A website ownership and exact evidence for social-only prospects", () => {
    render(
      <ProspectsWorkbench
        initialRun={{ ...activeRun, status: "processing", routeACount: 1, usableCount: 1 }}
        initialProspects={[
          {
            id: "prospect-1",
            businessName: "Northside Plumbing",
            route: "A",
            status: "assessed",
            websiteOwnership: "social",
            outcomeReason: "no_owned_website",
            sourceWebsiteUrl: "https://facebook.com/northsideplumbing",
            normalizedDomain: "facebook.com",
            matchedLocationCount: 1,
            duplicateEvidence: {},
            ruleEvidence: {
              eligibility: { outcome: "eligible" },
              website: {
                ownership: "social",
                reason: "no_owned_website",
                final_url: "https://facebook.com/northsideplumbing",
              },
            },
          },
        ]}
        startAction={vi.fn()}
      />,
    );

    expect(screen.getByText("Northside Plumbing")).toBeInTheDocument();
    expect(screen.getAllByText("Route A").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Social profile")).toBeInTheDocument();
    expect(screen.getAllByText("no_owned_website").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/facebook.com\/northsideplumbing/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Final URL")).toBeInTheDocument();
    expect(screen.getByText("Ownership reason")).toBeInTheDocument();
    expect(screen.getByText("facebook.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/preview/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/outreach/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/campaign/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/promote/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Instantly/i)).not.toBeInTheDocument();
  });

  it("shows Apollo verified contact evidence without provider payloads", () => {
    render(
      <ProspectsWorkbench
        initialRun={{ ...activeRun, status: "processing", verifiedContactCount: 1 }}
        initialProspects={[
          {
            id: "prospect-1",
            businessName: "Northside Plumbing",
            route: "B",
            status: "contact_enriched",
            websiteOwnership: "owned",
            outcomeReason: null,
            sourceWebsiteUrl: "https://northside.example",
            normalizedDomain: "northside.example",
            matchedLocationCount: 1,
            duplicateEvidence: {},
            ruleEvidence: {},
            totalScore: 58,
            categoryScores: {},
            forcedRouteReason: null,
            contactStatus: "verified",
            contactPersonName: "Alex Owner",
            contactPersonTitle: "Owner",
            contactEmail: "alex@northside.example",
            contactEmailStatus: "verified",
            contactEvidence: {
              strategy: "apollo-owner-verified-v1",
              organization_match: "single",
              person_seniority: "owner",
              provider_payload: { secret: "must not render" },
            },
          },
        ]}
        startAction={vi.fn()}
      />,
    );

    expect(screen.getByText(/Verified - Alex Owner - Owner - alex@northside.example/i)).toBeInTheDocument();
    expect(screen.getByText(/apollo-owner-verified-v1/i)).toBeInTheDocument();
    expect(screen.getByText(/Seniority: owner/i)).toBeInTheDocument();
    expect(screen.queryByText(/must not render/i)).not.toBeInTheDocument();
  });

  it("shows review gates, sample counts, and export without promotion controls", () => {
    render(
      <ProspectsWorkbench
        initialRun={{ ...activeRun, status: "review_ready", failureCode: "insufficient_sample" }}
        reviewMetrics={{
          sampleCount: 44,
          routeASampleCount: 4,
          routeBSampleCount: 20,
          healthyRejectedSampleCount: 20,
          reviewedCount: 40,
          decisiveReviewCount: 39,
          missingReviewCount: 4,
          needsInvestigationCount: 1,
          eligibilityPrecision: 0.92,
          routePrecision: 0.87,
          usableYield: 0.71,
          routeableYield: 0.21,
          routeAYield: 0.1,
          routeBYield: 0.11,
          unexpectedFailureRate: 0.02,
          verifiedContactCount: 31,
          routeAVerifiedEmailMatchRate: 0.3,
          routeBVerifiedEmailMatchRate: 0.36,
          providerUsagePresent: true,
          costReconciliationRequired: true,
        }}
        startAction={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: /export csv/i })).toHaveAttribute(
      "href",
      "/api/prospects/export?runId=run-1",
    );
    expect(screen.getByText("44")).toBeInTheDocument();
    expect(screen.getByText("Route A sample")).toBeInTheDocument();
    expect(screen.getByText(/92% passes >= 90%/i)).toBeInTheDocument();
    expect(screen.getByText(/Sample is insufficient for a passing result/i)).toBeInTheDocument();
    expect(screen.queryByText(/promote/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Instantly/i)).not.toBeInTheDocument();
  });

  it("shows review controls only for selected validation sample prospects", () => {
    render(
      <ProspectsWorkbench
        initialRun={{ ...activeRun, status: "review_ready" }}
        initialProspects={[
          {
            id: "prospect-1",
            businessName: "Northside Plumbing",
            route: "A",
            status: "review_ready",
            validationSample: true,
            validationCohort: "A",
            websiteOwnership: "social",
            outcomeReason: "no_owned_website",
            sourceWebsiteUrl: null,
            normalizedDomain: null,
            matchedLocationCount: 1,
            duplicateEvidence: {},
            ruleEvidence: {},
          },
          {
            id: "prospect-2",
            businessName: "Southside Plumbing",
            route: "B",
            status: "contact_enriched",
            validationSample: false,
            validationCohort: null,
            websiteOwnership: "owned",
            outcomeReason: null,
            sourceWebsiteUrl: null,
            normalizedDomain: null,
            matchedLocationCount: 1,
            duplicateEvidence: {},
            ruleEvidence: {},
          },
        ]}
        startAction={vi.fn()}
        reviewAction={vi.fn()}
      />,
    );

    expect(screen.getByText("Selected - A")).toBeInTheDocument();
    expect(screen.getByText("Not selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /record review/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/decision/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/corrected route/i)).toBeInTheDocument();
  });

  it("shows actionable contact configuration failures", () => {
    render(
      <ProspectsWorkbench
        initialRun={activeRun}
        initialProspects={[
          {
            id: "prospect-1",
            businessName: "Northside Plumbing",
            route: "A",
            status: "contact_enriched",
            websiteOwnership: "none",
            outcomeReason: "no_owned_website",
            sourceWebsiteUrl: null,
            normalizedDomain: null,
            matchedLocationCount: 1,
            duplicateEvidence: {},
            ruleEvidence: {},
            contactStatus: "failed",
            contactEvidence: {
              strategy: "apollo-owner-verified-v1",
              failure_code: "apollo_master_key_required",
            },
          },
        ]}
        startAction={vi.fn()}
      />,
    );

    expect(screen.getAllByText(/Failed - apollo_master_key_required/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Failure: apollo_master_key_required/i)).toBeInTheDocument();
  });

  it("renders visible Route A evidence from the persisted provider social fixture", () => {
    render(
      <ProspectsWorkbench
        initialRun={{ ...activeRun, status: "processing", routeACount: 1, usableCount: 1 }}
        initialProspects={[
          {
            id: "prospect-1",
            businessName: socialProviderRecord.name,
            route: "A",
            status: "assessed",
            websiteOwnership: "social",
            outcomeReason: "no_owned_website",
            sourceWebsiteUrl: socialProviderRecord.site,
            normalizedDomain: "facebook.com",
            matchedLocationCount: 1,
            duplicateEvidence: {},
            ruleEvidence: {
              eligibility: {
                status: "assessed",
                reason: "no_owned_website",
                matched_location_count: 1,
                duplicate_evidence: {},
              },
              website: {
                ownership: "social",
                reason: "no_owned_website",
                final_url: socialProviderRecord.site,
              },
            },
          },
        ]}
        startAction={vi.fn()}
      />,
    );

    expect(screen.getByText(socialProviderRecord.name)).toBeInTheDocument();
    expect(screen.getAllByText("Route A").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Social profile")).toBeInTheDocument();
    expect(screen.getAllByText(socialProviderRecord.site).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Matched locations")).toBeInTheDocument();
    expect(screen.getByText("Duplicate evidence")).toBeInTheDocument();
    expect(screen.getAllByText("None").length).toBeGreaterThanOrEqual(1);
  });

  it("shows exact hold eligibility and duplicate evidence", () => {
    render(
      <ProspectsWorkbench
        initialRun={{ ...activeRun, status: "review_ready", routeACount: 0, usableCount: 0 }}
        initialProspects={[
          {
            id: "prospect-1",
            businessName: "Northside Plumbing",
            route: null,
            status: "held",
            websiteOwnership: "owned",
            outcomeReason: "ambiguous_duplicate",
            sourceWebsiteUrl: "https://northside.example",
            normalizedDomain: "northsideplumbing.com.au",
            matchedLocationCount: 2,
            duplicateEvidence: { domain: ["place-2"], name_address: ["place-3"] },
            ruleEvidence: {
              eligibility: {
                status: "held",
                reason: "ambiguous_duplicate",
                matched_location_count: 2,
                duplicate_evidence: { domain: ["place-2"], name_address: ["place-3"] },
              },
              website: {
                ownership: "owned",
                reason: "ambiguous_duplicate",
                final_url: "https://northsideplumbing.com.au",
              },
            },
          },
        ]}
        startAction={vi.fn()}
      />,
    );

    expect(screen.getByText("held")).toBeInTheDocument();
    expect(screen.getByText("Matched locations")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Duplicate evidence")).toBeInTheDocument();
    expect(screen.getByText(/domain: place-2/i)).toBeInTheDocument();
    expect(screen.getByText(/name_address: place-3/i)).toBeInTheDocument();
  });

  it("shows Route B score, category subtotals, and forced-route evidence", () => {
    render(
      <ProspectsWorkbench
        initialRun={{ ...activeRun, status: "processing", routeBCount: 1, usableCount: 1 }}
        initialProspects={[
          {
            id: "prospect-1",
            businessName: "Northside Plumbing",
            route: "B",
            status: "assessed",
            websiteOwnership: "owned",
            outcomeReason: "no_usable_contact_path",
            sourceWebsiteUrl: "https://northside.example",
            normalizedDomain: "northside.example",
            matchedLocationCount: 1,
            duplicateEvidence: {},
            totalScore: 85,
            categoryScores: {
              technical_mobile: 25,
              conversion_path: 10,
              local_relevance: 20,
              trust_credibility: 15,
              service_completeness: 15,
            },
            forcedRouteReason: "no_usable_contact_path",
            ruleEvidence: {
              website: {
                ownership: "owned",
                reason: "owned_website",
                final_url: "https://northside.example",
              },
              scoring: {
                version: "website-health-v1",
                total_score: 85,
                forced_route_reason: "no_usable_contact_path",
                rules: {
                  technical_mobile: {
                    reachable_final_page: { points: 5, available: 5 },
                  },
                  conversion_path: {
                    prominent_tap_to_call: { points: 0, available: 8 },
                  },
                },
              },
            },
          },
        ]}
        startAction={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Route B").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Website score")).toBeInTheDocument();
    expect(screen.getByText("85/100")).toBeInTheDocument();
    expect(screen.getByText(/Technical\/mobile: 25/i)).toBeInTheDocument();
    expect(screen.getByText("Rule results")).toBeInTheDocument();
    expect(screen.getByText(/reachable_final_page: 5\/5/i)).toBeInTheDocument();
    expect(screen.getByText(/prominent_tap_to_call: 0\/8/i)).toBeInTheDocument();
    expect(screen.getAllByText("no_usable_contact_path").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/Instantly/i)).not.toBeInTheDocument();
  });
});
