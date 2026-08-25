import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LeadFilters } from "./LeadFilters";

const counts = {
  all: 5,
  qualified: 2,
  replied: 1,
  paid: 1,
  archived: 1,
  unsubscribed: 3,
  previewSeen: 2,
  previewUnseen: 4,
};

describe("LeadFilters", () => {
  it("renders only the reference filter pills with counts", () => {
    render(
      <LeadFilters
        activeStatus="qualified"
        searchValue=""
        counts={counts}
        onSelect={() => {}}
        onPreviewSelect={() => {}}
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
        counts={counts}
        onSelect={onSelect}
        onPreviewSelect={() => {}}
        onSearchChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Qualified"));
    expect(onSelect).toHaveBeenCalledWith({ status: "qualified" });

    fireEvent.click(screen.getByText("All"));
    expect(onSelect).toHaveBeenCalledWith({});
  });

  it("shows the unsubscribed pill with its own count and selects it exclusively", () => {
    const onSelect = vi.fn();
    render(
      <LeadFilters
        activeStatus={undefined}
        searchValue=""
        counts={counts}
        onSelect={onSelect}
        onPreviewSelect={() => {}}
        onSearchChange={() => {}}
      />,
    );

    const unsubscribed = screen.getByText("Unsubscribed").closest("button");
    expect(unsubscribed).toHaveTextContent("3");

    fireEvent.click(screen.getByText("Unsubscribed"));
    expect(onSelect).toHaveBeenCalledWith({ unsubscribed: true });
  });

  it("marks the unsubscribed pill active and leaves All inactive while it is applied", () => {
    render(
      <LeadFilters
        activeStatus={undefined}
        activeUnsubscribed
        searchValue=""
        counts={counts}
        onSelect={() => {}}
        onPreviewSelect={() => {}}
        onSearchChange={() => {}}
      />,
    );

    expect(screen.getByText("Unsubscribed").closest("button")).toHaveClass("active");
    expect(screen.getByText("All").closest("button")).not.toHaveClass("active");
  });

  it("reports preview seen and unseen selections and toggles the active one off", () => {
    const onPreviewSelect = vi.fn();
    const { rerender } = render(
      <LeadFilters
        activeStatus={undefined}
        searchValue=""
        counts={counts}
        onSelect={() => {}}
        onPreviewSelect={onPreviewSelect}
        onSearchChange={() => {}}
      />,
    );

    expect(screen.getByText("Preview seen").closest("button")).toHaveTextContent("2");
    expect(screen.getByText("Preview unseen").closest("button")).toHaveTextContent("4");

    fireEvent.click(screen.getByText("Preview unseen"));
    expect(onPreviewSelect).toHaveBeenCalledWith("unseen");

    rerender(
      <LeadFilters
        activeStatus={undefined}
        activePreviewView="unseen"
        searchValue=""
        counts={counts}
        onSelect={() => {}}
        onPreviewSelect={onPreviewSelect}
        onSearchChange={() => {}}
      />,
    );

    expect(screen.getByText("Preview unseen").closest("button")).toHaveClass("active");
    fireEvent.click(screen.getByText("Preview unseen"));
    expect(onPreviewSelect).toHaveBeenLastCalledWith(undefined);
  });

  it("disables the pills while a fetch is pending", () => {
    render(
      <LeadFilters
        activeStatus={undefined}
        searchValue=""
        counts={counts}
        onSelect={() => {}}
        onPreviewSelect={() => {}}
        onSearchChange={() => {}}
        pending
      />,
    );

    expect(screen.getByText("Qualified").closest("button")).toBeDisabled();
    expect(screen.getByText("Preview seen").closest("button")).toBeDisabled();
  });

  it("shows the current search value and reports search changes", () => {
    const onSearchChange = vi.fn();
    render(
      <LeadFilters
        activeStatus={undefined}
        searchValue="kurt"
        counts={counts}
        onSelect={() => {}}
        onPreviewSelect={() => {}}
        onSearchChange={onSearchChange}
      />,
    );

    const input = screen.getByPlaceholderText("Search leads");
    expect(input).toHaveValue("kurt");

    fireEvent.change(input, { target: { value: "coolcats" } });
    expect(onSearchChange).toHaveBeenCalledWith("coolcats");
  });
});
