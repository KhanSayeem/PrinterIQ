import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RevenueAnalytics } from "@/db/queries";
import { RevenueMetrics } from "./RevenueMetrics";

function analyticsFixture(overrides: Partial<RevenueAnalytics> = {}): RevenueAnalytics {
  return {
    period: "month",
    periodStart: new Date("2026-05-01T00:00:00Z"),
    totalRevenueAud: 4497,
    paidCount: 3,
    importedCount: 500,
    paidConversionRate: 0.6,
    aiCosts: [],
    totalAiCostUsd: 12.5,
    ...overrides,
  };
}

function card(container: HTMLElement, label: string) {
  const heading = [...container.querySelectorAll(".metric-label")].find(
    (node) => node.textContent === label,
  );
  return (heading?.closest(".metric-card") ?? null) as HTMLElement | null;
}

describe("RevenueMetrics", () => {
  it("sends the paid money cards to the paid leads list", () => {
    const { container } = render(<RevenueMetrics analytics={analyticsFixture()} />);

    expect(card(container, "Total revenue")).toHaveAttribute("href", "/leads?status=paid");
    expect(card(container, "Paid payments")).toHaveAttribute("href", "/leads?status=paid");
  });

  it("sends the conversion rate card to the funnel it is measured from", () => {
    const { container } = render(<RevenueMetrics analytics={analyticsFixture()} />);

    expect(card(container, "Conversion rate")).toHaveAttribute("href", "/pipeline");
  });

  it("leaves AI spend unlinked because its breakdown is on this page", () => {
    const { container } = render(<RevenueMetrics analytics={analyticsFixture()} />);

    const aiSpend = card(container, "AI spend");
    expect(aiSpend).not.toHaveAttribute("href");
    expect(aiSpend).not.toHaveClass("is-clickable");
    expect(aiSpend?.tagName).toBe("DIV");
  });

  it("puts every linked revenue card in the tab order as a real link", () => {
    const { container } = render(<RevenueMetrics analytics={analyticsFixture()} />);

    for (const label of ["Total revenue", "Conversion rate", "Paid payments"]) {
      const linked = card(container, label);
      expect(linked?.tagName).toBe("A");
      expect(linked).toHaveClass("is-clickable");
      expect(linked).not.toHaveAttribute("tabindex", "-1");
      linked?.focus();
      expect(document.activeElement).toBe(linked);
    }
  });

  it("still shows the figures it always showed", () => {
    const { container } = render(<RevenueMetrics analytics={analyticsFixture()} />);

    expect(card(container, "Total revenue")).toHaveTextContent("$4,497");
    expect(card(container, "Conversion rate")).toHaveTextContent("0.60%");
    expect(card(container, "Paid payments")).toHaveTextContent("3");
    expect(card(container, "AI spend")).toHaveTextContent("$12.50");
    expect(screen.getByText("3 paid payments")).toBeInTheDocument();
  });
});
