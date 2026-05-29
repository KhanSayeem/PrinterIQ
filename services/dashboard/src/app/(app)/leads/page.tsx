import { Upload } from "lucide-react";
import { getLeadList } from "@/db/queries";
import type { LeadListRow } from "@/components/LeadQuickPanel";
import { LeadFilters } from "@/components/LeadFilters";
import { LeadsWorkbench } from "@/components/LeadsWorkbench";

const tenantId = process.env.TENANT_ID ?? "10000000-0000-0000-0000-000000000001";

function asNumber(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getLeadLoadErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown lead loading error";
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  let rows: LeadListRow[];
  let allRows: LeadListRow[];

  try {
    allRows = await getLeadList({
      tenantId,
      pageSize: 100,
    });
    rows = await getLeadList({
      tenantId,
      status: params.status,
      state: params.state,
      tradeType: params.trade_type,
      scoreMin: asNumber(params.score_min),
      scoreMax: asNumber(params.score_max),
      page: asNumber(params.page),
      pageSize: 25,
    });
  } catch (error) {
    const message = getLeadLoadErrorMessage(error);
    console.error("Failed to load leads", { message });

    return (
      <div className="error-state">
        Failed to load leads. Check DATABASE_URL and Supabase connectivity.
        {process.env.NODE_ENV !== "production" ? <div className="error-detail">{message}</div> : null}
      </div>
    );
  }

  const counts = getFilterCounts(allRows);

  return (
    <>
      <div className="page-header">
        <div className="page-title-wrap">
          <div className="page-title">Leads</div>
          <div className="page-subtitle">{counts.all.toLocaleString()} contacts</div>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-primary"
            type="button"
            disabled
            title="Available in Pipeline B1"
          >
            <Upload size={14} />
            Import CSV
          </button>
        </div>
      </div>
      <LeadFilters activeStatus={params.status} counts={counts} />
      <LeadsWorkbench tenantId={tenantId} leads={rows} />
    </>
  );
}

function getFilterCounts(rows: LeadListRow[]) {
  return {
    all: rows.length,
    qualified: rows.filter((r) => r.status === "qualified").length,
    replied: rows.filter((r) => r.status === "replied").length,
    paid: rows.filter((r) => r.status === "paid").length,
    archived: rows.filter((r) => r.status === "archived").length,
  };
}
