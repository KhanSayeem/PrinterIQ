import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PipelineConversion } from "@/db/queries";
import { ConversionChart } from "./ConversionChart";

const conversions: PipelineConversion[] = [
  { from: "imported", to: "enriched", label: "70.0%", rate: 70, count: 7, droppedCount: 3 },
  { from: "enriched", to: "qualified", label: "--", rate: null, count: 0, droppedCount: 0 },
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
      { from: "imported", to: "enriched", label: "70.0%", rate: 70, count: 7, droppedCount: 3 },
      { from: "enriched", to: "qualified", label: "50.0%", rate: 50, count: 4, droppedCount: 4 },
      { from: "qualified", to: "contacted", label: "25.0%", rate: 25, count: 1, droppedCount: 3 },
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

  it("says there is no prior stage data instead of inventing a percentage", () => {
    const { container } = render(<ConversionChart conversions={conversions} />);

    fireEvent.mouseEnter(hitAreas(container)[1]);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Qualified");
    expect(tooltip).toHaveTextContent("No prior stage data");
    expect(tooltip).not.toHaveTextContent("%");
  });

  it("keeps the chart readable without a charting library", () => {
    const { container } = render(<ConversionChart conversions={conversions} />);

    expect(container.querySelector("svg.conversion-chart-svg")).not.toBeNull();
    expect(screen.getByRole("img", { name: /Conversion between stages/ })).toBeInTheDocument();
  });
});
