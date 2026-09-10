import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadsWorkbench } from "./LeadsWorkbench";
import type { LeadListRow } from "./LeadQuickPanel";

const counts = { all: 5, qualified: 2, contacted: 4, replied: 1, paid: 1, archived: 1, unsubscribed: 3, previewSeen: 2, previewUnseen: 4 };

const leads: LeadListRow[] = [
  {
    id: "lead-1",
    firstName: "Darren",
    lastName: "Smith",
    businessName: "Aqua Options",
    city: "Sydney",
    state: "NSW",
    vertical: "plumbing",
    status: "qualified",
    email: "darren@example.com",
    phone: null,
    websiteUrl: "https://example.com",
    score: 78,
    topWeakness: "Slow mobile site",
    weaknesses: ["Slow mobile site"],
    personalisedOpener: null,
    latestConversation: null,
    updatedAt: new Date("2026-05-27T00:00:00Z"),
  },
  {
    id: "lead-2",
    firstName: "Maya",
    lastName: "Jones",
    businessName: "MJ Electrical",
    city: "Melbourne",
    state: "VIC",
    vertical: "electrical",
    status: "replied",
    email: "maya@example.com",
    phone: "0412 000 000",
    websiteUrl: null,
    score: 82,
    topWeakness: null,
    weaknesses: [],
    personalisedOpener: null,
    latestConversation: {
      id: "conversation-1",
      direction: "inbound",
      body: "Can you send details?",
      createdAt: new Date("2026-05-27T03:00:00Z"),
    },
    updatedAt: new Date("2026-05-27T01:00:00Z"),
  },
];

const baseProps = {
  tenantId: "tenant-1",
  leads,
  counts,
  filters: {},
  total: 5,
  page: 1,
  totalPages: 2,
  pageSize: 2,
};

