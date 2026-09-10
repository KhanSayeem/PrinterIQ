import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LeadDetailTabs } from "./LeadDetailTabs";

type TabsProps = Parameters<typeof LeadDetailTabs>[0];

const preview = {
  templateUsed: "plumbing",
  previewUrl: "https://preview.presciaiq.com/p/demo-preview/",
  personalisationData: { industry: "Plumbing" },
  promptVersion: "preview-personalise-v1",
  costUsd: "0.000100",
  generatedAt: new Date("2026-06-10T08:30:00.000Z"),
};

function outreachSend(overrides: Partial<TabsProps["outreachSends"][number]> = {}): TabsProps["outreachSends"][number] {
  return {
    id: "send-1",
    step: 1,
    channel: "email",
    templateRef: null,
    sentAt: new Date("2026-06-10T08:31:00.000Z"),
    delivered: false,
    opened: false,
    replied: false,
    ...overrides,
  };
}

function renderTabs(overrides: Partial<TabsProps> = {}) {
  return render(
    <LeadDetailTabs
      lead={{ email: "darren@example.com", phone: null, websiteUrl: null, linkedinUrl: null }}
      enrichment={null}
      qualification={null}
      conversations={[]}
      outreachSends={[]}
      payment={null}
      websitePreview={null}
      {...overrides}
    />,
  );
}

function enrichment(overrides: Partial<NonNullable<TabsProps["enrichment"]>> = {}) {
  return {
    cmsDetected: null,
    techSource: "playwright",
    loadMs: null,
    hasSsl: null,
    weaknesses: null,
    ...overrides,
  };
}

describe("LeadDetailTabs", () => {
  it("renders the four D1 detail tabs", () => {
    renderTabs();

    expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outreach" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Payment" })).toBeInTheDocument();
  });

  it("does not mark the preview opener handed over without a sent timestamp", () => {
    renderTabs({
      outreachSends: [outreachSend({ templateRef: "opener-v2", sentAt: null, delivered: true })],
      websitePreview: preview,
    });

    expect(screen.queryByText(/delivered/i)).toBeNull();
    expect(screen.getByText("Not handed to Instantly yet")).toBeInTheDocument();
  });

  it("calls a sent_at timestamp a handoff to Instantly, never a delivery", () => {
    renderTabs({
      outreachSends: [outreachSend({ templateRef: "opener-v2" })],
      websitePreview: preview,
    });

    expect(screen.queryByText(/delivered/i)).toBeNull();
    expect(screen.getByText(/Handed to Instantly 10 June 2026/)).toBeInTheDocument();
  });

  it("reports an unaudited site's SSL as unknown rather than missing", () => {
    renderTabs({ enrichment: enrichment({ hasSsl: null }) });

    expect(screen.getByText("SSL").nextElementSibling).toHaveTextContent("Unknown (site not reached)");
  });

  it("still reports SSL as missing when the audit actually looked", () => {
    renderTabs({ enrichment: enrichment({ hasSsl: false }) });

    expect(screen.getByText("SSL").nextElementSibling).toHaveTextContent("Missing");
  });

  it("reports SSL as present when the audit found it", () => {
    renderTabs({ enrichment: enrichment({ hasSsl: true }) });

    expect(screen.getByText("SSL").nextElementSibling).toHaveTextContent("Present");
  });

  it("shows a zero millisecond load time as a measurement, not a blank", () => {
    renderTabs({ enrichment: enrichment({ loadMs: 0 }) });

    expect(screen.getByText("Load time").nextElementSibling).toHaveTextContent("0ms");
  });

  it("keeps an unmeasured load time as a placeholder", () => {
    renderTabs({ enrichment: enrichment({ loadMs: null }) });

    expect(screen.getByText("Load time").nextElementSibling).toHaveTextContent("--");
  });

  it("does not print a step number the pipeline never writes, and says where follow-ups live", () => {
    renderTabs({ outreachSends: [outreachSend({ templateRef: "opener-v2" })] });
    fireEvent.click(screen.getByRole("button", { name: "Outreach" }));

    expect(screen.queryByText(/^Step \d/)).toBeNull();
    expect(screen.getByText(/Instantly sends the opener and every follow-up/)).toBeInTheDocument();
  });

  it("does not pass a channel off as a template name", () => {
    renderTabs({ outreachSends: [outreachSend({ templateRef: null, channel: "email" })] });
    fireEvent.click(screen.getByRole("button", { name: "Outreach" }));

    expect(screen.getByText("No template recorded")).toBeInTheDocument();
  });

  it("renders website and LinkedIn values as external links without changing display text", () => {
    renderTabs({
      lead: {
        email: "darren@example.com",
        phone: null,
        websiteUrl: "aquaoptions.com.au",
        linkedinUrl: "https://linkedin.com/company/aqua-options",
      },
    });

    expect(screen.getByRole("link", { name: "aquaoptions.com.au" })).toHaveAttribute("href", "https://aquaoptions.com.au");
    expect(screen.getByRole("link", { name: "aquaoptions.com.au" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "aquaoptions.com.au" })).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByRole("link", { name: "https://linkedin.com/company/aqua-options" })).toHaveAttribute(
      "href",
      "https://linkedin.com/company/aqua-options",
    );
  });

  it("keeps missing website and LinkedIn values as placeholders", () => {
    renderTabs();

    expect(screen.getByText("Website").nextElementSibling).toHaveTextContent("--");
    expect(screen.getByText("LinkedIn").nextElementSibling).toHaveTextContent("--");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
