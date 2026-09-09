import { getLeadFilterCounts, getLeadListPage, getTodaySoFarSummary, type TodaySoFarSummary } from "@/db/queries";
import type { LeadListRow } from "@/components/LeadQuickPanel";
import { LeadsWorkbench } from "@/components/LeadsWorkbench";
import { getDashboardTenantId } from "@/auth/tenant";
import { parseLeadListParams } from "@/lib/lead-list-params";

/**
 * Today's numbers are a side panel on the lead list, not a precondition for
 * it. A failure here says so on the bar and leaves the list alone.
 */
async function loadTodaySoFar(tenantId: string): Promise<TodaySoFarSummary | null> {
  try {
    return await getTodaySoFarSummary({ tenantId });
  } catch (error) {
    console.error("Failed to load today so far", {
      message: error instanceof Error ? error.message : "Unknown today so far loading error",
    });
    return null;
  }
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
  const rawParams = await searchParams;
  const { page: requestedPage, ...filters } = parseLeadListParams(rawParams);

  let rows: LeadListRow[];
  let counts;
  let total = 0;
  let page = requestedPage;
  let totalPages = 1;
  let pageSize = 25;
  let tenantId: string;
  let todaySummary: TodaySoFarSummary | null = null;

  try {
    const resolvedTenantId = getDashboardTenantId();
    if (!resolvedTenantId) {
      throw new Error("Dashboard tenant not configured");
    }
    tenantId = resolvedTenantId;

    const [filterCounts, leadPage, today] = await Promise.all([
      getLeadFilterCounts({ tenantId }),
      getLeadListPage({
        tenantId,
        status: filters.status,
        state: filters.state,
        tradeType: filters.tradeType,
        scoreMin: filters.scoreMin,
        scoreMax: filters.scoreMax,
        search: filters.search,
        unsubscribed: filters.unsubscribed,
        previewView: filters.previewView,
        page: requestedPage,
        pageSize,
      }),
      loadTodaySoFar(tenantId),
    ]);
    todaySummary = today;
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
      todaySummary={todaySummary}
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
