"use client";

import { Upload } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LeadFilterCounts, TodaySoFarSummary } from "@/db/queries";
import type { LeadListFilterParams, PreviewViewFilter } from "@/lib/lead-list-params";
import { LeadFilters, type LeadFilterSelection } from "./LeadFilters";
import { LeadQuickPanelWithClose, type LeadListRow } from "./LeadQuickPanel";
import { LeadTable } from "./LeadTable";
import { TodaySoFarBar } from "./TodaySoFarBar";

type LeadListFilters = Omit<LeadListFilterParams, "page">;

type LeadListResponse = {
  rows: LeadListRow[];
  counts: LeadFilterCounts;
  total: number;
  page: number;
  totalPages: number;
  pageSize: number;
};

type ImportCsvResponse = {
  message?: string;
  jobId?: string;
  sourceFile?: string;
  error?: string;
};

const defaultMaxCsvUploadMegabytes = 50;

function buildLeadListQuery(filters: LeadListFilters, page: number) {
  const query = new URLSearchParams();
  if (filters.status) query.set("status", filters.status);
  if (filters.state) query.set("state", filters.state);
  if (filters.tradeType) query.set("trade_type", filters.tradeType);
  if (filters.search) query.set("q", filters.search);
  if (filters.scoreMin !== undefined) query.set("score_min", String(filters.scoreMin));
  if (filters.scoreMax !== undefined) query.set("score_max", String(filters.scoreMax));
  if (filters.unsubscribed) query.set("unsubscribed", "1");
  if (filters.previewView) query.set("preview", filters.previewView);
  if (page > 1) query.set("page", String(page));
  return query;
}

function normalizeSearch(value: string) {
  return value.trim() || undefined;
}

function buildSubtitle(total: number, allCount: number) {
  return total === allCount
    ? `${allCount.toLocaleString()} contacts`
    : `${total.toLocaleString()} of ${allCount.toLocaleString()} contacts`;
}

function readMaxCsvUploadMegabytes() {
  const configured = process.env.NEXT_PUBLIC_DASHBOARD_MAX_CSV_UPLOAD_MB;
  if (!configured) return defaultMaxCsvUploadMegabytes;

  const value = Number(configured);
  return Number.isFinite(value) && value > 0 ? value : defaultMaxCsvUploadMegabytes;
}

function formatUploadLimitMegabytes(megabytes: number) {
  if (Number.isInteger(megabytes)) {
    return String(megabytes);
  }

  return megabytes.toFixed(1).replace(/\.0$/, "");
}

function maxCsvUploadMessage(maxCsvUploadMegabytes = readMaxCsvUploadMegabytes()) {
  return `CSV file must be ${formatUploadLimitMegabytes(maxCsvUploadMegabytes)}MB or smaller`;
}

function LeadPagination({
  page,
  totalPages,
  total,
  pending,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pending: boolean;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) {
    return <div className="lead-pagination muted">{total.toLocaleString()} matching contacts</div>;
  }

  return (
    <nav className="lead-pagination" aria-label="Lead list pagination">
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => onPageChange(Math.max(page - 1, 1))}
        disabled={pending || page <= 1}
      >
        Previous
      </button>
      <span className="lead-pagination-status">
        Page {page.toLocaleString()} of {totalPages.toLocaleString()} · {total.toLocaleString()} contacts
      </span>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => onPageChange(Math.min(page + 1, totalPages))}
        disabled={pending || page >= totalPages}
      >
        Next
      </button>
    </nav>
  );
}

