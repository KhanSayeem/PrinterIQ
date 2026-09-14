import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SendsToDateBar } from "./SendsToDateBar";

describe("SendsToDateBar", () => {
  it("shows emails delivered to date, with what was sent and bounced beneath it", () => {
    const { container } = render(
      <SendsToDateBar
        sendsToDate={{ available: true, value: { sent: 75, bounced: 7, delivered: 68, contacted: 67 } }}
      />,
    );

    expect(screen.getByText("Since launch")).toBeInTheDocument();
    expect(screen.getByText("Delivered to date")).toBeInTheDocument();
    expect(container.querySelector(".today-metric-value")?.textContent).toBe("68");
    expect(screen.getByText("75 sent, 7 bounced (9.3%)")).toBeInTheDocument();
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/deliverability");
  });

  it("says why when the figure is missing, and never shows a zero", () => {
    const { container } = render(
      <SendsToDateBar sendsToDate={{ available: false, reason: "Instantly did not answer." }} />,
    );

    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("Instantly did not answer.")).toBeInTheDocument();
    expect(container.querySelector(".today-metric-value")?.textContent).not.toBe("0");
  });

  it("does not divide by zero before the first send", () => {
    const { container } = render(
      <SendsToDateBar
        sendsToDate={{ available: true, value: { sent: 0, bounced: 0, delivered: 0, contacted: 0 } }}
      />,
    );

    expect(screen.getByText("Nothing sent yet")).toBeInTheDocument();
    expect(container.textContent).not.toContain("NaN");
  });
});
