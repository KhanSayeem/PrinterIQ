import type { TodayMetricTone, TodaySoFarSummary } from "@/db/queries";

type TodaySoFarBarProps = {
  /** Null when the day's numbers could not be read, which is said out loud. */
  summary: TodaySoFarSummary | null;
};

function formatRateOfSent(rate: number | null) {
  return rate === null ? "no sends today" : `${rate.toFixed(1)}% of sent`;
}

function TodayMetric({
  label,
  value,
  detail,
  tone = "neutral",
  muted = false,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: TodayMetricTone;
  muted?: boolean;
}) {
  return (
    <div className={`today-metric ${tone === "warning" ? "warning" : ""} ${muted ? "muted" : ""}`.trim()}>
      <div className="today-metric-label">{label}</div>
      <div className="today-metric-value">{value}</div>
      <div className="today-metric-detail">{detail}</div>
    </div>
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
          <TodayMetric
            label="Sent"
            value={summary.sent.toLocaleString()}
            detail={summary.anySent ? "emails out today" : "nothing out today"}
          />
          <TodayMetric label="Opens" value="--" detail="Not tracked" muted />
          <TodayMetric
            label="Replies"
            value={summary.replies.toLocaleString()}
            detail={formatRateOfSent(summary.replyRate)}
          />
          <TodayMetric
            label="Bounces"
            value={summary.bounces.toLocaleString()}
            detail={formatRateOfSent(summary.bounceRate)}
            tone={summary.bounceTone}
          />
          <TodayMetric
            label="Unsubscribes"
            value={summary.unsubscribes.toLocaleString()}
            detail={formatRateOfSent(summary.unsubscribeRate)}
            tone={summary.unsubscribeTone}
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
