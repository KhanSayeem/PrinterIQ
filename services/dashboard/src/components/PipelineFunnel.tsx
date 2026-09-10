import Link from "next/link";
import {
  formatPipelineRate,
  type PipelineAnalytics,
  type PipelineStage,
} from "@/lib/pipeline-funnel";
import { ConversionChart } from "./ConversionChart";

type PipelineFunnelProps = Pick<PipelineAnalytics, "stages" | "conversions">;

export function PipelineFunnel({ stages, conversions }: PipelineFunnelProps) {
  return (
    <div className="funnel-content">
      <div className="stage-grid">
        {stages.map((stage) => (
          <StageCard key={stage.status} stage={stage} />
        ))}
      </div>
      <div className="funnel-bars">
        <ConversionChart conversions={conversions} />
      </div>
    </div>
  );
}

/** An unmeasured cohort renders as words, never as a share of zero. */
function subtitleFor(stage: PipelineStage) {
  if (!stage.count.available) {
    return stage.count.reason;
  }

  return stage.shareOfImported.available
    ? `${formatPipelineRate(stage.shareOfImported.value)} of imported`
    : stage.shareOfImported.reason;
}

/**
 * The headline figure is the cohort that ever reached this stage. The card
 * links to the leads list, which filters on current status, so the current
 * count is named on the card rather than left to look like a contradiction.
 */
function StageCard({ stage }: { stage: PipelineStage }) {
  const showsCurrentCount =
    stage.basis === "cohort" && (!stage.count.available || stage.count.value !== stage.currentCount);

  return (
    <Link
      className={`stage-card ${stage.count.available && stage.count.value > 0 ? "has-data" : ""}`.trim()}
      href={`/leads?status=${stage.status}`}
    >
      <div className="stage-name">{stage.label}</div>
      {stage.count.available ? (
        <div className="stage-count">{stage.count.value.toLocaleString()}</div>
      ) : (
        <div className="stage-count stage-count-unavailable">Not available</div>
      )}
      <div className="stage-pct">{subtitleFor(stage)}</div>
      {showsCurrentCount ? (
        <div className="stage-note">{`${stage.currentCount.toLocaleString()} in this status now`}</div>
      ) : null}
    </Link>
  );
}
