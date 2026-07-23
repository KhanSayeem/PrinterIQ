import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LeadQuickPanel } from "./LeadQuickPanel";

const lead = {
  id: "lead-123",
  firstName: "Frank",
  lastName: "Parker",
  businessName: "Aqua Options",
  city: "Sydney",
  state: "NSW",
  vertical: "tradies",
  status: "qualified",
  email: "darren@example.com",
  phone: null,
  websiteUrl: null,
  score: 78,
  topWeakness: "Slow mobile site",
  weaknesses: [],
  personalisedOpener: "Your mobile site looks slow.",
  latestConversation: null,
  updatedAt: new Date("2026-05-27T00:00:00Z"),
};

describe("LeadQuickPanel", () => {
  it("links the open action to the full lead page", () => {
    render(
      <LeadQuickPanel
        tenantId="tenant-1"
        lead={lead}
      />,
    );

    expect(screen.getByLabelText("Open full lead page")).toHaveAttribute("href", "/leads/lead-123");
  });

  it("renders quick-panel empty states instead of placeholder data", () => {
    render(
      <LeadQuickPanel
        tenantId="tenant-1"
        lead={{
          ...lead,
          score: null,
          topWeakness: null,
          weaknesses: [],
          personalisedOpener: null,
        }}
      />,
    );

    expect(screen.getByText("No website weaknesses recorded yet.")).toBeInTheDocument();
    expect(screen.getByLabelText("No weaknesses recorded")).toBeInTheDocument();
    expect(screen.getByText("No messages yet.")).toBeInTheDocument();
    expect(screen.getByText("No phone on record")).toHaveClass("muted-placeholder");
    expect(screen.queryByText("score N/A / 100")).not.toBeInTheDocument();
  });

  it("renders the enriched compact card identity and action sections", () => {
    const addNote = vi.fn();
    const overrideReply = vi.fn();
    const pauseLead = vi.fn();

    render(
      <LeadQuickPanel
        tenantId="tenant-1"
        lead={lead}
        actions={{ addNote, overrideReply, pauseLead }}
      />,
    );

    expect(screen.getByText("FP")).toHaveClass("dp-avatar");
    expect(screen.getByText("Frank Parker")).toBeInTheDocument();
    expect(screen.getByText("Aqua Options · Sydney")).toBeInTheDocument();
    expect(screen.getByText("tradies")).toHaveClass("dp-chip");
    expect(screen.getByText("NSW")).toHaveClass("dp-chip");
    expect(screen.getByText("CONTACT")).toBeInTheDocument();
    expect(screen.getByText("ACTIONS")).toBeInTheDocument();
    expect(screen.getByText("LATEST MESSAGE")).toBeInTheDocument();
    for (const action of ["note", "reply", "pause"]) {
      const button = screen.getByRole("button", { name: action });
      expect(button).toBeEnabled();
      expect(button.textContent).toContain(action);
    }
    expect(screen.queryByText("score 78 / 100")).not.toBeInTheDocument();
    expect(screen.queryByText("qualified")).not.toBeInTheDocument();
  });

  it("styles the latest message as a note blockquote with right-aligned timestamp", () => {
    render(
      <LeadQuickPanel
        tenantId="tenant-1"
        lead={{
          ...lead,
          latestConversation: {
            id: "conversation-1",
            direction: "note",
            body: "Asked to follow up next week.",
            createdAt: new Date("2026-05-27T02:15:00Z"),
          },
        }}
      />,
    );

    expect(screen.getByText("Note")).toHaveClass("dp-message-badge");
    expect(screen.getByText("27 May, 12:15 pm")).toHaveClass("dp-message-time");
    expect(screen.getByText("Asked to follow up next week.").tagName).toBe("BLOCKQUOTE");
  });
});
