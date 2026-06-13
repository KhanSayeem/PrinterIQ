import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LeadTable } from "./LeadTable";

describe("LeadTable", () => {
  it("uses the reference column order", () => {
    render(
      <LeadTable
        leads={[
          {
            id: "lead-1",
            firstName: "Darren",
            lastName: "Smith",
            businessName: "Aqua Options",
            city: "Sydney",
            state: "NSW",
            vertical: "tradies",
            status: "qualified",
            email: "darren@example.com",
            phone: null,
            websiteUrl: "https://example.com",
            score: 78,
            topWeakness: "Slow mobile site",
            weaknesses: [],
            personalisedOpener: null,
            latestConversation: null,
            updatedAt: new Date("2026-05-27T00:00:00Z"),
          },
        ]}
        selectedLeadId="lead-1"
        onSelectLead={() => undefined}
      />,
    );

    const headers = screen.getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toEqual(["Name", "Business", "State", "Status", "Score", "Last Activity"]);

    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByText("Aqua Options")).toBeInTheDocument();
    expect(within(row).getByText("27 May, 10:00 am")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Vertical" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Website" })).not.toBeInTheDocument();
  });

  it("renders mobile lead cards with a direct detail link", () => {
    render(
      <LeadTable
        leads={[
          {
            id: "lead-1",
            firstName: "Darren",
            lastName: "Smith",
            businessName: "Aqua Options",
            city: "Sydney",
            state: "NSW",
            vertical: "tradies",
            status: "qualified",
            email: "darren@example.com",
            phone: null,
            websiteUrl: "https://example.com",
            score: 78,
            topWeakness: "Slow mobile site",
            weaknesses: [],
            personalisedOpener: null,
            latestConversation: null,
            updatedAt: new Date("2026-05-27T00:00:00Z"),
          },
        ]}
        selectedLeadId="lead-1"
        onSelectLead={() => undefined}
      />,
    );

    const cards = screen.getByRole("list", { name: "Lead cards" });
    const card = within(cards).getByRole("listitem", { name: "Darren Smith" });

    const cardLink = within(card).getByRole("link", { name: "Open Darren Smith" });

    expect(cardLink).toHaveClass("lead-card");
    expect(cardLink).toHaveAttribute("href", "/leads/lead-1");
    expect(within(cardLink).getByText("Aqua Options")).toBeInTheDocument();
    expect(within(cardLink).getByText("NSW")).toBeInTheDocument();
    expect(within(cardLink).getByText("Score 78")).toBeInTheDocument();
  });
});
