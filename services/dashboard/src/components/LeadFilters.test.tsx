import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LeadFilters } from "./LeadFilters";

describe("LeadFilters", () => {
  it("renders only the reference filter pills with counts", () => {
    render(
      <LeadFilters
        activeStatus="qualified"
        counts={{ all: 5, qualified: 2, replied: 1, paid: 1, archived: 1 }}
      />,
    );

    expect(screen.getByText("All")).toBeInTheDocument();
    expect(screen.getByText("Qualified")).toHaveClass("active");
    expect(screen.getByText("Replied")).toBeInTheDocument();
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.queryByText("imported")).not.toBeInTheDocument();
    expect(screen.queryByText("enriched")).not.toBeInTheDocument();
    expect(screen.queryByText("contacted")).not.toBeInTheDocument();
  });
});
