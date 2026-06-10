import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/auth/server";
import { getLeadFilterCounts, getLeadListPage } from "@/db/queries";
import { parseLeadListParams } from "@/lib/lead-list-params";

const tenantId = process.env.TENANT_ID ?? "10000000-0000-0000-0000-000000000001";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
        scoreMin: filters.scoreMin,
        scoreMax: filters.scoreMax,
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
