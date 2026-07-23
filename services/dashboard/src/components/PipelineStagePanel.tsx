import Link from "next/link";
import type { PipelineStageDetail } from "@/db/queries";

export function PipelineStagePanel({ detail }: { detail: PipelineStageDetail }) {
  return (
    <aside className="pipeline-detail-panel" aria-label={`${detail.label} stage details`}>
      <div className="dp-header">
        <div className="dp-name">{detail.label} details</div>
        <div className="dp-sub">{detail.count.toLocaleString()} leads currently in this stage</div>
      </div>
      <div className="pipeline-detail-body">
        <div className="pipeline-metric-grid">
          <Metric label="Share of imported" value={`${detail.shareOfImported.toFixed(1)}%`} />
          <Metric label="Previous conversion" value={detail.previousConversionLabel} />
          <Metric label="Dropped from previous" value={detail.droppedFromPrevious.toLocaleString()} />
          <Metric
            label="Avg score"
            value={detail.averageScore === null ? "No score data yet." : detail.averageScore.toFixed(1)}
          />
        </div>

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
