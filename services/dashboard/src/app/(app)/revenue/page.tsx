import Link from "next/link";
import { AiSpendBreakdown } from "@/components/AiSpendBreakdown";
import { RevenueMetrics } from "@/components/RevenueMetrics";
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
      <AiSpendBreakdown analytics={analytics} />
    </div>
  );
}
