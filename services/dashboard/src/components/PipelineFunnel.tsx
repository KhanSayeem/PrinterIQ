import Link from "next/link";
import type { PipelineAnalytics, PipelineConversion, PipelineStage, PipelineStatus } from "@/db/queries";

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
        <div className="funnel-bars-title">Conversion between stages</div>
        {conversions.map((conversion) => (
          <ConversionBar key={`${conversion.from}-${conversion.to}`} conversion={conversion} />
        ))}
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

function ConversionBar({ conversion }: { conversion: PipelineConversion }) {
  const width = conversion.rate ?? 0;
  const label = `${titleCase(conversion.from)} -> ${titleCase(conversion.to)}`;

  return (
    <div className="fbar-row">
      <div className="fbar-meta">
        <span>{label}</span>
        <span>{conversion.count.toLocaleString()} leads</span>
        <span>{conversion.droppedCount.toLocaleString()} dropped</span>
        <span className={conversion.to === "paid" && conversion.rate !== null ? "conversion-paid" : ""}>
          {conversion.rate === null ? "No prior stage data" : conversion.label}
        </span>
      </div>
      <div className="fbar-track" aria-label={`${label} conversion`}>
        <div
          className={`fbar-fill ${conversion.to === "paid" ? "green" : ""}`}
          style={{ width: `${Math.max(0, Math.min(width, 100))}%` }}
        />
      </div>
    </div>
  );
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
