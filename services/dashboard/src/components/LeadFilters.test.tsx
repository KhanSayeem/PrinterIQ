import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LeadFilters } from "./LeadFilters";

describe("LeadFilters", () => {
  it("renders only the reference filter pills with counts", () => {
    render(
      <LeadFilters
        activeStatus="qualified"
        searchValue=""
        counts={{ all: 5, qualified: 2, replied: 1, paid: 1, archived: 1 }}
        onSelect={() => {}}
        onSearchChange={() => {}}
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

  it("calls onSelect with the pill's status without navigating", () => {
    const onSelect = vi.fn();
    render(
      <LeadFilters
        activeStatus={undefined}
        searchValue=""
        counts={{ all: 5, qualified: 2, replied: 1, paid: 1, archived: 1 }}
        onSelect={onSelect}
        onSearchChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Qualified"));
    expect(onSelect).toHaveBeenCalledWith("qualified");

    fireEvent.click(screen.getByText("All"));
    expect(onSelect).toHaveBeenCalledWith(undefined);
  });

  it("disables the pills while a fetch is pending", () => {
    render(
      <LeadFilters
        activeStatus={undefined}
        searchValue=""
        counts={{ all: 5, qualified: 2, replied: 1, paid: 1, archived: 1 }}
        onSelect={() => {}}
        onSearchChange={() => {}}
        pending
      />,
    );

    expect(screen.getByText("Qualified").closest("button")).toBeDisabled();
  });

  it("shows the current search value and reports search changes", () => {
    const onSearchChange = vi.fn();
    render(
      <LeadFilters
        activeStatus={undefined}
        searchValue="kurt"
        counts={{ all: 5, qualified: 2, replied: 1, paid: 1, archived: 1 }}
        onSelect={() => {}}
        onSearchChange={onSearchChange}
      />,
    );

    const input = screen.getByPlaceholderText("Search leads");
    expect(input).toHaveValue("kurt");

    fireEvent.change(input, { target: { value: "coolcats" } });
    expect(onSearchChange).toHaveBeenCalledWith("coolcats");
  });
});
