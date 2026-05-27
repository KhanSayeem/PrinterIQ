import Link from "next/link";
import {
  getRevenueAnalytics,
  normalizeRevenuePeriod,
  type RevenueAnalytics,
  type RevenuePeriod,
} from "@/db/queries";

const tenantId = process.env.TENANT_ID ?? "10000000-0000-0000-0000-000000000001";

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

  try {
    const analytics = await getRevenueAnalytics({ tenantId, period });

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
      <div className="metrics-grid">
        <MetricCard
          label="Total revenue"
          value={formatAud(analytics.totalRevenueAud)}
          delta={
            analytics.paidCount === 0
              ? "No payments recorded yet."
              : `${analytics.paidCount.toLocaleString()} paid payments`
          }
          positive={analytics.paidCount > 0}
        />
        <MetricCard
          label="Conversion rate"
          value={analytics.paidConversionRate === null ? "--" : `${analytics.paidConversionRate.toFixed(2)}%`}
          delta="paid / imported"
        />
        <MetricCard
          label="Paid payments"
          value={analytics.paidCount.toLocaleString()}
          delta={`${analytics.importedCount.toLocaleString()} imported leads`}
        />
        <MetricCard
          label="AI spend"
          value={formatUsd(analytics.totalAiCostUsd)}
          delta={analytics.aiCosts.length === 0 ? "No AI spend recorded yet." : `${analytics.aiCosts.length} model rows`}
        />
      </div>
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

function MetricCard({
  label,
  value,
  delta,
  positive = false,
}: {
  label: string;
  value: string;
  delta: string;
  positive?: boolean;
}) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className={`metric-delta ${positive ? "up" : ""}`}>{delta}</div>
    </div>
  );
}

function formatAud(value: number) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
