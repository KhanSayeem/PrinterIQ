import type { PipelineConversion } from "@/db/queries";

const chartWidth = 720;
const chartHeight = 286;
const padding = { top: 30, right: 14, bottom: 86, left: 44 };
const plotWidth = chartWidth - padding.left - padding.right;
const plotHeight = chartHeight - padding.top - padding.bottom;
const plotBottom = padding.top + plotHeight;
const gridValues = [0, 25, 50, 75, 100];
const maxBarWidth = 62;

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function transitionLabel(conversion: PipelineConversion) {
  return `${titleCase(conversion.from)} to ${titleCase(conversion.to)}`;
}

function enteredPreviousStage(conversion: PipelineConversion) {
  return conversion.count + conversion.droppedCount;
}

function summarize(conversions: PipelineConversion[]) {
  const measured = conversions.filter((conversion) => conversion.rate !== null);
  if (!measured.length) {
    return "Conversion between stages. No stage transitions have data yet.";
  }

  return `Conversion between stages. ${measured
    .map((conversion) => `${transitionLabel(conversion)} ${conversion.label}`)
    .join(", ")}.`;
}

export function ConversionChart({ conversions }: { conversions: PipelineConversion[] }) {
  const bandWidth = conversions.length ? plotWidth / conversions.length : plotWidth;
  const barWidth = Math.min(maxBarWidth, bandWidth * 0.52);

  return (
    <div className="conversion-chart">
      <div className="conversion-chart-heading">
        <div className="funnel-bars-title">Conversion between stages</div>
        <div className="conversion-chart-sub">Share of the previous stage that reached the next one</div>
      </div>
      <div className="conversion-chart-scroll">
        <svg
          className="conversion-chart-svg"
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          role="img"
          aria-label={summarize(conversions)}
        >
          {gridValues.map((value) => {
            const y = plotBottom - (value / 100) * plotHeight;
            return (
              <g key={value}>
                <line
                  className={`cc-grid ${value === 0 ? "cc-grid-base" : ""}`}
                  x1={padding.left}
                  x2={chartWidth - padding.right}
                  y1={y}
                  y2={y}
                />
                <text className="cc-axis-label" x={padding.left - 10} y={y + 4} textAnchor="end">
                  {value}%
                </text>
              </g>
            );
          })}

          {conversions.map((conversion, index) => {
            const bandCentre = padding.left + bandWidth * (index + 0.5);
            const barX = bandCentre - barWidth / 2;
            const rate = conversion.rate;
            const hasRate = rate !== null;
            const barHeight = hasRate ? Math.max((Math.min(rate, 100) / 100) * plotHeight, rate > 0 ? 2 : 0) : 0;
            const barY = plotBottom - barHeight;

            return (
              <g key={`${conversion.from}-${conversion.to}`}>
                {hasRate ? (
                  <>
                    <rect
                      className={`cc-bar ${conversion.to === "paid" ? "cc-bar-paid" : ""}`}
                      x={barX}
                      y={barY}
                      width={barWidth}
                      height={barHeight}
                      rx={3}
                    >
                      <title>{`${transitionLabel(conversion)}: ${conversion.label}`}</title>
                    </rect>
                    <text className="cc-value" x={bandCentre} y={barY - 9} textAnchor="middle">
                      {conversion.label}
                    </text>
                  </>
                ) : (
                  <>
                    <rect
                      className="cc-bar-empty"
                      x={barX}
                      y={plotBottom - 6}
                      width={barWidth}
                      height={6}
                      rx={3}
                    />
                    <text className="cc-value cc-value-muted" x={bandCentre} y={plotBottom - 16} textAnchor="middle">
                      No prior stage data
                    </text>
                  </>
                )}
                <text className="cc-stage" x={bandCentre} y={plotBottom + 24} textAnchor="middle">
                  {titleCase(conversion.to)}
                </text>
                <text className="cc-detail" x={bandCentre} y={plotBottom + 42} textAnchor="middle">
                  {`${conversion.count.toLocaleString()} of ${enteredPreviousStage(conversion).toLocaleString()}`}
                </text>
                <text className="cc-detail" x={bandCentre} y={plotBottom + 58} textAnchor="middle">
                  {`${conversion.droppedCount.toLocaleString()} dropped`}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
