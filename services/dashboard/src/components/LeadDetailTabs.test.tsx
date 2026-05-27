import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LeadDetailTabs } from "./LeadDetailTabs";

describe("LeadDetailTabs", () => {
  it("renders the four D1 detail tabs", () => {
    render(
      <LeadDetailTabs
        lead={{ email: "darren@example.com", phone: null, websiteUrl: null, linkedinUrl: null }}
        enrichment={null}
        qualification={null}
        conversations={[]}
        outreachSends={[]}
        payment={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outreach" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Payment" })).toBeInTheDocument();
  });
});
