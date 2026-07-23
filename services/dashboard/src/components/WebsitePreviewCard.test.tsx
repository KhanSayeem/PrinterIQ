import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WebsitePreviewCard, type WebsitePreviewDetail } from "./WebsitePreviewCard";

const preview: WebsitePreviewDetail = {
  templateUsed: "plumbing",
  previewUrl: "https://preview.presciaiq.com/p/demo-preview/",
  personalisationData: {
    business_name: "Aqua Options",
    city: "Sydney",
    state: "NSW",
    industry: "Plumbing",
    specific_weakness: "No mobile",
  },
  promptVersion: "preview-personalise-v1",
  costUsd: "0.000100",
  generatedAt: new Date("2026-06-10T08:30:00.000Z"),
};

describe("WebsitePreviewCard", () => {
  it("renders the preview generating state when no website preview exists", () => {
    render(<WebsitePreviewCard websitePreview={null} outreachSent={false} />);

    expect(screen.getByText("Preview generating...")).toBeInTheDocument();
    expect(screen.getByText("Waiting for the preview worker to publish this lead's prototype.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open full preview" })).toBeNull();
  });

  it("renders preview metadata, iframe, and full preview link for a generated preview", () => {
    render(<WebsitePreviewCard websitePreview={preview} outreachSent />);

    expect(screen.getByRole("button", { name: "Plumbing" })).toHaveClass("active");
    expect(screen.getByTitle("Website preview desktop")).toHaveAttribute("src", preview.previewUrl);
    expect(screen.getByText("Tradie Pro - Plumbing")).toBeInTheDocument();
    expect(screen.getByText("Plumbing · NSW")).toBeInTheDocument();
    expect(screen.getByText("Business name, city, state, industry, specific weakness")).toBeInTheDocument();
    expect(screen.getByText("No mobile")).toBeInTheDocument();
    expect(screen.getByText("preview-personalise-v1")).toBeInTheDocument();
    expect(screen.getByText("$0.000100")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "Open full preview" });
    expect(link).toHaveAttribute("href", preview.previewUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("switches between desktop and mobile iframe viewports", () => {
    render(<WebsitePreviewCard websitePreview={preview} outreachSent={false} />);

    expect(screen.getByTitle("Website preview desktop")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mobile view" }));

    expect(screen.getByTitle("Website preview mobile")).toHaveAttribute("src", preview.previewUrl);
    expect(screen.queryByTitle("Website preview desktop")).toBeNull();
  });

  it("only shows the delivered badge when outreach has been sent", () => {
    const { rerender } = render(<WebsitePreviewCard websitePreview={preview} outreachSent={false} />);

    const sendRow = screen.getByText("Prototype link included in Step 1 opener").closest(".proto-send-row");
    expect(sendRow).not.toBeNull();
    expect(within(sendRow as HTMLElement).queryByText("Delivered")).toBeNull();

    rerender(<WebsitePreviewCard websitePreview={preview} outreachSent />);
    expect(within(screen.getByText("Prototype link included in Step 1 opener").closest(".proto-send-row") as HTMLElement).getByText("Delivered")).toBeInTheDocument();
  });
});
