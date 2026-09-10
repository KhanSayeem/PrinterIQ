"use client";

import { useState } from "react";
import type { MetricAvailability } from "@/lib/deliverability";
import { formatPipelineRate, type PipelineConversion } from "@/lib/pipeline-funnel";

const chartWidth = 720;
const chartHeight = 286;
const padding = { top: 30, right: 14, bottom: 86, left: 44 };
const plotWidth = chartWidth - padding.left - padding.right;
const plotHeight = chartHeight - padding.top - padding.bottom;
const plotBottom = padding.top + plotHeight;
const gridValues = [0, 25, 50, 75, 100];
const maxBarWidth = 62;
const UNAVAILABLE_LABEL = "Not available";

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function transitionLabel(conversion: PipelineConversion) {
  return `${titleCase(conversion.from)} to ${titleCase(conversion.to)}`;
}

function rateLabel(rate: MetricAvailability<number>) {
  return rate.available ? formatPipelineRate(rate.value) : UNAVAILABLE_LABEL;
}

/**
 * The cohort line under a bar. Whatever was measured is shown, and whatever
 * was not is named. "0 of 0" would read as a real, empty population.
 */
function cohortLabel(conversion: PipelineConversion) {
  if (conversion.count.available && conversion.enteredCount.available) {
    return `${conversion.count.value.toLocaleString()} of ${conversion.enteredCount.value.toLocaleString()}`;
  }
  if (conversion.enteredCount.available) {
    return `${conversion.enteredCount.value.toLocaleString()} reached ${titleCase(conversion.from)}`;
  }

  return `${titleCase(conversion.from)} cohort not counted`;
}

function dropLabel(conversion: PipelineConversion) {
  return conversion.droppedCount.available
    ? `${conversion.droppedCount.value.toLocaleString()} dropped`
    : "Drop not measurable";
}

/** Trims a trailing full stop so the summary does not read "result..". */
function sentenceCase(reason: string) {
  return reason.replace(/\.\s*$/, "");
}

function summarize(conversions: PipelineConversion[]) {
  if (!conversions.length) {
    return "Conversion between stages. No stage transitions have data yet.";
  }

  return `Conversion between stages. ${conversions
    .map((conversion) =>
      conversion.rate.available
        ? `${transitionLabel(conversion)} ${formatPipelineRate(conversion.rate.value)}`
        : `${transitionLabel(conversion)} not available, ${sentenceCase(conversion.rate.reason)}`,
    )
    .join(". ")}.`;
}

/** Percentage positions so the tooltip tracks the SVG as the viewBox scales. */
function percentOfWidth(x: number) {
  return `${(x / chartWidth) * 100}%`;
}

function percentOfHeight(y: number) {
  return `${(y / chartHeight) * 100}%`;
}

export function ConversionChart({ conversions }: { conversions: PipelineConversion[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const bandWidth = conversions.length ? plotWidth / conversions.length : plotWidth;
  const barWidth = Math.min(maxBarWidth, bandWidth * 0.52);
  const hovered = hoveredIndex === null ? null : (conversions[hoveredIndex] ?? null);

  function barGeometry(conversion: PipelineConversion, index: number) {
    const bandCentre = padding.left + bandWidth * (index + 0.5);
    const rate = conversion.rate;
    const hasRate = rate.available;
    /**
     * The bar is capped at the top of the axis so it cannot spill out of the
     * plot, and a capped bar is marked so it does not read as a healthy
     * complete one. The label always prints the true rate.
     */
    const overAxis = rate.available && rate.value > 100;
    const barHeight = rate.available
      ? Math.max((Math.min(rate.value, 100) / 100) * plotHeight, rate.value > 0 ? 2 : 0)
      : 0;

    return {
      bandCentre,
      barX: bandCentre - barWidth / 2,
      hasRate,
      overAxis,
      barHeight,
      barY: plotBottom - barHeight,
    };
  }

  return (
    <div className="conversion-chart">
      <div className="conversion-chart-heading">
        <div className="funnel-bars-title">Conversion between stages</div>
        <div className="conversion-chart-sub">Share of the previous stage that reached the next one</div>
      </div>
      <div className="conversion-chart-scroll">
        <div className="conversion-chart-plot">
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
              const { bandCentre, barX, hasRate, overAxis, barHeight, barY } = barGeometry(
                conversion,
                index,
              );

              return (
                <g key={`${conversion.from}-${conversion.to}`}>
                  {hasRate ? (
                    <>
                      <rect
                        className={`cc-bar ${conversion.to === "paid" ? "cc-bar-paid" : ""} ${
                          overAxis ? "cc-bar-over" : ""
                        } ${hoveredIndex === index ? "cc-bar-hovered" : ""}`}
                        x={barX}
                        y={barY}
                        width={barWidth}
                        height={barHeight}
                        rx={3}
                      >
                        <title>{`${transitionLabel(conversion)}: ${rateLabel(conversion.rate)}`}</title>
                      </rect>
                      <text className="cc-value" x={bandCentre} y={barY - 9} textAnchor="middle">
                        {rateLabel(conversion.rate)}
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
                      >
                        <title>{`${transitionLabel(conversion)}: ${conversion.rate.available ? "" : conversion.rate.reason}`}</title>
                      </rect>
                      <text className="cc-value cc-value-muted" x={bandCentre} y={plotBottom - 16} textAnchor="middle">
                        {UNAVAILABLE_LABEL}
                      </text>
                    </>
                  )}
                  <text className="cc-stage" x={bandCentre} y={plotBottom + 24} textAnchor="middle">
                    {titleCase(conversion.to)}
                  </text>
                  <text className="cc-detail" x={bandCentre} y={plotBottom + 42} textAnchor="middle">
                    {cohortLabel(conversion)}
                  </text>
                  <text className="cc-detail" x={bandCentre} y={plotBottom + 58} textAnchor="middle">
                    {dropLabel(conversion)}
                  </text>
                </g>
              );
            })}

            {/* Invisible full height bands so the whole column is hoverable, not
                just the few pixels a low bar actually covers. */}
            {conversions.map((conversion, index) => (
              <rect
                className="cc-hit"
                key={`hit-${conversion.from}-${conversion.to}`}
                x={padding.left + bandWidth * index}
                y={padding.top}
                width={bandWidth}
                height={plotHeight}
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex((current) => (current === index ? null : current))}
              />
            ))}
          </svg>

          {hovered ? (
            <div
              className="cc-tooltip"
              role="tooltip"
              style={{
                left: percentOfWidth(barGeometry(hovered, hoveredIndex as number).bandCentre),
                top: percentOfHeight(barGeometry(hovered, hoveredIndex as number).barY),
              }}
            >
              <div className="cc-tooltip-stage">{titleCase(hovered.to)}</div>
              <div className="cc-tooltip-count">
                {hovered.count.available && hovered.enteredCount.available
                  ? `${cohortLabel(hovered)} leads`
                  : cohortLabel(hovered)}
              </div>
              <div className="cc-tooltip-rate">
                {hovered.rate.available
                  ? `${formatPipelineRate(hovered.rate.value)} of ${titleCase(hovered.from)}`
                  : hovered.rate.reason}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
