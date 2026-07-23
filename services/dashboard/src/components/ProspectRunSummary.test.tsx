import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProspectRunSummary } from "./ProspectRunSummary";

const run = {
  id: "run-1",
  status: "processing",
  source: "outscraper",
  sourceRequestId: "provider-123",
  discoveredCount: 120,
  usableCount: 92,
  routeACount: 37,
  routeBCount: 41,
  verifiedContactCount: 18,
  providerUsage: {
    apollo_contact_match: {
      route_a_verified_contact_count: 7,
      route_b_verified_contact_count: 11,
      route_a_match_rate: 0.1892,
      route_b_match_rate: 0.2683,
      cost_reconciliation_required: true,
    },
  },
  failureCode: null,
  failureDetail: null,
  createdAt: "2026-07-22T08:00:00.000Z",
  updatedAt: "2026-07-22T08:05:00.000Z",
};

describe("ProspectRunSummary", () => {
  it("shows run state, provider state, and every run count", () => {
    render(<ProspectRunSummary run={run} />);

    expect(screen.getAllByText("Processing")).toHaveLength(2);
    expect(screen.getByText("Results received")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("92")).toBeInTheDocument();
    expect(screen.getByText("37")).toBeInTheDocument();
    expect(screen.getByText("41")).toBeInTheDocument();
    expect(screen.getByText("18")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("11")).toBeInTheDocument();
    expect(screen.getByText("19%")).toBeInTheDocument();
    expect(screen.getByText("27%")).toBeInTheDocument();
    expect(screen.getByText("Cost reconciliation required")).toBeInTheDocument();
  });

  it("keeps partial counts visible while processing", () => {
    render(<ProspectRunSummary run={{ ...run, status: "polling", sourceRequestId: "provider-123" }} />);

    expect(screen.getByText(/partial results/i)).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("Provider processing")).toBeInTheDocument();
  });

  it("does not describe raw persisted results as active processing", () => {
    render(<ProspectRunSummary run={{ ...run, status: "persisted" }} />);

    expect(screen.getAllByText("Results persisted")).toHaveLength(2);
    expect(screen.queryByText(/partial results/i)).not.toBeInTheDocument();
  });

  it("shows a terminal provider failure without hiding collected counts", () => {
    render(
      <ProspectRunSummary
        run={{ ...run, status: "failed", failureCode: "provider_timeout", failureDetail: "Request timed out" }}
      />,
    );

    expect(screen.getAllByText("Run failed")).toHaveLength(3);
    expect(screen.getByText("Request timed out")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
  });

  it("keeps review precision incomplete when provider usage is missing", () => {
    render(
      <ProspectRunSummary
        run={{ ...run, providerUsage: {} }}
        reviewMetrics={{
          eligibilityPrecision: null,
          routePrecision: null,
          usableYield: null,
          routeableYield: null,
          routeAYield: null,
          routeBYield: null,
          unexpectedFailureRate: null,
          routeAVerifiedEmailMatchRate: null,
          routeBVerifiedEmailMatchRate: null,
          providerUsagePresent: false,
          costReconciliationRequired: true,
        }}
      />,
    );

    expect(screen.getByText("Provider usage missing")).toBeInTheDocument();
    expect(screen.getAllByText("Incomplete").length).toBeGreaterThanOrEqual(2);
  });
});
