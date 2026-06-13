import { getLeadFilterCounts, getLeadListPage } from "@/db/queries";
import type { LeadListRow } from "@/components/LeadQuickPanel";
import { LeadsWorkbench } from "@/components/LeadsWorkbench";
import { getDashboardTenantId } from "@/auth/tenant";
import { parseLeadListParams } from "@/lib/lead-list-params";

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
  const rawParams = await searchParams;
  const { page: requestedPage, ...filters } = parseLeadListParams(rawParams);

  let rows: LeadListRow[];
  let counts;
  let total = 0;
  let page = requestedPage;
  let totalPages = 1;
  let pageSize = 25;
  let tenantId: string;

  try {
    const resolvedTenantId = getDashboardTenantId();
    if (!resolvedTenantId) {
      throw new Error("Dashboard tenant not configured");
    }
    tenantId = resolvedTenantId;

    const [filterCounts, leadPage] = await Promise.all([
      getLeadFilterCounts({ tenantId }),
      getLeadListPage({
        tenantId,
        status: filters.status,
        state: filters.state,
        tradeType: filters.tradeType,
        scoreMin: filters.scoreMin,
        scoreMax: filters.scoreMax,
        search: filters.search,
        page: requestedPage,
        pageSize,
      }),
    ]);
    counts = filterCounts;
    rows = leadPage.rows;
    total = leadPage.total;
    page = leadPage.page;
    totalPages = leadPage.totalPages;
    pageSize = leadPage.pageSize;
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

  return (
    <LeadsWorkbench
      tenantId={tenantId}
      leads={rows}
      counts={counts}
      filters={filters}
      total={total}
      page={page}
      totalPages={totalPages}
      pageSize={pageSize}
    />
  );
}
