import Link from "next/link";
import type { PipelineAnalytics, PipelineStage, PipelineStatus } from "@/db/queries";
import { ConversionChart } from "./ConversionChart";

type PipelineFunnelProps = Pick<PipelineAnalytics, "stages" | "conversions"> & {
  selectedStage: PipelineStatus;
};

export function PipelineFunnel({ stages, conversions, selectedStage }: PipelineFunnelProps) {
  return (
    <div className="funnel-content">
      <div className="stage-grid">
        {stages.map((stage) => (
          <StageCard key={stage.status} stage={stage} selected={stage.status === selectedStage} />
        ))}
      </div>
      <div className="funnel-bars">
        <ConversionChart conversions={conversions} />
      </div>
    </div>
  );
}

function StageCard({ stage, selected }: { stage: PipelineStage; selected: boolean }) {
  const subtitle =
    stage.status === "imported"
      ? "100% of total"
      : stage.status === "archived"
        ? "side bucket"
        : `${stage.totalRate.toFixed(1)}% of imported`;

  return (
    <Link
      className={`stage-card ${stage.count > 0 ? "has-data" : ""} ${selected ? "selected" : ""}`}
      href={`/pipeline?stage=${stage.status}`}
    >
      <div className="stage-name">{stage.label}</div>
      <div className="stage-count">{stage.count.toLocaleString()}</div>
      <div className="stage-pct">{subtitle}</div>
    </Link>
  );
}
