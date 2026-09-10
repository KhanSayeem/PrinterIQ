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

const handoff = new Date("2026-06-10T08:31:00.000Z");

describe("WebsitePreviewCard", () => {
  it("renders the preview generating state when no website preview exists", () => {
    render(<WebsitePreviewCard websitePreview={null} handedToInstantlyAt={null} />);

    expect(screen.getByText("Preview generating...")).toBeInTheDocument();
    expect(screen.getByText("Waiting for the preview worker to publish this lead's prototype.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open full preview" })).toBeNull();
  });

  it("renders preview metadata, iframe, and full preview link for a generated preview", () => {
    render(<WebsitePreviewCard websitePreview={preview} handedToInstantlyAt={handoff} />);

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
    render(<WebsitePreviewCard websitePreview={preview} handedToInstantlyAt={null} />);

    expect(screen.getByTitle("Website preview desktop")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mobile view" }));

    expect(screen.getByTitle("Website preview mobile")).toHaveAttribute("src", preview.previewUrl);
    expect(screen.queryByTitle("Website preview desktop")).toBeNull();
  });

  it("never claims delivery, because the timestamp it has is only the handoff to Instantly", () => {
    render(<WebsitePreviewCard websitePreview={preview} handedToInstantlyAt={handoff} />);

    expect(screen.queryByText(/delivered/i)).toBeNull();
    expect(document.querySelector(".proto-sent-badge")).toBeNull();
  });

  it("reports the handoff to Instantly with its timestamp", () => {
    render(<WebsitePreviewCard websitePreview={preview} handedToInstantlyAt={handoff} />);

    const sendRow = screen.getByText("Prototype link included in the opener").closest(".proto-send-row");
    expect(sendRow).not.toBeNull();
    expect(within(sendRow as HTMLElement).getByText(/Handed to Instantly 10 June 2026/)).toBeInTheDocument();
    expect(within(sendRow as HTMLElement).getByText(/Instantly confirms no delivery back to this dashboard/)).toBeInTheDocument();
  });

  it("says nothing has been handed over when there is no handoff timestamp", () => {
    render(<WebsitePreviewCard websitePreview={preview} handedToInstantlyAt={null} />);

    const sendRow = screen.getByText("Prototype link included in the opener").closest(".proto-send-row");
    expect(within(sendRow as HTMLElement).getByText("Not handed to Instantly yet")).toBeInTheDocument();
    expect(within(sendRow as HTMLElement).queryByText(/Handed to Instantly/)).toBeNull();
  });

  it("only says the template went out with outreach once there is a handoff", () => {
    const { rerender } = render(<WebsitePreviewCard websitePreview={preview} handedToInstantlyAt={null} />);

    expect(screen.queryByText(/handed to Instantly · Generated/)).toBeNull();
    expect(screen.getByText(/^Industry-matched template · Generated 10 June 2026$/)).toBeInTheDocument();

    rerender(<WebsitePreviewCard websitePreview={preview} handedToInstantlyAt={handoff} />);
    expect(
      screen.getByText("Industry-matched template, included in the outreach handed to Instantly · Generated 10 June 2026"),
    ).toBeInTheDocument();
  });
});
