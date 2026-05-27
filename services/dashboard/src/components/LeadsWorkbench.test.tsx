import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LeadsWorkbench } from "./LeadsWorkbench";
import type { LeadListRow } from "./LeadQuickPanel";

const leads: LeadListRow[] = [
  {
    id: "lead-1",
    firstName: "Darren",
    lastName: "Smith",
    businessName: "Aqua Options",
    city: "Sydney",
    state: "NSW",
    vertical: "plumbing",
    status: "qualified",
    email: "darren@example.com",
    phone: null,
    websiteUrl: "https://example.com",
    score: 78,
    topWeakness: "Slow mobile site",
    weaknesses: ["Slow mobile site"],
    personalisedOpener: null,
    latestConversation: null,
    updatedAt: new Date("2026-05-27T00:00:00Z"),
  },
  {
    id: "lead-2",
    firstName: "Maya",
    lastName: "Jones",
    businessName: "MJ Electrical",
    city: "Melbourne",
    state: "VIC",
    vertical: "electrical",
    status: "replied",
    email: "maya@example.com",
    phone: "0412 000 000",
    websiteUrl: null,
    score: 82,
    topWeakness: null,
    weaknesses: [],
    personalisedOpener: null,
    latestConversation: {
      id: "conversation-1",
      direction: "inbound",
      body: "Can you send details?",
      createdAt: new Date("2026-05-27T03:00:00Z"),
    },
    updatedAt: new Date("2026-05-27T01:00:00Z"),
  },
];

describe("LeadsWorkbench", () => {
  it("selects rows and closes the quick panel without navigating", () => {
    render(<LeadsWorkbench leads={leads} />);

    fireEvent.click(screen.getByText("MJ Electrical"));

    expect(screen.getByText("MJ Electrical · Melbourne, VIC · electrical")).toBeInTheDocument();
    expect(screen.getByText("Can you send details?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close quick panel" }));

    expect(screen.getByText("Select a lead to preview details.")).toBeInTheDocument();
    const mayaRow = screen.getByRole("button", { name: "Preview Maya Jones" }).closest("tr");
    expect(mayaRow).not.toHaveClass("selected");
  });

  it("renders the no-leads empty state outside the panel", () => {
    render(<LeadsWorkbench leads={[]} />);

    expect(screen.getByText("No leads yet. Import your Apollo CSV to get started.")).toBeInTheDocument();
    expect(within(screen.getByRole("complementary")).getByText("Select a lead to preview details.")).toBeInTheDocument();
  });
});
