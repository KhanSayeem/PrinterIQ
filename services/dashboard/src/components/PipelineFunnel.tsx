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
 * The headline figure is the cohort that ever reached this stage, and the card
 * links to the leads view that reproduces it.
 *
 * Where that view is a status filter the current status count is named on the
 * card, so the link opening 1,951 leads under a card reading 1,960 does not
 * look like a contradiction. Where the cohort is defined by score there is no
 * status to name, so nothing is claimed.
 */
function StageCard({ stage }: { stage: PipelineStage }) {
  const showsCurrentCount =
    stage.basis === "cohort" &&
    stage.linksToCurrentStatus &&
    stage.currentCount !== null &&
    (!stage.count.available || stage.count.value !== stage.currentCount);

  return (
    <Link
      className={`stage-card ${stage.count.available && stage.count.value > 0 ? "has-data" : ""}`.trim()}
      href={stage.href}
    >
      <div className="stage-name">{stage.label}</div>
      {stage.count.available ? (
        <div className="stage-count">{stage.count.value.toLocaleString()}</div>
      ) : (
        <div className="stage-count stage-count-unavailable">Not available</div>
      )}
      {stage.criterion ? <div className="stage-criterion">{stage.criterion}</div> : null}
      <div className="stage-pct">{subtitleFor(stage)}</div>
      {showsCurrentCount ? (
        <div className="stage-note">{`${stage.currentCount!.toLocaleString()} in this status now`}</div>
      ) : null}
      {stage.cohortNote ? <div className="stage-note">{stage.cohortNote}</div> : null}
    </Link>
  );
}