export function LeadsWorkbench({
  tenantId,
  todaySummary,
  leads,
  counts,
  filters,
  total,
  page,
  totalPages,
  pageSize,
}: {
  tenantId: string;
  /**
   * Today's numbers, or null when they could not be read. Leave it undefined
   * to render the workbench without the bar at all.
   */
  todaySummary?: TodaySoFarSummary | null;
  leads: LeadListRow[];
  counts: LeadFilterCounts;
  filters: LeadListFilters;
  total: number;
  page: number;
  totalPages: number;
  pageSize: number;
}) {
  const [data, setData] = useState<LeadListResponse>({ rows: leads, counts, total, page, totalPages, pageSize });
  const [activeFilters, setActiveFilters] = useState<LeadListFilters>(filters);
  const [searchInput, setSearchInput] = useState(filters.search ?? "");
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importPending, setImportPending] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(leads[0]?.id ?? null);
  const [isDesktopLeadLayout, setIsDesktopLeadLayout] = useState(false);
  const [quickPanelOpen, setQuickPanelOpen] = useState(false);
  const latestLeadRequestId = useRef(0);
  const quickPanelTriggerRef = useRef<HTMLElement | null>(null);

  const selectedLead = useMemo(
    () => data.rows.find((lead) => lead.id === selectedLeadId) ?? null,
    [data.rows, selectedLeadId],
  );
  const showQuickPanel = Boolean(selectedLead && (isDesktopLeadLayout || quickPanelOpen));
  const visibleSelectedLeadId = showQuickPanel ? selectedLeadId : null;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;

    const mediaQuery = window.matchMedia("(min-width: 861px)");
    const syncLeadLayout = () => setIsDesktopLeadLayout(mediaQuery.matches);

    syncLeadLayout();
    mediaQuery.addEventListener("change", syncLeadLayout);
    return () => mediaQuery.removeEventListener("change", syncLeadLayout);
  }, []);

  function handleSelectLead(leadId: string) {
    const activeElement = document.activeElement;
    quickPanelTriggerRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    setSelectedLeadId(leadId);
    setQuickPanelOpen(true);
  }

  const handleCloseQuickPanel = useCallback(() => {
    setQuickPanelOpen(false);
    setSelectedLeadId(null);
    window.requestAnimationFrame(() => {
      quickPanelTriggerRef.current?.focus();
      quickPanelTriggerRef.current = null;
    });
  }, []);

  useEffect(() => {
    if (!showQuickPanel) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        handleCloseQuickPanel();
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showQuickPanel, handleCloseQuickPanel]);

  async function loadPage(nextFilters: LeadListFilters, nextPage: number) {
    const requestId = latestLeadRequestId.current + 1;
    latestLeadRequestId.current = requestId;
    setPending(true);
    setLoadError(null);

    try {
      const query = buildLeadListQuery(nextFilters, nextPage);
      const response = await fetch(query.toString() ? `/api/leads?${query}` : "/api/leads");

      if (!response.ok) {
        throw new Error(`Failed to load leads: ${response.status}`);
      }

      const nextData = (await response.json()) as LeadListResponse;
      if (requestId !== latestLeadRequestId.current) return;

      setData(nextData);
      setSelectedLeadId((currentLeadId) =>
        nextData.rows.some((lead) => lead.id === currentLeadId) ? currentLeadId : (nextData.rows[0]?.id ?? null),
      );
      setActiveFilters(nextFilters);
      window.history.replaceState(null, "", query.toString() ? `/leads?${query}` : "/leads");
    } catch {
      if (requestId !== latestLeadRequestId.current) return;
      setLoadError("Failed to refresh leads. Try again in a moment.");
    } finally {
      if (requestId === latestLeadRequestId.current) {
        setPending(false);
      }
    }
  }

  async function handleImportCsv(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    setImportMessage(null);
    setImportError(null);

    const maxCsvUploadMegabytes = readMaxCsvUploadMegabytes();
    const maxCsvUploadBytes = maxCsvUploadMegabytes * 1024 * 1024;

    if (file.size > maxCsvUploadBytes) {
      setImportError(maxCsvUploadMessage(maxCsvUploadMegabytes));
      input.value = "";
      return;
    }

    setImportPending(true);

    try {
      const formData = new FormData();
      formData.set("file", file);

      const response = await fetch("/api/import-csv", {
        method: "POST",
        body: formData,
      });
      const body = (await response.json().catch(() => ({}))) as ImportCsvResponse;

      if (!response.ok) {
        if (response.status === 413 && !body.error) {
          throw new Error(maxCsvUploadMessage(maxCsvUploadMegabytes));
        }
        throw new Error(body.error || `Failed to queue import: ${response.status}`);
      }

      const sourceFile = body.sourceFile || file.name;
      setImportMessage(`${sourceFile} queued for import. Pipeline processing will start shortly.`);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Failed to queue import");
    } finally {
      setImportPending(false);
      input.value = "";
    }
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title-wrap">
          <div className="page-title">Leads</div>
          <div className="page-subtitle">{buildSubtitle(data.total, data.counts.all)}</div>
        </div>
        <div className="page-actions">
          <label className={`btn btn-primary import-csv-control${importPending ? " is-disabled" : ""}`}>
            <Upload size={14} />
            {importPending ? "Queueing..." : "Import CSV"}
            <input
              aria-label="Import CSV"
              className="visually-hidden"
              type="file"
              accept=".csv,text/csv"
              disabled={importPending}
              onChange={handleImportCsv}
            />
          </label>
        </div>
      </div>
      {todaySummary !== undefined ? <TodaySoFarBar summary={todaySummary} /> : null}
      {importMessage ? <div className="import-status success" role="status">{importMessage}</div> : null}
      {importError ? <div className="import-status error" role="alert">{importError}</div> : null}
      <LeadFilters
        activeStatus={activeFilters.status}
        activeUnsubscribed={activeFilters.unsubscribed}
        activePreviewView={activeFilters.previewView}
        searchValue={searchInput}
        counts={data.counts}
        pending={pending}
        onSelect={(selection: LeadFilterSelection) =>
          loadPage(
            {
              ...activeFilters,
              search: normalizeSearch(searchInput),
              status: selection.status,
              unsubscribed: selection.unsubscribed,
            },
            1,
          )
        }
        onPreviewSelect={(previewView?: PreviewViewFilter) =>
          loadPage({ ...activeFilters, search: normalizeSearch(searchInput), previewView }, 1)
        }
        onSearchChange={(search) => {
          setSearchInput(search);
          void loadPage({ ...activeFilters, search: normalizeSearch(search) }, 1);
        }}
      />
      <div className={`leads-screen${showQuickPanel ? " has-detail-panel" : ""}`}>
        <section className={`leads-list${pending ? " is-pending" : ""}`} aria-busy={pending}>
          {loadError ? <div className="error-state inline-error" role="alert">{loadError}</div> : null}
          {data.rows.length ? (
            <LeadTable leads={data.rows} selectedLeadId={visibleSelectedLeadId} onSelectLead={handleSelectLead} />
          ) : (
            <div className="empty-state">No leads yet. Import your Apollo CSV to get started.</div>
          )}
          <LeadPagination
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            pending={pending}
            onPageChange={(nextPage) => loadPage(activeFilters, nextPage)}
          />
        </section>
        {showQuickPanel && selectedLead ? (
          <>
            {!isDesktopLeadLayout ? (
              <button
                type="button"
                className="detail-panel-backdrop"
                aria-label="Close quick panel backdrop"
                onClick={handleCloseQuickPanel}
              />
            ) : null}
            <LeadQuickPanelWithClose
              key={selectedLead.id}
              tenantId={tenantId}
              lead={selectedLead}
              onClose={handleCloseQuickPanel}
              autoFocusClose={!isDesktopLeadLayout && quickPanelOpen}
            />
          </>
        ) : null}
      </div>
    </>
  );
}
