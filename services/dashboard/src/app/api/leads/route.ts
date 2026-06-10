import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/auth/server";
import { getLeadFilterCounts, getLeadListPage } from "@/db/queries";
import { parseLeadListParams } from "@/lib/lead-list-params";

const defaultTenantId = "10000000-0000-0000-0000-000000000001";

function getDashboardTenantId() {
  if (process.env.TENANT_ID) {
    return process.env.TENANT_ID;
  }

  return process.env.NODE_ENV === "production" ? null : defaultTenantId;
}

function isAuthorizedOperator(user: { email?: string | null }) {
  const allowedEmails = process.env.DASHBOARD_OPERATOR_EMAILS?.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (allowedEmails?.length) {
    return user.email ? allowedEmails.includes(user.email.toLowerCase()) : false;
  }

  return process.env.NODE_ENV !== "production";
}

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
