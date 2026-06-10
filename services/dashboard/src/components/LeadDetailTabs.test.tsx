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
        websitePreview={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outreach" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Payment" })).toBeInTheDocument();
  });

  it("does not mark the preview opener delivered without a sent timestamp", () => {
    render(
      <LeadDetailTabs
        lead={{ email: "darren@example.com", phone: null, websiteUrl: null, linkedinUrl: null }}
        enrichment={null}
        qualification={null}
        conversations={[]}
        outreachSends={[
          {
            id: "send-1",
            step: 1,
            channel: "email",
            templateRef: "opener-v2",
            sentAt: null,
            delivered: true,
            opened: false,
            replied: false,
          },
        ]}
        payment={null}
        websitePreview={{
          templateUsed: "plumbing",
          previewUrl: "https://preview.presciaiq.com/p/demo-preview/",
          personalisationData: { industry: "Plumbing" },
          promptVersion: "preview-personalise-v1",
          costUsd: "0.000100",
          generatedAt: new Date("2026-06-10T08:30:00.000Z"),
        }}
      />,
    );

    expect(screen.queryByText("Delivered")).toBeNull();
  });
});
