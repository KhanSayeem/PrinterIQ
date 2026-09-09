import Link from "next/link";
import { RevenueMetrics, formatUsd } from "@/components/RevenueMetrics";
import { getDashboardTenantId } from "@/auth/tenant";
import {
  getRevenueAnalytics,
  normalizeRevenuePeriod,
  type RevenueAnalytics,
  type RevenuePeriod,
} from "@/db/queries";

const periodLabels: Record<RevenuePeriod, string> = {
  today: "Today",
  week: "This week",
  month: "This month",
};

function getRevenueLoadErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown revenue loading error";
}

export default async function RevenuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const period = normalizeRevenuePeriod(params.period);
  let analytics: RevenueAnalytics;

  try {
    const tenantId = getDashboardTenantId();
    if (!tenantId) {
      throw new Error("Dashboard tenant not configured");
    }

    analytics = await getRevenueAnalytics({ tenantId, period });
  } catch (error) {
    const message = getRevenueLoadErrorMessage(error);
    console.error("Failed to load revenue data", { message });

    return (
      <div className="error-state">
        Failed to load revenue data. Check DATABASE_URL and Supabase connectivity.
        {process.env.NODE_ENV !== "production" ? <div className="error-detail">{message}</div> : null}
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title-wrap">
          <div className="page-title">Revenue</div>
          <div className="page-subtitle">Financial overview and AI cost tracker</div>
        </div>
      </div>
      <RevenueView analytics={analytics} />
    </>
  );
}

function RevenueView({ analytics }: { analytics: RevenueAnalytics }) {
  return (
    <div className="revenue-content">
      <div className="rev-tabs">
        {Object.entries(periodLabels).map(([period, label]) => (
          <Link
            key={period}
            className={`rev-tab ${analytics.period === period ? "active" : ""}`}
            href={`/revenue?period=${period}`}
          >
            {label}
          </Link>
        ))}
      </div>
      <RevenueMetrics analytics={analytics} />
      <div className="ai-card">
        <div className="ai-card-title">AI spend breakdown</div>
        <div className="ai-card-sub">Claude API calls logged by model and prompt version</div>
        {analytics.aiCosts.length === 0 ? (
          <div className="empty-inline">No AI spend recorded yet.</div>
        ) : (
          analytics.aiCosts.map((row) => (
            <div className="ai-row" key={`${row.modelName}-${row.promptVersion}`}>
              <div className={`ai-dot ${row.modelFamily === "Haiku" ? "haiku" : "sonnet"}`} />
              <div className="ai-model-cell">
                <div className="ai-model-name">
                  Claude {row.modelFamily} <span className="ai-model-sub">· {row.promptVersion}</span>
                </div>
                <div className="ai-calls-count">
                  {row.calls.toLocaleString()} calls · {row.modelName}
                </div>
              </div>
              <div className="ai-cost-val">{formatUsd(row.costUsd)}</div>
            </div>
          ))
        )}
        <div className="ai-total-row">
          <div>
            <div className="ai-total-label">Total AI spend</div>
            <div className="ai-total-sub">
              {analytics.paidCount === 0
                ? "No paid leads in this period"
                : `${formatUsd(analytics.totalAiCostUsd / analytics.paidCount)} per paid lead`}
            </div>
          </div>
          <div className="ai-total-val">{formatUsd(analytics.totalAiCostUsd)}</div>
        </div>
      </div>
    </div>
  );
}
