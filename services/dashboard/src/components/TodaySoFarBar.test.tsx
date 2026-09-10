import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TodaySoFarSummary } from "@/db/queries";
import type { MetricAvailability } from "@/lib/deliverability";
import { TodaySoFarBar } from "./TodaySoFarBar";

const value = (amount: number): MetricAvailability<number> => ({ available: true, value: amount });
const missing = (reason: string): MetricAvailability<number> => ({ available: false, reason });

const ANALYTICS_DOWN = "Instantly daily analytics did not load.";

function summaryFixture(overrides: Partial<TodaySoFarSummary> = {}): TodaySoFarSummary {
  return {
    dayLabel: "Mon 15 Jun",
    sent: value(200),
    opens: null,
    opensTracked: false,
    replies: 7,
    bounces: value(4),
    unsubscribes: 1,
    replyRate: value(3.5),
    bounceRate: value(2),
    unsubscribeRate: value(0.5),
    bounceTone: "neutral",
    unsubscribeTone: "neutral",
    anySent: true,
    hasActivity: true,
    ...overrides,
  };
}

/** Every figure Instantly would have supplied is gone, which is the outage case. */
function instantlyDownFixture(overrides: Partial<TodaySoFarSummary> = {}): TodaySoFarSummary {
  return summaryFixture({
    sent: missing(ANALYTICS_DOWN),
    bounces: missing(ANALYTICS_DOWN),
    replyRate: missing("no rate without today's send count from Instantly"),
    bounceRate: missing(ANALYTICS_DOWN),
    unsubscribeRate: missing("no rate without today's send count from Instantly"),
    anySent: false,
    hasActivity: true,
    ...overrides,
  });
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
      <TodaySoFarBar
        summary={summaryFixture({ bounces: value(8), bounceRate: value(4), bounceTone: "warning" })}
      />,
    );

    expect(tile(container, "Bounces")).toHaveClass("warning");
    expect(tile(container, "Unsubscribes")).not.toHaveClass("warning");
  });

  it("colours an unsubscribe rate that is over the threshold", () => {
    const { container } = render(
      <TodaySoFarBar
        summary={summaryFixture({
          unsubscribes: 3,
          unsubscribeRate: value(1.5),
          unsubscribeTone: "warning",
        })}
      />,
    );

    expect(tile(container, "Unsubscribes")).toHaveClass("warning");
    expect(tile(container, "Bounces")).not.toHaveClass("warning");
  });

  it("leaves a rate sitting on the threshold uncoloured", () => {
    const { container } = render(
      <TodaySoFarBar
        summary={summaryFixture({ bounces: value(6), bounceRate: value(3), bounceTone: "neutral" })}
      />,
    );

    expect(tile(container, "Bounces")).not.toHaveClass("warning");
    expect(tile(container, "Bounces")).toHaveTextContent("3.0% of sent");
  });

  it("says nothing has gone out rather than drawing a row of zeros", () => {
    const { container } = render(
      <TodaySoFarBar
        summary={summaryFixture({
          sent: value(0),
          replies: 0,
          bounces: value(0),
          unsubscribes: 0,
          replyRate: missing("no sends today"),
          bounceRate: missing("no sends today"),
          unsubscribeRate: missing("no sends today"),
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
          sent: value(0),
          replies: 2,
          bounces: value(0),
          unsubscribes: 0,
          replyRate: missing("no sends today"),
          bounceRate: missing("no sends today"),
          unsubscribeRate: missing("no sends today"),
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

  it("links each today metric to the view that explains it", () => {
    const { container } = render(<TodaySoFarBar summary={summaryFixture()} />);

    expect(tile(container, "Sent")).toHaveAttribute("href", "/deliverability");
    expect(tile(container, "Replies")).toHaveAttribute("href", "/replies?filter=all");
    expect(tile(container, "Bounces")).toHaveAttribute("href", "/deliverability");
    expect(tile(container, "Unsubscribes")).toHaveAttribute("href", "/leads?unsubscribed=1");
  });

  it("marks the linked today metrics clickable and leaves untracked opens alone", () => {
    const { container } = render(<TodaySoFarBar summary={summaryFixture()} />);

    expect(tile(container, "Sent")).toHaveClass("is-clickable");
    expect(tile(container, "Opens")).not.toHaveClass("is-clickable");
    expect(tile(container, "Opens")).not.toHaveAttribute("href");
    expect(tile(container, "Opens")?.tagName).toBe("DIV");
  });

  it("puts every linked today metric in the tab order as a real link", () => {
    const { container } = render(<TodaySoFarBar summary={summaryFixture()} />);

    for (const label of ["Sent", "Replies", "Bounces", "Unsubscribes"]) {
      const card = tile(container, label) as HTMLElement | null;
      expect(card?.tagName).toBe("A");
      expect(card).not.toHaveAttribute("tabindex", "-1");
      card?.focus();
      expect(document.activeElement).toBe(card);
    }
  });

  it("shows the send count Instantly reported, not a database handoff count", () => {
    const { container } = render(<TodaySoFarBar summary={summaryFixture({ sent: value(0) })} />);

    expect(tile(container, "Sent")).toHaveTextContent("0");
  });

  it("says the send count is not available rather than drawing a zero", () => {
    const { container } = render(<TodaySoFarBar summary={instantlyDownFixture()} />);

    const sentTile = tile(container, "Sent");
    expect(sentTile).toHaveTextContent("Not available");
    expect(sentTile).toHaveTextContent(ANALYTICS_DOWN);
    expect(sentTile?.textContent).not.toMatch(/\d/);
  });

  /**
   * "emails out today" under a tile that has no count reads as a caption for a
   * number that is not there. The detail line has to name the missing source
   * instead.
   */
  it("does not caption the missing send count as though a count were shown", () => {
    const { container } = render(<TodaySoFarBar summary={instantlyDownFixture()} />);

    const detail = tile(container, "Sent")?.querySelector(".today-metric-detail");
    expect(detail).not.toHaveTextContent("emails out today");
    expect(detail).toHaveTextContent(/Instantly/);
  });

  it("says the bounce count is not available rather than drawing a zero", () => {
    const { container } = render(<TodaySoFarBar summary={instantlyDownFixture()} />);

    const bounceTile = tile(container, "Bounces");
    expect(bounceTile).toHaveTextContent("Not available");
    expect(bounceTile).toHaveTextContent(ANALYTICS_DOWN);
    expect(bounceTile?.textContent).not.toMatch(/\d/);
  });

  /**
   * Instantly has no bounce figure that can be cut at Sydney midnight, so this
   * tile sits in its unavailable state every day. Printing the same sentence in
   * the value and again in the detail line reads as two separate problems, and
   * the detail line is the one place that can say where the measured figure is.
   */
  it("points at the deliverability page instead of repeating the reason under a missing bounce count", () => {
    const { container } = render(<TodaySoFarBar summary={instantlyDownFixture()} />);

    const bounceTile = tile(container, "Bounces");
    const detail = bounceTile?.querySelector(".today-metric-detail");
    expect(detail).toHaveTextContent(/deliverability/i);
    expect(detail).not.toHaveTextContent(ANALYTICS_DOWN);
    expect(detail).not.toHaveTextContent("% of sent");
  });

  it("leaves a rate unmeasured rather than printing 0.0% against a missing denominator", () => {
    const { container } = render(<TodaySoFarBar summary={instantlyDownFixture()} />);

    const replyTile = tile(container, "Replies");
    expect(replyTile).toHaveTextContent("7");
    expect(replyTile).toHaveTextContent(/no rate without today's send count/);
    expect(replyTile).not.toHaveTextContent("0.0%");
    expect(tile(container, "Unsubscribes")).not.toHaveTextContent("% of sent");
  });

  it("does not colour a tile as a breach when its rate is not available", () => {
    const { container } = render(<TodaySoFarBar summary={instantlyDownFixture()} />);

    expect(tile(container, "Bounces")).not.toHaveClass("warning");
    expect(tile(container, "Unsubscribes")).not.toHaveClass("warning");
  });

  it("keeps the tiles on screen when Instantly is down instead of saying nothing went out", () => {
    const { container } = render(<TodaySoFarBar summary={instantlyDownFixture()} />);

    expect(screen.queryByText(/No emails sent yet today/)).not.toBeInTheDocument();
    expect(container.querySelectorAll(".today-metric")).toHaveLength(5);
  });

  it("says why a figure is missing in the same words the deliverability page uses", () => {
    const { container } = render(<TodaySoFarBar summary={instantlyDownFixture()} />);

    expect(tile(container, "Sent")?.querySelector(".deliv-unavailable-label")).toHaveTextContent(
      "Not available",
    );
    expect(tile(container, "Sent")?.querySelector(".deliv-unavailable-reason")).toHaveTextContent(
      ANALYTICS_DOWN,
    );
  });

  it("says so when the numbers could not be loaded", () => {
    const { container } = render(<TodaySoFarBar summary={null} />);

    expect(screen.getByText(/Today so far could not be loaded/)).toBeInTheDocument();
    expect(container.querySelectorAll(".today-metric")).toHaveLength(0);
  });
});
