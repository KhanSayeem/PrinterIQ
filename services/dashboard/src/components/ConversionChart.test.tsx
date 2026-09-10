import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PipelineConversion } from "@/lib/pipeline-funnel";
import { ConversionChart } from "./ConversionChart";

function measured(value: number) {
  return { available: true as const, value };
}

function missing(reason: string) {
  return { available: false as const, reason };
}

const conversions: PipelineConversion[] = [
  {
    from: "imported",
    to: "enriched",
    rate: measured(70),
    count: measured(7),
    enteredCount: measured(10),
    droppedCount: measured(3),
  },
  {
    from: "enriched",
    to: "qualified",
    rate: missing("No leads ever reached Enriched, so there is no rate to measure"),
    count: measured(0),
    enteredCount: measured(0),
    droppedCount: measured(0),
  },
];

function hitAreas(container: HTMLElement) {
  return [...container.querySelectorAll(".cc-hit")];
}

describe("ConversionChart", () => {
  it("gives every conversion a hover target", () => {
    const { container } = render(<ConversionChart conversions={conversions} />);

    expect(hitAreas(container)).toHaveLength(2);
  });

  it("shows no tooltip before anything is hovered", () => {
    render(<ConversionChart conversions={conversions} />);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows the stage name, the count and the percentage on hover", () => {
    const { container } = render(<ConversionChart conversions={conversions} />);

    fireEvent.mouseEnter(hitAreas(container)[0]);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Enriched");
    expect(tooltip).toHaveTextContent("7 of 10 leads");
    expect(tooltip).toHaveTextContent("70.0% of Imported");
  });

  it("shows the hovered bar's own numbers, not the first bar's", () => {
    const threeBars: PipelineConversion[] = [
      {
        from: "imported",
        to: "enriched",
        rate: measured(70),
        count: measured(7),
        enteredCount: measured(10),
        droppedCount: measured(3),
      },
      {
        from: "enriched",
        to: "qualified",
        rate: measured(50),
        count: measured(4),
        enteredCount: measured(8),
        droppedCount: measured(4),
      },
      {
        from: "qualified",
        to: "contacted",
        rate: measured(25),
        count: measured(1),
        enteredCount: measured(4),
        droppedCount: measured(3),
      },
    ];
    const { container } = render(<ConversionChart conversions={threeBars} />);

    fireEvent.mouseEnter(hitAreas(container)[2]);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Contacted");
    expect(tooltip).toHaveTextContent("1 of 4 leads");
    expect(tooltip).toHaveTextContent("25.0% of Qualified");
    expect(tooltip).not.toHaveTextContent("70.0%");
  });

  it("hides the tooltip once the pointer leaves the bar", () => {
    const { container } = render(<ConversionChart conversions={conversions} />);

    fireEvent.mouseEnter(hitAreas(container)[0]);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.mouseLeave(hitAreas(container)[0]);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("gives the reason a rate is missing instead of inventing a percentage", () => {
    const { container } = render(<ConversionChart conversions={conversions} />);

    fireEvent.mouseEnter(hitAreas(container)[1]);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Qualified");
    expect(tooltip).toHaveTextContent("No leads ever reached Enriched");
    expect(tooltip).not.toHaveTextContent("%");
  });

  it("keeps the chart readable without a charting library", () => {
    const { container } = render(<ConversionChart conversions={conversions} />);

    expect(container.querySelector("svg.conversion-chart-svg")).not.toBeNull();
    expect(screen.getByRole("img", { name: /Conversion between stages/ })).toBeInTheDocument();
  });

  /**
   * The live regression. Qualified sat at 2 and contacted at 1951 in
   * `leads.status`, and this label rendered 97550.0% over a bar that the old
   * clamp drew at a healthy full height. Cohort figures make it a real rate.
   */
  it("renders the live qualified to contacted step as a sane percentage", () => {
    render(
      <ConversionChart
        conversions={[
          {
            from: "qualified",
            to: "contacted",
            rate: measured((6480 / 7120) * 100),
            count: measured(6480),
            enteredCount: measured(7120),
            droppedCount: measured(640),
          },
        ]}
      />,
    );

    expect(screen.getByText("91.0%")).toBeInTheDocument();
    expect(screen.queryByText(/9755/)).not.toBeInTheDocument();
    expect(screen.getByText("6,480 of 7,120")).toBeInTheDocument();
    expect(screen.getByText("640 dropped")).toBeInTheDocument();
  });

  it("says a missing rate is not available rather than drawing it as zero", () => {
    const { container } = render(
      <ConversionChart
        conversions={[
          {
            from: "contacted",
            to: "replied",
            rate: missing("A webhook bug dropped inbound replies"),
            count: missing("A webhook bug dropped inbound replies"),
            enteredCount: measured(6480),
            droppedCount: missing("A webhook bug dropped inbound replies"),
          },
        ]}
      />,
    );

    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByText("0.0%")).not.toBeInTheDocument();
    expect(screen.queryByText("0 dropped")).not.toBeInTheDocument();
    expect(screen.getByText("6,480 reached Contacted")).toBeInTheDocument();
    expect(container.querySelector(".cc-bar")).toBeNull();
  });

  /**
   * A rate over 100% means the later cohort is bigger than the earlier one.
   * Raising the qualification threshold does that: 1,960 leads were contacted
   * under the old threshold and only 1,500 pass the new one. The bar has to
   * stay inside the plot, but it must not read as a healthy complete bar and
   * the label must still print the true figure.
   */
  it("keeps a rate above 100% inside the plot and still prints the true figure", () => {
    const { container } = render(
      <ConversionChart
        conversions={[
          {
            from: "qualified",
            to: "contacted",
            rate: measured((1960 / 1500) * 100),
            count: measured(1960),
            enteredCount: measured(1500),
            droppedCount: missing("More leads reached Contacted than ever reached Qualified"),
          },
        ]}
      />,
    );

    const bar = container.querySelector(".cc-bar");
    expect(bar).not.toBeNull();
    expect(Number(bar?.getAttribute("height"))).toBeLessThanOrEqual(170);
    expect(bar?.getAttribute("class")).toContain("cc-bar-over");
    expect(screen.getByText("130.7%")).toBeInTheDocument();
    expect(screen.getByText("1,960 of 1,500")).toBeInTheDocument();
    expect(screen.getByText("Drop not measurable")).toBeInTheDocument();
  });

  /**
   * 7,543 of 7,546 scored is not 100%, and printing it as "100.0%" over a
   * "3 dropped" label contradicts itself.
   */
  it("does not round an incomplete rate up to a full one hundred percent", () => {
    render(
      <ConversionChart
        conversions={[
          {
            from: "enriched",
            to: "scored",
            rate: measured((7543 / 7546) * 100),
            count: measured(7543),
            enteredCount: measured(7546),
            droppedCount: measured(3),
          },
        ]}
      />,
    );

    expect(screen.getByText("just under 100%")).toBeInTheDocument();
    expect(screen.queryByText("100.0%")).not.toBeInTheDocument();
    expect(screen.getByText("3 dropped")).toBeInTheDocument();
  });

  /**
   * The pass rate step, with the production figures. This is the bar an
   * operator reads to see that scoring is the largest filter in the business.
   */
  it("renders the scored to qualified pass rate from the production cohorts", () => {
    render(
      <ConversionChart
        conversions={[
          {
            from: "scored",
            to: "qualified",
            rate: measured((4291 / 7543) * 100),
            count: measured(4291),
            enteredCount: measured(7543),
            droppedCount: measured(3252),
          },
        ]}
      />,
    );

    expect(screen.getByText("56.9%")).toBeInTheDocument();
    expect(screen.getByText("4,291 of 7,543")).toBeInTheDocument();
    expect(screen.getByText("3,252 dropped")).toBeInTheDocument();
  });
});
