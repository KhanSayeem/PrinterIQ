import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PipelineFunnel } from "./PipelineFunnel";

describe("PipelineFunnel", () => {
  it("renders all pipeline stages with zero-filled counts", () => {
    const { container } = render(
      <PipelineFunnel
        stages={[
          { status: "imported", label: "Imported", count: 1, totalRate: 100 },
          { status: "enriched", label: "Enriched", count: 1, totalRate: 100 },
          { status: "qualified", label: "Qualified", count: 1, totalRate: 100 },
          { status: "contacted", label: "Contacted", count: 1, totalRate: 100 },
          { status: "replied", label: "Replied", count: 0, totalRate: 0 },
          { status: "paid", label: "Paid", count: 0, totalRate: 0 },
          { status: "archived", label: "Archived", count: 1, totalRate: 100 },
        ]}
        conversions={[
          { from: "imported", to: "enriched", label: "100.0%", rate: 100, count: 1, droppedCount: 0 },
          { from: "enriched", to: "qualified", label: "100.0%", rate: 100, count: 1, droppedCount: 0 },
          { from: "qualified", to: "contacted", label: "100.0%", rate: 100, count: 1, droppedCount: 0 },
          { from: "contacted", to: "replied", label: "0.0%", rate: 0, count: 0, droppedCount: 1 },
          { from: "replied", to: "paid", label: "--", rate: null, count: 0, droppedCount: 0 },
        ]}
        selectedStage="imported"
      />,
    );

    const stageNames = [...container.querySelectorAll(".stage-name")].map((node) => node.textContent);
    expect(stageNames).toEqual(["Imported", "Enriched", "Qualified", "Contacted", "Replied", "Paid", "Archived"]);
    expect(container.querySelectorAll(".stage-count")).toHaveLength(7);
    expect(screen.getByText("No prior stage data")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Conversion between stages/ })).toBeInTheDocument();
  });

  it("links stage cards to URL-selected stage state", () => {
    render(
      <PipelineFunnel
        stages={[
          { status: "imported", label: "Imported", count: 1, totalRate: 100 },
          { status: "qualified", label: "Qualified", count: 1, totalRate: 100 },
        ]}
        conversions={[
          { from: "imported", to: "qualified", label: "100.0%", rate: 100, count: 1, droppedCount: 0 },
        ]}
        selectedStage="qualified"
      />,
    );

    expect(screen.getByRole("link", { name: /Imported/ })).toHaveAttribute("href", "/pipeline?stage=imported");
    expect(screen.getByRole("link", { name: /Qualified/ })).toHaveClass("selected");
  });

  it("renders richer conversion rows with count and drop-off labels", () => {
    render(
      <PipelineFunnel
        stages={[
          { status: "imported", label: "Imported", count: 10, totalRate: 100 },
          { status: "enriched", label: "Enriched", count: 7, totalRate: 70 },
        ]}
        conversions={[
          { from: "imported", to: "enriched", label: "70.0%", rate: 70, count: 7, droppedCount: 3 },
        ]}
        selectedStage="imported"
      />,
    );

    expect(screen.getByText("7 of 10")).toBeInTheDocument();
    expect(screen.getByText("3 dropped")).toBeInTheDocument();
    expect(screen.getByText("70.0%")).toBeInTheDocument();
  });

  it("draws a conversion bar whose height tracks the rate", () => {
    const { container } = render(
      <PipelineFunnel
        stages={[
          { status: "imported", label: "Imported", count: 10, totalRate: 100 },
          { status: "enriched", label: "Enriched", count: 5, totalRate: 50 },
        ]}
        conversions={[
          { from: "imported", to: "enriched", label: "50.0%", rate: 50, count: 5, droppedCount: 5 },
        ]}
        selectedStage="imported"
      />,
    );

    const bar = container.querySelector(".cc-bar");
    expect(bar).not.toBeNull();
    expect(Number(bar?.getAttribute("height"))).toBeCloseTo(85, 0);
  });

  it("marks a transition without a prior stage instead of drawing a bar", () => {
    const { container } = render(
      <PipelineFunnel
        stages={[
          { status: "replied", label: "Replied", count: 0, totalRate: 0 },
          { status: "paid", label: "Paid", count: 0, totalRate: 0 },
        ]}
        conversions={[{ from: "replied", to: "paid", label: "--", rate: null, count: 0, droppedCount: 0 }]}
        selectedStage="paid"
      />,
    );

    expect(container.querySelector(".cc-bar")).toBeNull();
    expect(container.querySelector(".cc-bar-empty")).not.toBeNull();
    expect(screen.getByText("No prior stage data")).toBeInTheDocument();
  });
});
