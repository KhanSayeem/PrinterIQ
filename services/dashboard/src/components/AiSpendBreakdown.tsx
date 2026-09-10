import type { AiCostByModelPair, RevenueAnalytics } from "@/db/queries";
import { formatUsd } from "./RevenueMetrics";

/**
 * A group covers every qualification that ran the same models under the same
 * prompt version. The stored cost is the whole qualification's cost, so a
 * group that escalated to Sonnet paid for a Haiku call as well. The row names
 * both models rather than choosing one, because the split is not in the data.
 */
function modelPairLabel(row: AiCostByModelPair) {
  return row.sonnetModelName === null ? "Claude Haiku only" : "Claude Haiku and Sonnet together";
}

function modelNames(row: AiCostByModelPair) {
  return row.sonnetModelName === null
    ? row.haikuModelName
    : `${row.haikuModelName} + ${row.sonnetModelName}`;
}

function rowKey(row: AiCostByModelPair) {
  return `${row.haikuModelName}-${row.sonnetModelName ?? "none"}-${row.promptVersion}`;
}

export function AiSpendBreakdown({ analytics }: { analytics: RevenueAnalytics }) {
  return (
    <div className="ai-card">
      <div className="ai-card-title">AI spend breakdown</div>
      <div className="ai-card-sub">
        Qualification spend grouped by model pair and prompt version. A qualification stores one
        combined cost for the models it ran, so a row that ran both cannot be split between them.
      </div>
      {analytics.aiCosts.length === 0 ? (
        <div className="empty-inline">No AI spend recorded yet.</div>
      ) : (
        analytics.aiCosts.map((row) => (
          <div className="ai-row" key={rowKey(row)}>
            <div className="ai-dot" />
            <div className="ai-model-cell">
              <div className="ai-model-name">
                {modelPairLabel(row)} <span className="ai-model-sub">· {row.promptVersion}</span>
              </div>
              <div className="ai-calls-count">
                {row.calls.toLocaleString()} qualifications · {modelNames(row)}
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
            {analytics.payingLeadCount === 0
              ? "No paying leads in this period"
              : `${formatUsd(analytics.totalAiCostUsd / analytics.payingLeadCount)} per paying lead`}
          </div>
        </div>
        <div className="ai-total-val">{formatUsd(analytics.totalAiCostUsd)}</div>
      </div>
    </div>
  );
}
