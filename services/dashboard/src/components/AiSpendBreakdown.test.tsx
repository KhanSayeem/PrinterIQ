import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RevenueAnalytics } from "@/db/queries";
import { AiSpendBreakdown } from "./AiSpendBreakdown";

function analyticsFixture(overrides: Partial<RevenueAnalytics> = {}): RevenueAnalytics {
  return {
    period: "month",
    periodStart: new Date("2026-05-01T00:00:00Z"),
    totalRevenueAud: 4497,
    paidCount: 3,
    payingLeadCount: 3,
    importedCount: 500,
    allTimeLeadCount: 7574,
    allTimePayingLeadCount: 3,
    paidConversionRate: 0.04,
    aiCosts: [
      {
        haikuModelName: "claude-haiku-4-5-20251001",
        sonnetModelName: "claude-sonnet-4-5-20250929",
        promptVersion: "v3",
        calls: 900,
        costUsd: 9,
      },
      {
        haikuModelName: "claude-haiku-4-5-20251001",
        sonnetModelName: null,
        promptVersion: "v3",
        calls: 100,
        costUsd: 1,
      },
    ],
    totalAiCostUsd: 10,
    ...overrides,
  };
}

function rows(container: HTMLElement) {
  return [...container.querySelectorAll(".ai-row")] as HTMLElement[];
}

function heading(row: HTMLElement) {
  return row.querySelector(".ai-model-name")?.textContent ?? "";
}

describe("AiSpendBreakdown", () => {
  it("names both models of a pair instead of attributing the row to one", () => {
    const { container } = render(<AiSpendBreakdown analytics={analyticsFixture()} />);

    const pairRow = rows(container)[0]!;
    expect(heading(pairRow)).toContain("Haiku");
    expect(heading(pairRow)).toContain("Sonnet");
    expect(pairRow).toHaveTextContent("claude-haiku-4-5-20251001");
    expect(pairRow).toHaveTextContent("claude-sonnet-4-5-20250929");
  });

  it("says Haiku only, and never Sonnet, for a group that ran no Sonnet call", () => {
    const { container } = render(<AiSpendBreakdown analytics={analyticsFixture()} />);

    const haikuOnlyRow = rows(container)[1]!;
    expect(heading(haikuOnlyRow)).toContain("Haiku");
    expect(heading(haikuOnlyRow)).not.toContain("Sonnet");
    expect(haikuOnlyRow).not.toHaveTextContent("claude-sonnet");
  });

  it("says the stored cost is combined and cannot be split between the two models", () => {
    render(<AiSpendBreakdown analytics={analyticsFixture()} />);

    const subtitle = screen.getByText(/combined cost/i);
    expect(subtitle).toHaveTextContent(/cannot be split/i);
    expect(subtitle).toHaveTextContent(/prompt version/i);
  });

  it("groups by model pair rather than claiming a per model breakdown", () => {
    render(<AiSpendBreakdown analytics={analyticsFixture()} />);

    expect(screen.getByText(/combined cost/i)).toHaveTextContent(/model pair/i);
    expect(screen.queryByText(/logged by model and prompt version/i)).toBeNull();
  });

  it("divides AI spend by paying leads, not by payment rows", () => {
    render(
      <AiSpendBreakdown
        analytics={analyticsFixture({ totalAiCostUsd: 10, paidCount: 2, payingLeadCount: 1 })}
      />,
    );

    expect(screen.getByText("$10.00 per paying lead")).toBeInTheDocument();
    expect(screen.queryByText(/per paid lead$/)).toBeNull();
  });

  it("reports no paying leads rather than dividing by zero", () => {
    render(<AiSpendBreakdown analytics={analyticsFixture({ paidCount: 0, payingLeadCount: 0 })} />);

    expect(screen.getByText("No paying leads in this period")).toBeInTheDocument();
  });

  it("shows the total spend and each row cost unchanged", () => {
    render(<AiSpendBreakdown analytics={analyticsFixture()} />);

    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(screen.getByText("$9.00")).toBeInTheDocument();
    expect(screen.getByText("$1.00")).toBeInTheDocument();
  });

  it("says nothing is recorded when there is no AI spend", () => {
    render(<AiSpendBreakdown analytics={analyticsFixture({ aiCosts: [], totalAiCostUsd: 0 })} />);

    expect(screen.getByText("No AI spend recorded yet.")).toBeInTheDocument();
  });
});