function mockLeadLayout(matchesDesktop: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: matchesDesktop,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function getTablePreviewButton(name: string) {
  const button = document.querySelector<HTMLButtonElement>(`.table-preview-btn[aria-label='Preview ${name}']`);
  if (!button) {
    throw new Error(`Could not find table preview button for ${name}`);
  }

  return button;
}

describe("LeadsWorkbench", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    mockLeadLayout(true);
    window.history.replaceState(null, "", "/leads");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("selects rows and closes the quick panel without navigating", async () => {
    render(<LeadsWorkbench {...baseProps} />);

    await waitFor(() => {
      expect(document.querySelector(".leads-screen")).toHaveClass("has-detail-panel");
      expect(screen.getByRole("complementary", { name: "Lead quick panel" })).toHaveClass("sticky-detail-panel");
    });

    fireEvent.click(getTablePreviewButton("Maya Jones"));

    expect(screen.getByRole("complementary", { name: "Lead quick panel" })).toHaveClass("sticky-detail-panel");
    expect(screen.getByText("MJ")).toHaveClass("dp-avatar");
    expect(screen.getByText("MJ Electrical · Melbourne")).toBeInTheDocument();
    expect(screen.getByText("Can you send details?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close quick panel" }));

    expect(screen.queryByRole("complementary", { name: "Lead quick panel" })).not.toBeInTheDocument();
    expect(screen.queryByText("Select a lead to preview details.")).not.toBeInTheDocument();
    expect(document.querySelector(".leads-screen")).not.toHaveClass("has-detail-panel");
    const mayaRow = getTablePreviewButton("Maya Jones").closest("tr");
    expect(mayaRow).not.toHaveClass("selected");
  });

  it("puts the today so far bar directly under the page header", () => {
    const { container } = render(
      <LeadsWorkbench
        {...baseProps}
        todaySummary={{
          dayLabel: "Mon 15 Jun",
          sent: { available: true, value: 200 },
          opens: null,
          opensTracked: false,
          replies: 7,
          bounces: { available: true, value: 4 },
          unsubscribes: 1,
          replyRate: { available: true, value: 3.5 },
          bounceRate: { available: true, value: 2 },
          unsubscribeRate: { available: true, value: 0.5 },
          bounceTone: "neutral",
          unsubscribeTone: "neutral",
          anySent: true,
          hasActivity: true,
        }}
      />,
    );

    const header = container.querySelector(".page-header");
    expect(header?.nextElementSibling).toHaveClass("today-bar");
    expect(screen.getByText("Today so far")).toBeInTheDocument();
    expect(screen.getByText(/Mon 15 Jun/)).toBeInTheDocument();
  });

  it("says the day could not be read rather than hiding the bar", () => {
    const { container } = render(<LeadsWorkbench {...baseProps} todaySummary={null} />);

    expect(container.querySelector(".today-bar")).toBeInTheDocument();
    expect(screen.getByText(/Today so far could not be loaded/)).toBeInTheDocument();
  });

  it("does not reserve the side-panel column until a lead is selected", () => {
    render(<LeadsWorkbench {...baseProps} leads={[]} total={0} totalPages={1} />);

    expect(screen.queryByRole("complementary", { name: "Lead quick panel" })).not.toBeInTheDocument();
    expect(document.querySelector(".leads-screen")).not.toHaveClass("has-detail-panel");
  });

  it("does not render the quick panel in the initial HTML", () => {
    const html = renderToString(<LeadsWorkbench {...baseProps} />);

    expect(html).not.toContain("Lead quick panel");
    expect(html).not.toContain("has-detail-panel");
  });

  it("opens the quick panel from a mobile lead card without reserving it by default", () => {
    mockLeadLayout(false);

    render(<LeadsWorkbench {...baseProps} />);

    const darrenCard = document.querySelector<HTMLButtonElement>(".lead-card[aria-label='Preview Darren Smith']");

    expect(darrenCard).not.toBeNull();
    expect(darrenCard).not.toHaveClass("selected");
    expect(screen.queryByRole("complementary", { name: "Lead quick panel" })).not.toBeInTheDocument();
    expect(document.querySelector(".leads-screen")).not.toHaveClass("has-detail-panel");

    fireEvent.click(darrenCard!);

    expect(screen.getByRole("complementary", { name: "Lead quick panel" })).toHaveClass("sticky-detail-panel");
    expect(darrenCard).toHaveClass("selected");
    expect(document.querySelector(".leads-screen")).toHaveClass("has-detail-panel");

    fireEvent.click(screen.getByRole("button", { name: "Close quick panel" }));

    expect(screen.queryByRole("complementary", { name: "Lead quick panel" })).not.toBeInTheDocument();
    expect(darrenCard).not.toHaveClass("selected");
    expect(document.querySelector(".leads-screen")).not.toHaveClass("has-detail-panel");
  });

  it("renders the no-leads empty state outside the panel", () => {
    render(<LeadsWorkbench {...baseProps} leads={[]} totalPages={1} total={0} />);

    expect(screen.getByText("No leads yet. Import your Apollo CSV to get started.")).toBeInTheDocument();
  });

  it("renders the page header subtitle and pagination from props", () => {
    render(<LeadsWorkbench {...baseProps} />);

    expect(screen.getByText("Leads")).toBeInTheDocument();
    expect(screen.getByText("5 contacts")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2 · 5 contacts")).toBeInTheDocument();
  });

  it("uploads a selected CSV file and shows the queued import state", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: "Import queued",
        jobId: "job-1",
        sourceFile: "apollo.csv",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LeadsWorkbench {...baseProps} />);

    fireEvent.change(screen.getByLabelText("Import CSV"), {
      target: { files: [new File(["Email\nlead@example.com\n"], "apollo.csv", { type: "text/csv" })] },
    });

    await waitFor(() => {
      expect(screen.getByText("apollo.csv queued for import. Pipeline processing will start shortly.")).toBeInTheDocument();
    });

    expect(screen.getByText("5 contacts")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2 · 5 contacts")).toBeInTheDocument();
    expect(screen.getByText("Aqua Options · Sydney")).toBeInTheDocument();
    expect(getTablePreviewButton("Maya Jones")).toBeInTheDocument();
    expect(screen.getAllByText("MJ Electrical").length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/import-csv",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
      }),
    );
    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit).body as FormData;
    expect(body.get("file")).toBeInstanceOf(File);
    expect(body.get("sourceFile")).toBeNull();
  });

  it("shows a loading state while the CSV upload is queued", () => {
    const fetchMock = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetchMock);

    render(<LeadsWorkbench {...baseProps} />);

    fireEvent.change(screen.getByLabelText("Import CSV"), {
      target: { files: [new File(["Email\nlead@example.com\n"], "apollo.csv", { type: "text/csv" })] },
    });

    expect(screen.getByText("Queueing...")).toBeInTheDocument();
    expect(screen.getByLabelText("Import CSV")).toBeDisabled();
  });

  it("shows the API validation message when CSV upload fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Upload an Apollo CSV file" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LeadsWorkbench {...baseProps} />);

    fireEvent.change(screen.getByLabelText("Import CSV"), {
      target: { files: [new File(["bad"], "apollo.txt", { type: "text/plain" })] },
    });

    await waitFor(() => {
      expect(screen.getByText("Upload an Apollo CSV file")).toBeInTheDocument();
    });
  });

  it("rejects a locally oversized CSV before calling the import API", async () => {
    vi.stubEnv("NEXT_PUBLIC_DASHBOARD_MAX_CSV_UPLOAD_MB", "1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<LeadsWorkbench {...baseProps} />);

    fireEvent.change(screen.getByLabelText("Import CSV"), {
      target: {
        files: [
          new File([new Uint8Array(1024 * 1024 + 1)], "apollo.csv", {
            type: "text/csv",
          }),
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByText("CSV file must be 1MB or smaller")).toBeInTheDocument();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a clear size message for non-JSON 413 upload responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LeadsWorkbench {...baseProps} />);

    fireEvent.change(screen.getByLabelText("Import CSV"), {
      target: { files: [new File(["Email\nlead@example.com\n"], "apollo.csv", { type: "text/csv" })] },
    });

    await waitFor(() => {
      expect(screen.getByText("CSV file must be 50MB or smaller")).toBeInTheDocument();
    });
  });

  it("shows the API message for JSON 413 upload responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      json: async () => ({ error: "CSV file must be 12MB or smaller" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LeadsWorkbench {...baseProps} />);

    fireEvent.change(screen.getByLabelText("Import CSV"), {
      target: { files: [new File(["Email\nlead@example.com\n"], "apollo.csv", { type: "text/csv" })] },
    });

    await waitFor(() => {
      expect(screen.getByText("CSV file must be 12MB or smaller")).toBeInTheDocument();
    });
    expect(screen.queryByText("CSV file must be 50MB or smaller")).not.toBeInTheDocument();
  });

  it("shows a pending state immediately when a filter pill is clicked, then swaps in fetched rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rows: [leads[1]],
        counts,
        total: 1,
        page: 1,
        totalPages: 1,
        pageSize: 25,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LeadsWorkbench {...baseProps} />);

    fireEvent.click(screen.getByText("Replied"));

    expect(document.querySelector(".is-pending")).not.toBeNull();

    await waitFor(() => {
      expect(screen.queryByText("Aqua Options · Sydney")).not.toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/leads?status=replied");
    expect(screen.getByText("MJ Electrical · Melbourne")).toBeInTheDocument();
    expect(window.location.search).toBe("?status=replied");
  });

  it("round-trips the contacted pill through the request and the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rows: [leads[1]],
        counts,
        total: 1,
        page: 1,
        totalPages: 1,
        pageSize: 25,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LeadsWorkbench {...baseProps} />);

    fireEvent.click(screen.getByText("Contacted"));

    await waitFor(() => {
      expect(window.location.search).toBe("?status=contacted");
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/leads?status=contacted");
    expect(screen.getByText("Contacted").closest("button")).toHaveClass("active");
  });

  it("restores the contacted pill as active from a status already in the URL", () => {
    render(<LeadsWorkbench {...baseProps} filters={{ status: "contacted" }} />);

    expect(screen.getByText("Contacted").closest("button")).toHaveClass("active");
    expect(screen.getByText("All").closest("button")).not.toHaveClass("active");
  });

  it("selects the first fetched row when filtering from an empty initial list", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rows: [leads[0]],
        counts,
        total: 1,
        page: 1,
        totalPages: 1,
        pageSize: 25,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LeadsWorkbench {...baseProps} leads={[]} filters={{ status: "paid" }} total={0} totalPages={1} />);

    fireEvent.click(screen.getByText("Qualified"));

    await waitFor(() => {
      expect(screen.getByText("Aqua Options · Sydney")).toBeInTheDocument();
    });

    expect(screen.queryByText("Select a lead to preview details.")).not.toBeInTheDocument();
    expect(screen.getByText("Aqua Options · Sydney")).toBeInTheDocument();
    expect(getTablePreviewButton("Darren Smith").closest("tr")).toHaveClass("selected");
  });

  it("requests the next page without navigation when pagination is clicked", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rows: [leads[0]],
        counts,
        total: 5,
        page: 2,
        totalPages: 2,
        pageSize: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LeadsWorkbench {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Page 2 of 2 · 5 contacts")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/leads?page=2");
    expect(window.location.search).toBe("?page=2");
  });

  it("searches leads through the API and keeps the search term in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rows: [leads[0]],
        counts,
        total: 1,
        page: 1,
        totalPages: 1,
        pageSize: 25,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LeadsWorkbench {...baseProps} />);

    fireEvent.change(screen.getByPlaceholderText("Search leads"), {
      target: { value: "coolcats" },
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/leads?q=coolcats");
    });
    expect(window.location.search).toBe("?q=coolcats");
    expect(screen.getByPlaceholderText("Search leads")).toHaveValue("coolcats");
  });

  it("preserves typed spaces in the search input while trimming the API query", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rows: [leads[0]],
        counts,
        total: 1,
        page: 1,
        totalPages: 1,
        pageSize: 25,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LeadsWorkbench {...baseProps} />);

    fireEvent.change(screen.getByPlaceholderText("Search leads"), {
      target: { value: "Cool " },
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/leads?q=Cool");
    });
    expect(screen.getByPlaceholderText("Search leads")).toHaveValue("Cool ");

    fireEvent.change(screen.getByPlaceholderText("Search leads"), {
      target: { value: "Cool Cats" },
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/leads?q=Cool+Cats");
    });
    expect(screen.getByPlaceholderText("Search leads")).toHaveValue("Cool Cats");
    expect(window.location.search).toBe("?q=Cool+Cats");
  });

  it("shows an error state and keeps the current rows when a filter fetch fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);

    render(<LeadsWorkbench {...baseProps} />);

    fireEvent.click(screen.getByText("Archived"));

    await waitFor(() => {
      expect(screen.getByText("Failed to refresh leads. Try again in a moment.")).toBeInTheDocument();
    });

    expect(screen.getByText("Aqua Options · Sydney")).toBeInTheDocument();
    expect(document.querySelector(".is-pending")).toBeNull();
    expect(window.location.search).toBe("");
  });
});
