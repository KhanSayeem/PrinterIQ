"use client";

import { Upload } from "lucide-react";
import { type ChangeEvent, useMemo, useState } from "react";
import type { LeadFilterCounts } from "@/db/queries";
import type { LeadListFilterParams } from "@/lib/lead-list-params";
import { LeadFilters } from "./LeadFilters";
import { LeadQuickPanelWithClose, type LeadListRow } from "./LeadQuickPanel";
import { LeadTable } from "./LeadTable";

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
  if (filters.scoreMin !== undefined) query.set("score_min", String(filters.scoreMin));
  if (filters.scoreMax !== undefined) query.set("score_max", String(filters.scoreMax));
  if (page > 1) query.set("page", String(page));
  return query;
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
  leads,
  counts,
  filters,
  total,
  page,
  totalPages,
  pageSize,
}: {
  tenantId: string;
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
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importPending, setImportPending] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(leads[0]?.id ?? null);

  const selectedLead = useMemo(
    () => data.rows.find((lead) => lead.id === selectedLeadId) ?? null,
    [data.rows, selectedLeadId],
  );

  async function loadPage(nextFilters: LeadListFilters, nextPage: number) {
    setPending(true);
    setLoadError(null);

    try {
      const query = buildLeadListQuery(nextFilters, nextPage);
      const response = await fetch(query.toString() ? `/api/leads?${query}` : "/api/leads");

      if (!response.ok) {
        throw new Error(`Failed to load leads: ${response.status}`);
      }

      const nextData = (await response.json()) as LeadListResponse;
      setData(nextData);
      setSelectedLeadId((currentLeadId) =>
        nextData.rows.some((lead) => lead.id === currentLeadId) ? currentLeadId : (nextData.rows[0]?.id ?? null),
      );
      setActiveFilters(nextFilters);
      window.history.replaceState(null, "", query.toString() ? `/leads?${query}` : "/leads");
    } catch {
      setLoadError("Failed to refresh leads. Try again in a moment.");
    } finally {
      setPending(false);
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
      {importMessage ? <div className="import-status success" role="status">{importMessage}</div> : null}
      {importError ? <div className="import-status error" role="alert">{importError}</div> : null}
      <LeadFilters
        activeStatus={activeFilters.status}
        counts={data.counts}
        pending={pending}
        onSelect={(status) => loadPage({ ...activeFilters, status }, 1)}
      />
      <div className="leads-screen">
        <section className={`leads-list${pending ? " is-pending" : ""}`} aria-busy={pending}>
          {loadError ? <div className="error-state inline-error" role="alert">{loadError}</div> : null}
          {data.rows.length ? (
            <LeadTable leads={data.rows} selectedLeadId={selectedLeadId} onSelectLead={setSelectedLeadId} />
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
        <LeadQuickPanelWithClose tenantId={tenantId} lead={selectedLead} onClose={() => setSelectedLeadId(null)} />
      </div>
    </>
  );
}
