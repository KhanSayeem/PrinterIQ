import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedOperator } from "@/auth/operators";
import { createSupabaseServerClient } from "@/auth/server";
import { getDashboardTenantId } from "@/auth/tenant";
import { listProspectReviewExportRows, type ProspectReviewExportRow } from "@/db/queries";

export const runtime = "nodejs";

const headers = [
  "business_name",
  "normalized_name",
  "primary_category",
  "locality",
  "state",
  "postcode",
  "google_profile_url",
  "source_website_url",
  "normalized_domain",
  "route",
  "status",
  "validation_cohort",
  "outcome_reason",
  "total_score",
  "contact_status",
  "contact_person_name",
  "contact_person_title",
  "contact_email",
  "contact_email_status",
  "review_decision",
  "corrected_route",
  "review_note",
  "reviewed_at",
  "prospect_created_at",
  "prospect_updated_at",
] as const;

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

  const discoveryRunId = request.nextUrl.searchParams.get("runId")?.trim();
  if (!discoveryRunId) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }

  const rows = await listProspectReviewExportRows({ tenantId, discoveryRunId });
  return new NextResponse(toCsv(rows), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="prospect-review-${discoveryRunId}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}

function toCsv(rows: ProspectReviewExportRow[]) {
  return [
    headers.join(","),
    ...rows.map((row) =>
      [
        row.businessName,
        row.normalizedName,
        row.primaryCategory,
        row.locality,
        row.state,
        row.postcode,
        row.googleProfileUrl,
        row.sourceWebsiteUrl,
        row.normalizedDomain,
        row.route,
        row.status,
        row.validationCohort,
        row.outcomeReason,
        row.totalScore,
        row.contactStatus,
        row.contactPersonName,
        row.contactPersonTitle,
        row.contactEmail,
        row.contactEmailStatus,
        row.reviewDecision,
        row.correctedRoute,
        row.reviewNote,
        row.reviewedAt,
        row.prospectCreatedAt,
        row.prospectUpdatedAt,
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\r\n");
}

function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}
