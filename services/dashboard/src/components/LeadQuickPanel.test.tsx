import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LeadQuickPanel } from "./LeadQuickPanel";

describe("LeadQuickPanel", () => {
  it("links the open action to the full lead page", () => {
    render(
      <LeadQuickPanel
        lead={{
          id: "lead-123",
          firstName: "Darren",
          lastName: "Smith",
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
        }}
      />,
    );

    expect(screen.getByLabelText("Open full lead page")).toHaveAttribute("href", "/leads/lead-123");
  });

  it("renders quick-panel empty states instead of placeholder data", () => {
    render(
      <LeadQuickPanel
        lead={{
          id: "lead-123",
          firstName: "Darren",
          lastName: "Smith",
          businessName: "Aqua Options",
          city: "Sydney",
          state: "NSW",
          vertical: "tradies",
          status: "qualified",
          email: "darren@example.com",
          phone: null,
          websiteUrl: null,
          score: null,
          topWeakness: null,
          weaknesses: [],
          personalisedOpener: null,
          latestConversation: null,
          updatedAt: new Date("2026-05-27T00:00:00Z"),
        }}
      />,
    );

    expect(screen.getByText("No website weaknesses recorded yet.")).toBeInTheDocument();
    expect(screen.getByText("No messages yet.")).toBeInTheDocument();
    for (const action of ["Note", "Reply", "Pause"]) {
      expect(screen.getByRole("button", { name: action })).toBeDisabled();
    }
  });
});
