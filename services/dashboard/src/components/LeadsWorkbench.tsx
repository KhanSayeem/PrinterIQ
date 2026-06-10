"use client";

import { Upload } from "lucide-react";
import { useMemo, useState } from "react";
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

  return (
    <>
      <div className="page-header">
        <div className="page-title-wrap">
          <div className="page-title">Leads</div>
          <div className="page-subtitle">{buildSubtitle(data.total, data.counts.all)}</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" type="button" disabled title="Available in Pipeline B1">
            <Upload size={14} />
            Import CSV
          </button>
        </div>
      </div>
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
