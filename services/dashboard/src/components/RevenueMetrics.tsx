import type { RevenueAnalytics } from "@/db/queries";
import { MetricCardShell } from "./MetricCardShell";

function formatAud(value: number) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function RevenueMetrics({ analytics }: { analytics: RevenueAnalytics }) {
  return (
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
        href="/leads?status=paid"
      />
      <MetricCard
        label="Conversion rate"
        value={analytics.paidConversionRate === null ? "--" : `${analytics.paidConversionRate.toFixed(2)}%`}
        delta="paid / imported"
        href="/pipeline"
      />
      <MetricCard
        label="Paid payments"
        value={analytics.paidCount.toLocaleString()}
        delta={`${analytics.importedCount.toLocaleString()} imported leads`}
        href="/leads?status=paid"
      />
      {/* AI spend has no filtered view of its own: the per model breakdown is
          the card directly below this grid on the same page. */}
      <MetricCard
        label="AI spend"
        value={formatUsd(analytics.totalAiCostUsd)}
        delta={analytics.aiCosts.length === 0 ? "No AI spend recorded yet." : `${analytics.aiCosts.length} model rows`}
      />
    </div>
  );
}

function MetricCard({
  label,
  value,
  delta,
  positive = false,
  href,
}: {
  label: string;
  value: string;
  delta: string;
  positive?: boolean;
  href?: string;
}) {
  return (
    <MetricCardShell className="metric-card" href={href}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className={`metric-delta ${positive ? "up" : ""}`}>{delta}</div>
    </MetricCardShell>
  );
}
