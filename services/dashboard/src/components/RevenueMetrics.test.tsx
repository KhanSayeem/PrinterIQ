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
    payingLeadCount: 3,
    importedCount: 500,
    allTimeLeadCount: 7574,
    allTimePayingLeadCount: 3,
    paidConversionRate: 0.04,
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

    expect(card(container, "Conversion rate, all time")).toHaveAttribute("href", "/pipeline");
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

    for (const label of ["Total revenue", "Conversion rate, all time", "Paid payments"]) {
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
    expect(card(container, "Conversion rate, all time")).toHaveTextContent("0.04%");
    expect(card(container, "Paid payments")).toHaveTextContent("3");
    expect(card(container, "AI spend")).toHaveTextContent("$12.50");
    expect(screen.getByText("3 paid payments")).toBeInTheDocument();
  });

  it("names both cohorts of the conversion rate, and the window it covers", () => {
    const { container } = render(<RevenueMetrics analytics={analyticsFixture()} />);

    const conversion = card(container, "Conversion rate, all time");
    expect(conversion).toHaveTextContent("3 of 7,574 leads have paid");
    expect(conversion).not.toHaveTextContent("paid / imported");
  });

  it("keeps the conversion rate off the period tab it is not scoped to", () => {
    const { container } = render(
      <RevenueMetrics
        analytics={analyticsFixture({
          period: "today",
          paidCount: 0,
          payingLeadCount: 0,
          importedCount: 0,
        })}
      />,
    );

    const conversion = card(container, "Conversion rate, all time");
    expect(conversion).toHaveTextContent("0.04%");
    expect(conversion).toHaveTextContent("3 of 7,574 leads have paid");
  });

  it("never renders a conversion rate above 100 percent as a healthy figure", () => {
    const { container } = render(
      <RevenueMetrics analytics={analyticsFixture({ paidConversionRate: null })} />,
    );

    const conversion = card(container, "Conversion rate, all time");
    expect(conversion).toHaveTextContent("--");
    expect(conversion?.textContent).not.toMatch(/\d%/);
  });

  it("says the imported subtitle is scoped to the period on show", () => {
    const { container } = render(
      <RevenueMetrics analytics={analyticsFixture({ period: "today", importedCount: 0 })} />,
    );

    const paid = card(container, "Paid payments");
    expect(paid).toHaveTextContent("0 imported this period");
    expect(paid).not.toHaveTextContent("0 imported leads");
  });

  it("counts AI spend rows as model pairs rather than models", () => {
    const { container } = render(<RevenueMetrics analytics={analyticsFixture()} />);

    expect(card(container, "AI spend")).toHaveTextContent("No AI spend recorded yet.");
    const { container: withRows } = render(
      <RevenueMetrics
        analytics={analyticsFixture({
          aiCosts: [
            {
              haikuModelName: "claude-haiku-4-5-20251001",
              sonnetModelName: "claude-sonnet-4-5-20250929",
              promptVersion: "v3",
              calls: 10,
              costUsd: 1,
            },
          ],
        })}
      />,
    );
    expect(card(withRows, "AI spend")).toHaveTextContent("1 model pair row");
    expect(card(withRows, "AI spend")).not.toHaveTextContent("1 model rows");
  });
});
