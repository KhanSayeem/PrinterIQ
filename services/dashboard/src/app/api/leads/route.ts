import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedOperator } from "@/auth/operators";
import { createSupabaseServerClient } from "@/auth/server";
import { getDashboardTenantId } from "@/auth/tenant";
import { getLeadFilterCounts, getLeadListPage } from "@/db/queries";
import { parseLeadListParams } from "@/lib/lead-list-params";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isAuthorizedOperator(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenantId = getDashboardTenantId();
  if (!tenantId) {
    return NextResponse.json({ error: "Dashboard tenant not configured" }, { status: 500 });
  }

  const filters = parseLeadListParams(Object.fromEntries(request.nextUrl.searchParams.entries()));

  try {
    const [counts, leadPage] = await Promise.all([
      getLeadFilterCounts({ tenantId }),
      getLeadListPage({
        tenantId,
        status: filters.status,
        state: filters.state,
        tradeType: filters.tradeType,
        search: filters.search,
        scoreMin: filters.scoreMin,
        scoreMax: filters.scoreMax,
        unsubscribed: filters.unsubscribed,
        previewView: filters.previewView,
        page: filters.page,
        pageSize: 25,
      }),
    ]);

    return NextResponse.json({
      rows: leadPage.rows,
      counts,
      total: leadPage.total,
      page: leadPage.page,
      totalPages: leadPage.totalPages,
      pageSize: leadPage.pageSize,
    });
  } catch (error) {
    console.error("Failed to load leads", { message: error instanceof Error ? error.message : "Unknown error" });
    return NextResponse.json({ error: "Failed to load leads" }, { status: 500 });
  }
}
