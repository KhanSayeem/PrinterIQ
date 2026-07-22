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
  failureCode: string | null;
  failureDetail: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
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

export function ProspectRunSummary({ run }: { run: ProspectRunView }) {
  const counts = [
    ["Discovered", run.discoveredCount],
    ["Usable", run.usableCount],
    ["Route A", run.routeACount],
    ["Route B", run.routeBCount],
    ["Verified contacts", run.verifiedContactCount],
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
    </section>
  );
}
