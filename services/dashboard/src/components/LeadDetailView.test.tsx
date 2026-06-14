import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LeadDetailView } from "./LeadDetailView";

const lead = {
  id: "lead-1",
  firstName: "Darren",
  lastName: "Smith",
  email: "darren@example.com",
  phone: "0400000000",
  businessName: "Aqua Options",
  city: "Sydney",
  state: "NSW",
  vertical: "plumbing",
  status: "contacted",
  websiteUrl: "https://example.com",
  linkedinUrl: null,
};

describe("LeadDetailView", () => {
  it("renders one sticky header with status, actual score, and actions before the tabs", () => {
    render(
      <LeadDetailView
        tenantId="tenant-1"
        lead={lead}
        enrichment={null}
        qualification={{
          score: 83,
          rationale: "Good fit",
          topWeakness: "Mobile speed",
          personalisedOpener: "Saw your site.",
          followup1: null,
          followup2: null,
        }}
        conversations={[]}
        outreachSends={[]}
        payment={null}
      />,
    );

    const header = screen.getByRole("banner", { name: "Lead detail header" });
    expect(within(header).getByText("contacted")).toHaveClass("s-contacted");
    expect(within(header).getByText("score 83 / 100")).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Add note" })).toBeInTheDocument();

    const tabs = screen.getByRole("tablist", { name: "Lead detail tabs" });
    expect(header.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("enables override replies only when the conversation has Instantly reply metadata", () => {
    const { unmount } = render(
      <LeadDetailView
        tenantId="tenant-1"
        lead={lead}
        enrichment={null}
        qualification={null}
        conversations={[]}
        outreachSends={[]}
        payment={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Override reply" })).toBeDisabled();
    unmount();

    render(
      <LeadDetailView
        tenantId="tenant-1"
        lead={lead}
        enrichment={null}
        qualification={null}
        conversations={[
          {
            id: "inbound-1",
            direction: "inbound",
            channel: "email",
            body: "Can you send details?",
            createdAt: new Date("2026-05-27T10:00:00.000Z"),
            instantlyEmailId: "email-uuid-123",
            instantlyAccountId: "sender@example.com",
          },
        ]}
        outreachSends={[]}
        payment={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Override reply" })).toBeEnabled();
  });

  it("keeps contact info inside the Overview tab and deletes notes from the Conversation tab", async () => {
    const deleteNote = vi.fn(async () => ({ ok: true, message: "Note deleted.", deletedConversationId: "note-1" }));

    render(
      <LeadDetailView
        tenantId="tenant-1"
        lead={lead}
        enrichment={null}
        qualification={null}
        conversations={[
          {
            id: "note-1",
            direction: "note",
            channel: "note",
            body: "Called and left voicemail",
            createdAt: new Date("2026-05-27T10:00:00.000Z"),
          },
        ]}
        outreachSends={[]}
        payment={null}
        actions={{ deleteNote }}
        now={new Date("2026-05-27T12:00:00.000Z")}
      />,
    );

    expect(screen.getByText("darren@example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete note" }));

    expect(deleteNote).toHaveBeenCalled();
    expect(await screen.findByText("Note deleted.")).toBeInTheDocument();
    expect(screen.queryByText("Called and left voicemail")).toBeNull();
  });
});
