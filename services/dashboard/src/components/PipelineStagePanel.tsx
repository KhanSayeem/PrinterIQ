import Link from "next/link";
import type { PipelineStageDetail } from "@/db/queries";

export function PipelineStagePanel({ detail }: { detail: PipelineStageDetail }) {
  const metrics = buildStageMetrics(detail);

  return (
    <aside className="pipeline-detail-panel" aria-label={`${detail.label} stage details`}>
      <div className="dp-header">
        <div className="dp-name">{detail.label} details</div>
        <div className="dp-sub">{detail.count.toLocaleString()} leads currently in this stage</div>
      </div>
      <div className="pipeline-detail-body">
        {metrics.length ? (
          <div className="pipeline-metric-grid">
            {metrics.map((metric) => (
              <Metric key={metric.label} label={metric.label} value={metric.value} />
            ))}
          </div>
        ) : null}

        <section className="dp-section">
          <div className="dp-section-title">Top weaknesses</div>
          {detail.topWeaknesses.length ? (
            <div className="weakness-wrap">
              {detail.topWeaknesses.map((weakness) => (
                <span className="w-chip" key={weakness.label}>
                  <span>{weakness.label}</span> · {weakness.count}
                </span>
              ))}
            </div>
          ) : (
            <div className="dp-empty">No website weaknesses recorded for this stage.</div>
          )}
        </section>

        <section className="dp-section">
          <div className="dp-section-title">Sample leads</div>
          {detail.sampleLeads.length ? (
            <div className="pipeline-sample-list">
              {detail.sampleLeads.map((lead) => (
                <Link className="pipeline-sample-row" href={`/leads/${lead.id}`} key={lead.id}>
                  <div>
                    <div className="pipeline-sample-name">{displayLeadName(lead)}</div>
                    <div className="pipeline-sample-sub">
                      {lead.city ?? "Unknown city"}, {lead.state ?? "--"} · score {lead.score ?? "--"}
                    </div>
                  </div>
                  <span className="pipeline-sample-date">{formatDate(lead.updatedAt)}</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="dp-empty">No leads currently in this stage.</div>
          )}
        </section>

        <div className="pipeline-panel-footer">
          <Link className="btn" href={`/leads?status=${detail.status}`}>
            View all {detail.status} leads
          </Link>
        </div>
      </div>
    </aside>
  );
}

type StageMetric = { label: string; value: string };

/**
 * The first stage has no stage before it, so its share, previous conversion and
 * drop-off are always 100%, "Starting stage" and 0. Only surface metrics that
 * can actually differ, and drop the ones with nothing behind them yet.
 */
function buildStageMetrics(detail: PipelineStageDetail): StageMetric[] {
  const metrics: StageMetric[] = [];
  const hasPreviousStage = detail.status !== "imported" && detail.previousConversionLabel !== "--";

  if (detail.status !== "imported") {
    metrics.push({ label: "Share of imported", value: `${detail.shareOfImported.toFixed(1)}%` });
  }

  if (hasPreviousStage) {
    metrics.push({ label: "Previous conversion", value: detail.previousConversionLabel });
    metrics.push({ label: "Dropped from previous", value: detail.droppedFromPrevious.toLocaleString() });
  }

  if (detail.averageScore !== null) {
    metrics.push({ label: "Avg score", value: detail.averageScore.toFixed(1) });
  }

  return metrics;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="pipeline-detail-metric">
      <div className="metric-label">{label}</div>
      <div className="pipeline-detail-value">{value}</div>
    </div>
  );
}

function displayLeadName(lead: PipelineStageDetail["sampleLeads"][number]) {
  return lead.businessName || [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unnamed lead";
}

function formatDate(value: Date | string | null) {
  if (!value) return "date unknown";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "date unknown";

  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
  }).format(date);
}
