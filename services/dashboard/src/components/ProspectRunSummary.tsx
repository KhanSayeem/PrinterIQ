export type ProspectRunView = {
  id: string;
  status: string;
  source: string;
  sourceRequestId: string | null;
  discoveredCount: number;
  usableCount: number;
  routeACount: number;
  routeBCount: number;
  verifiedContactCount: number;
  providerUsage?: unknown;
  failureCode: string | null;
  failureDetail: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type ProspectReviewMetricsView = {
  eligibilityPrecision: number | null;
  routePrecision: number | null;
  usableYield: number | null;
  routeableYield: number | null;
  routeAYield: number | null;
  routeBYield: number | null;
  unexpectedFailureRate: number | null;
  routeAVerifiedEmailMatchRate: number | null;
  routeBVerifiedEmailMatchRate: number | null;
  providerUsagePresent: boolean;
  costReconciliationRequired: boolean;
};

const RUN_LABELS: Record<string, string> = {
  created: "Created",
  submitted: "Submitted",
  polling: "Polling",
  persisted: "Results persisted",
  processing: "Processing",
  review_ready: "Review ready",
  completed: "Completed",
  failed: "Run failed",
};

const PARTIAL_STATUSES = new Set(["submitted", "polling", "processing"]);

function providerState(run: ProspectRunView) {
  if (run.status === "failed") return "Provider failed";
  if (run.status === "created" || !run.sourceRequestId) return "Awaiting submission";
  if (run.status === "submitted") return "Request submitted";
  if (run.status === "polling") return "Provider processing";
  return "Results received";
}

function formatTimestamp(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString("en-AU");
}

export function ProspectRunSummary({
  run,
  reviewMetrics,
}: {
  run: ProspectRunView;
  reviewMetrics?: ProspectReviewMetricsView | null;
}) {
  const apolloMatch = apolloContactMatch(run.providerUsage);
  const counts = [
    ["Discovered", run.discoveredCount],
    ["Usable", run.usableCount],
    ["Route A", run.routeACount],
    ["Route B", run.routeBCount],
    ["Verified contacts", run.verifiedContactCount],
    ["Route A verified", apolloMatch.routeAVerified],
    ["Route B verified", apolloMatch.routeBVerified],
  ] as const;

  return (
    <section className="prospect-run-summary" aria-labelledby="latest-run-heading">
      <div className="prospect-section-heading">
        <div>
          <h2 id="latest-run-heading">Latest run</h2>
          <p>Started {formatTimestamp(run.createdAt)}</p>
        </div>
        <span className={`prospect-run-badge status-${run.status}`}>{RUN_LABELS[run.status] ?? run.status}</span>
      </div>

      <dl className="prospect-run-meta">
        <div>
          <dt>Run state</dt>
          <dd>{RUN_LABELS[run.status] ?? run.status}</dd>
        </div>
        <div>
          <dt>Provider state</dt>
          <dd>{providerState(run)}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{run.source === "outscraper" ? "Outscraper" : run.source}</dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>{formatTimestamp(run.updatedAt)}</dd>
        </div>
      </dl>

      {PARTIAL_STATUSES.has(run.status) ? (
        <div className="prospect-run-notice">Partial results. Counts can increase while this run is active.</div>
      ) : null}

      {run.status === "failed" ? (
        <div className="prospect-run-failure" role="alert">
          <strong>Run failed</strong>
          <span>{run.failureDetail || "The provider could not complete this discovery run."}</span>
          {run.failureCode ? <code>{run.failureCode}</code> : null}
        </div>
      ) : null}

      <div className="prospect-count-grid">
        {counts.map(([label, value]) => (
          <div className="prospect-count" key={label}>
            <span>{label}</span>
            <strong>{value.toLocaleString("en-AU")}</strong>
          </div>
        ))}
      </div>

      <dl className="prospect-run-meta">
        <div>
          <dt>Route A match rate</dt>
          <dd>{formatRate(apolloMatch.routeARate)}</dd>
        </div>
        <div>
          <dt>Route B match rate</dt>
          <dd>{formatRate(apolloMatch.routeBRate)}</dd>
        </div>
        <div>
          <dt>Cost status</dt>
          <dd>{costStatus(apolloMatch.costReconciliationRequired, reviewMetrics)}</dd>
        </div>
        <div>
          <dt>Eligibility precision</dt>
          <dd>{formatRateValue(reviewMetrics?.eligibilityPrecision ?? null)}</dd>
        </div>
        <div>
          <dt>Route precision</dt>
          <dd>{formatRateValue(reviewMetrics?.routePrecision ?? null)}</dd>
        </div>
        <div>
          <dt>Routeable yield</dt>
          <dd>{formatRateValue(reviewMetrics?.routeableYield ?? null)}</dd>
        </div>
      </dl>
    </section>
  );
}

function apolloContactMatch(providerUsage: unknown) {
  const usage = isRecord(providerUsage) ? providerUsage : {};
  const match = isRecord(usage.apollo_contact_match) ? usage.apollo_contact_match : {};
  return {
    routeAVerified: numberOrZero(match.route_a_verified_contact_count),
    routeBVerified: numberOrZero(match.route_b_verified_contact_count),
    routeARate: numberOrNull(match.route_a_match_rate),
    routeBRate: numberOrNull(match.route_b_match_rate),
    costReconciliationRequired: match.cost_reconciliation_required !== false,
  };
}

function formatRate(value: number | null) {
  return value === null ? "No routed contacts yet" : `${Math.round(value * 100)}%`;
}

function formatRateValue(value: number | null) {
  return value === null ? "Incomplete" : `${Math.round(value * 100)}%`;
}

function costStatus(
  runCostReconciliationRequired: boolean,
  metrics: ProspectReviewMetricsView | null | undefined,
) {
  if (metrics && !metrics.providerUsagePresent) {
    return "Provider usage missing";
  }
  if (metrics) {
    return metrics.costReconciliationRequired ? "Cost reconciliation required" : "Reconciled";
  }
  return runCostReconciliationRequired ? "Cost reconciliation required" : "Reconciled";
}

function numberOrZero(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
