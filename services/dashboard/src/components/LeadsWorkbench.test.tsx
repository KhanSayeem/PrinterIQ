import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadsWorkbench } from "./LeadsWorkbench";
import type { LeadListRow } from "./LeadQuickPanel";

const counts = { all: 5, qualified: 2, replied: 1, paid: 1, archived: 1 };

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

describe("LeadsWorkbench", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    window.history.replaceState(null, "", "/leads");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("selects rows and closes the quick panel without navigating", () => {
    render(<LeadsWorkbench {...baseProps} />);

    expect(screen.getByRole("complementary", { name: "Lead quick panel" })).toHaveClass("sticky-detail-panel");

    fireEvent.click(screen.getByRole("button", { name: "Preview Maya Jones" }));

    expect(screen.getByRole("complementary", { name: "Lead quick panel" })).toHaveClass("sticky-detail-panel");
    expect(screen.getByText("MJ")).toHaveClass("dp-avatar");
    expect(screen.getByText("MJ Electrical · Melbourne")).toBeInTheDocument();
    expect(screen.getByText("Can you send details?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close quick panel" }));

    expect(screen.getByText("Select a lead to preview details.")).toBeInTheDocument();
    const mayaRow = screen.getByRole("button", { name: "Preview Maya Jones" }).closest("tr");
    expect(mayaRow).not.toHaveClass("selected");
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
    expect(screen.getByRole("button", { name: "Preview Maya Jones" })).toBeInTheDocument();
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
        counts: { all: 5, qualified: 2, replied: 1, paid: 1, archived: 1 },
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
    expect(screen.getByRole("button", { name: "Preview Darren Smith" }).closest("tr")).toHaveClass("selected");
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
