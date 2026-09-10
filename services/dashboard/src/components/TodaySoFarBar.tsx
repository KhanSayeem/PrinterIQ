import type { ReactNode } from "react";
import type { TodayMetricTone, TodaySoFarSummary } from "@/db/queries";
import type { MetricAvailability } from "@/lib/deliverability";
import { MetricCardShell } from "./MetricCardShell";

type TodaySoFarBarProps = {
  /** Null when the day's numbers could not be read, which is said out loud. */
  summary: TodaySoFarSummary | null;
};

function formatRateOfSent(rate: MetricAvailability<number>) {
  return rate.available ? `${rate.value.toFixed(1)}% of sent` : rate.reason;
}

/**
 * An unavailable figure renders as words, never as a zero, in the same markup
 * the deliverability panel uses. A zero here reads as a quiet sending day and
 * would be indistinguishable from Instantly being unreachable.
 */
function MetricValue({ metric }: { metric: MetricAvailability<number> }) {
  if (!metric.available) {
    return (
      <span className="deliv-unavailable">
        <span className="deliv-unavailable-label">Not available</span>
        <span className="deliv-unavailable-reason">{metric.reason}</span>
      </span>
    );
  }

  return <span>{metric.value.toLocaleString()}</span>;
}

function TodayMetric({
  label,
  value,
  detail,
  tone = "neutral",
  muted = false,
  href,
}: {
  label: string;
  value: ReactNode;
  detail: string;
  tone?: TodayMetricTone;
  muted?: boolean;
  /** Where this figure is explained. Omitted when there is nowhere useful to go. */
  href?: string;
}) {
  const className = `today-metric ${tone === "warning" ? "warning" : ""} ${muted ? "muted" : ""}`.trim();

  return (
    <MetricCardShell className={className} href={href}>
      <div className="today-metric-label">{label}</div>
      <div className="today-metric-value">{value}</div>
      <div className="today-metric-detail">{detail}</div>
    </MetricCardShell>
  );
}

export function TodaySoFarBar({ summary }: TodaySoFarBarProps) {
  return (
    <section className="today-bar" aria-label="Today so far">
      <div className="today-bar-head">
        <div className="today-bar-title">Today so far</div>
        <div className="today-bar-day">{summary ? `${summary.dayLabel} · Sydney time` : "Sydney time"}</div>
      </div>
      {summary === null ? (
        <div className="today-bar-note">
          Today so far could not be loaded. The lead list below is unaffected.
        </div>
      ) : summary.hasActivity ? (
        <div className="today-bar-metrics">
          {/* The send count is Instantly's own record of what left a mailbox,
              counted one email at a time so the Sydney day boundary is applied
              to each send rather than to a UTC calendar bucket. */}
          <TodayMetric
            label="Sent"
            value={<MetricValue metric={summary.sent} />}
            detail={
              summary.sent.available
                ? summary.anySent
                  ? "emails out today"
                  : "nothing out today"
                : "Instantly reports the count, and it did not answer"
            }
            href="/deliverability"
          />
          {/* Open tracking is off for deliverability, so this tile counts
              nothing and has nothing to drill into. */}
          <TodayMetric label="Opens" value="--" detail="Not tracked" muted />
          <TodayMetric
            label="Replies"
            value={<MetricValue metric={{ available: true, value: summary.replies }} />}
            detail={formatRateOfSent(summary.replyRate)}
            href="/replies?filter=all"
          />
          {/* Instantly publishes no bounce figure that can be cut at Sydney
              midnight, so this tile usually has no count. The detail line then
              names where the measured rate is rather than repeating the reason
              already printed in the value. */}
          <TodayMetric
            label="Bounces"
            value={<MetricValue metric={summary.bounces} />}
            detail={
              summary.bounces.available
                ? formatRateOfSent(summary.bounceRate)
                : "Bounce rate is on the deliverability page"
            }
            tone={summary.bounceTone}
            href="/deliverability"
          />
          <TodayMetric
            label="Unsubscribes"
            value={<MetricValue metric={{ available: true, value: summary.unsubscribes }} />}
            detail={formatRateOfSent(summary.unsubscribeRate)}
            tone={summary.unsubscribeTone}
            href="/leads?unsubscribed=1"
          />
        </div>
      ) : (
        <div className="today-bar-note">
          No emails sent yet today, and nothing has come back. This bar fills in once the campaign
          starts sending.
        </div>
      )}
    </section>
  );
}
