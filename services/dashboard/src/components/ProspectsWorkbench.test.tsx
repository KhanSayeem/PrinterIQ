import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProspectsWorkbench } from "./ProspectsWorkbench";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const activeRun = {
  id: "run-1",
  status: "submitted",
  source: "outscraper",
  sourceRequestId: "provider-123",
  discoveredCount: 0,
  usableCount: 0,
  routeACount: 0,
  routeBCount: 0,
  verifiedContactCount: 0,
  failureCode: null,
  failureDetail: null,
  createdAt: "2026-07-22T08:00:00.000Z",
  updatedAt: "2026-07-22T08:00:00.000Z",
};

describe("ProspectsWorkbench", () => {
  beforeEach(() => refresh.mockReset());

  it("shows the fixed preset and start control in the empty state", () => {
    render(<ProspectsWorkbench initialRun={null} startAction={vi.fn()} />);

    expect(screen.getByText("Greater Brisbane plumbing")).toBeInTheDocument();
    expect(screen.getByText(/Brisbane, Logan, Ipswich, Moreton Bay, and Redlands/i)).toBeInTheDocument();
    expect(screen.getByText(/500 businesses maximum/i)).toBeInTheDocument();
    expect(screen.getByText(/No discovery runs yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start discovery run/i })).toBeInTheDocument();
  });

  it("does not offer another start while a run is active", () => {
    render(<ProspectsWorkbench initialRun={activeRun} startAction={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /start discovery run/i })).not.toBeInTheDocument();
    expect(screen.getByText(/A discovery run is active/i)).toBeInTheDocument();
  });

  it("allows another run after raw discovery results are persisted", () => {
    render(
      <ProspectsWorkbench
        initialRun={{ ...activeRun, status: "persisted" }}
        startAction={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /start discovery run/i })).toBeInTheDocument();
    expect(screen.queryByText(/A discovery run is active/i)).not.toBeInTheDocument();
  });

  it("surfaces a rejected start action", async () => {
    const startAction = vi.fn().mockResolvedValue({ ok: false, message: "A discovery run is already active." });
    render(<ProspectsWorkbench initialRun={null} startAction={startAction} />);

    fireEvent.click(screen.getByRole("button", { name: /start discovery run/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A discovery run is already active.");
  });

  it("refreshes after a successful start", async () => {
    const startAction = vi.fn().mockResolvedValue({ ok: true, message: "Discovery run started." });
    render(<ProspectsWorkbench initialRun={null} startAction={startAction} />);

    fireEvent.click(screen.getByRole("button", { name: /start discovery run/i }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByText("Discovery run started.")).toBeInTheDocument();
  });

  it("requests fresh server data from the run status control", () => {
    render(<ProspectsWorkbench initialRun={activeRun} startAction={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /refresh run status/i }));

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("shows Route A website ownership and exact evidence for social-only prospects", () => {
    render(
      <ProspectsWorkbench
        initialRun={{ ...activeRun, status: "processing", routeACount: 1, usableCount: 1 }}
        initialProspects={[
          {
            id: "prospect-1",
            businessName: "Northside Plumbing",
            route: "A",
            status: "assessed",
            websiteOwnership: "social",
            outcomeReason: "no_owned_website",
            sourceWebsiteUrl: "https://facebook.com/northsideplumbing",
            normalizedDomain: "facebook.com",
            ruleEvidence: {
              eligibility: { outcome: "eligible" },
              website: {
                ownership: "social",
                reason: "no_owned_website",
                final_url: "https://facebook.com/northsideplumbing",
              },
            },
          },
        ]}
        startAction={vi.fn()}
      />,
    );

    expect(screen.getByText("Northside Plumbing")).toBeInTheDocument();
    expect(screen.getAllByText("Route A").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Social profile")).toBeInTheDocument();
    expect(screen.getAllByText("no_owned_website").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/facebook.com\/northsideplumbing/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Final URL")).toBeInTheDocument();
    expect(screen.getByText("Ownership reason")).toBeInTheDocument();
    expect(screen.getByText("facebook.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/preview/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/outreach/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/campaign/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/promote/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Instantly/i)).not.toBeInTheDocument();
  });
});
