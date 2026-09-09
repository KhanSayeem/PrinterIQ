import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TodaySoFarSummary } from "@/db/queries";
import { TodaySoFarBar } from "./TodaySoFarBar";

function summaryFixture(overrides: Partial<TodaySoFarSummary> = {}): TodaySoFarSummary {
  return {
    dayLabel: "Mon 15 Jun",
    sent: 200,
    opens: null,
    opensTracked: false,
    replies: 7,
    bounces: 4,
    unsubscribes: 1,
    replyRate: 3.5,
    bounceRate: 2,
    unsubscribeRate: 0.5,
    bounceTone: "neutral",
    unsubscribeTone: "neutral",
    anySent: true,
    hasActivity: true,
    ...overrides,
  };
}

function tile(container: HTMLElement, label: string) {
  const heading = [...container.querySelectorAll(".today-metric-label")].find(
    (node) => node.textContent === label,
  );
  return heading?.closest(".today-metric") ?? null;
}

describe("TodaySoFarBar", () => {
  it("shows today's counts against the Sydney day", () => {
    const { container } = render(<TodaySoFarBar summary={summaryFixture()} />);

    expect(screen.getByText("Today so far")).toBeInTheDocument();
    expect(screen.getByText(/Mon 15 Jun/)).toBeInTheDocument();
    expect(screen.getByText(/Sydney time/)).toBeInTheDocument();
    expect(tile(container, "Sent")).toHaveTextContent("200");
    expect(tile(container, "Replies")).toHaveTextContent("7");
    expect(tile(container, "Bounces")).toHaveTextContent("4");
    expect(tile(container, "Unsubscribes")).toHaveTextContent("1");
  });

  it("shows each rate against sends", () => {
    const { container } = render(<TodaySoFarBar summary={summaryFixture()} />);

    expect(tile(container, "Replies")).toHaveTextContent("3.5% of sent");
    expect(tile(container, "Bounces")).toHaveTextContent("2.0% of sent");
    expect(tile(container, "Unsubscribes")).toHaveTextContent("0.5% of sent");
  });

  it("colours a bounce rate that is over the threshold", () => {
    const { container } = render(
      <TodaySoFarBar summary={summaryFixture({ bounces: 8, bounceRate: 4, bounceTone: "warning" })} />,
    );

    expect(tile(container, "Bounces")).toHaveClass("warning");
    expect(tile(container, "Unsubscribes")).not.toHaveClass("warning");
  });

  it("colours an unsubscribe rate that is over the threshold", () => {
    const { container } = render(
      <TodaySoFarBar
        summary={summaryFixture({ unsubscribes: 3, unsubscribeRate: 1.5, unsubscribeTone: "warning" })}
      />,
    );

    expect(tile(container, "Unsubscribes")).toHaveClass("warning");
    expect(tile(container, "Bounces")).not.toHaveClass("warning");
  });

  it("leaves a rate sitting on the threshold uncoloured", () => {
    const { container } = render(
      <TodaySoFarBar summary={summaryFixture({ bounces: 6, bounceRate: 3, bounceTone: "neutral" })} />,
    );

    expect(tile(container, "Bounces")).not.toHaveClass("warning");
    expect(tile(container, "Bounces")).toHaveTextContent("3.0% of sent");
  });

  it("says nothing has gone out rather than drawing a row of zeros", () => {
    const { container } = render(
      <TodaySoFarBar
        summary={summaryFixture({
          sent: 0,
          replies: 0,
          bounces: 0,
          unsubscribes: 0,
          replyRate: null,
          bounceRate: null,
          unsubscribeRate: null,
          anySent: false,
          hasActivity: false,
        })}
      />,
    );

    expect(screen.getByText(/No emails sent yet today/)).toBeInTheDocument();
    expect(container.querySelectorAll(".today-metric")).toHaveLength(0);
  });

  it("still shows a reply that landed on a day with no sends", () => {
    const { container } = render(
      <TodaySoFarBar
        summary={summaryFixture({
          sent: 0,
          replies: 2,
          bounces: 0,
          unsubscribes: 0,
          replyRate: null,
          bounceRate: null,
          unsubscribeRate: null,
          anySent: false,
          hasActivity: true,
        })}
      />,
    );

    expect(tile(container, "Replies")).toHaveTextContent("2");
    expect(tile(container, "Replies")).toHaveTextContent("no sends today");
    expect(screen.queryByText(/No emails sent yet today/)).not.toBeInTheDocument();
  });

  it("marks opens as untracked instead of reporting zero", () => {
    const { container } = render(<TodaySoFarBar summary={summaryFixture()} />);

    const opens = tile(container, "Opens");
    expect(opens).toHaveTextContent("--");
    expect(opens).toHaveTextContent("Not tracked");
    expect(opens).not.toHaveTextContent("0 ");
  });

  it("says so when the numbers could not be loaded", () => {
    const { container } = render(<TodaySoFarBar summary={null} />);

    expect(screen.getByText(/Today so far could not be loaded/)).toBeInTheDocument();
    expect(container.querySelectorAll(".today-metric")).toHaveLength(0);
  });
});
