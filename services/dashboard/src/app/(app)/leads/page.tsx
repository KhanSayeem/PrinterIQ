import { getLeadFilterCounts, getLeadListPage, getTodaySoFarSummary, type TodaySoFarSummary } from "@/db/queries";
import type { LeadListRow } from "@/components/LeadQuickPanel";
import { LeadsWorkbench } from "@/components/LeadsWorkbench";
import { getDashboardTenantId } from "@/auth/tenant";
import { parseLeadListParams } from "@/lib/lead-list-params";
import { loadTodayInstantlySendTotals, unavailableTodaySendTotals } from "@/lib/today-sends";

/**
 * Today's numbers are a side panel on the lead list, not a precondition for
 * it. A failure here says so on the bar and leaves the list alone.
 *
 * Sends and bounces are read from Instantly rather than from `outreach_sends`,
 * whose `sent_at` records the handoff to Instantly and not the send itself.
 * That loader is written not to throw: an Instantly failure comes back as an
 * unavailable figure, so the bar can say which number is missing and why,
 * instead of showing a zero that reads as a quiet sending day. It is still
 * guarded here. An unhandled rejection from it would reject through the page's
 * own Promise.all and render "Failed to load leads. Check DATABASE_URL", which
 * blames the database for an Instantly problem and takes the whole list down
 * with it.
 */
async function loadTodaySoFar(tenantId: string, now: Date): Promise<TodaySoFarSummary | null> {
  let sendTotals;
  try {
    sendTotals = await loadTodayInstantlySendTotals({ now });
  } catch (error) {
    console.error("Failed to load today's Instantly send totals", {
      message: error instanceof Error ? error.message : "Unknown Instantly send totals error",
    });
    sendTotals = unavailableTodaySendTotals(
      "Today's send count could not be read from Instantly.",
    );
  }

  try {
    return await getTodaySoFarSummary({ tenantId, sendTotals, now });
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

    // One instant for both halves of the bar, so the Instantly day and the
    // database window cannot land on different sides of Sydney midnight.
    const now = new Date();

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
      loadTodaySoFar(tenantId, now),
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
