import type { MetricAvailability } from "@/lib/deliverability";
import type { SendsToDate } from "@/lib/sends-to-date";
import { MetricCardShell } from "./MetricCardShell";

function deliveredDetail(totals: SendsToDate): string {
  // No rate before the first send: 0 of 0 is not 0%.
  if (totals.sent === 0) {
    return "Nothing sent yet";
  }
  const bounceRate = (totals.bounced / totals.sent) * 100;
  return `${totals.sent.toLocaleString()} sent, ${totals.bounced.toLocaleString()} bounced (${bounceRate.toFixed(1)}%)`;
}

/**
 * The lifetime companion to the today bar: emails that went out from the live
 * campaigns and did not bounce. It uses the today bar's markup so the two read
 * as one system, and an unavailable figure renders as words, never as a zero.
 */
export function SendsToDateBar({ sendsToDate }: { sendsToDate: MetricAvailability<SendsToDate> }) {
  return (
    <section className="today-bar" aria-label="Since launch">
      <div className="today-bar-head">
        <div className="today-bar-title">Since launch</div>
        <div className="today-bar-day">Live campaigns, from Instantly</div>
      </div>
      <div className="today-bar-metrics">
        <MetricCardShell className="today-metric today-metric-solo" href="/deliverability">
          <div className="today-metric-label">Delivered to date</div>
          <div className="today-metric-value">
            {sendsToDate.available ? (
              <span>{sendsToDate.value.delivered.toLocaleString()}</span>
            ) : (
              <span className="deliv-unavailable">
                <span className="deliv-unavailable-label">Not available</span>
                <span className="deliv-unavailable-reason">{sendsToDate.reason}</span>
              </span>
            )}
          </div>
          <div className="today-metric-detail">
            {sendsToDate.available
              ? deliveredDetail(sendsToDate.value)
              : "Instantly reports the totals, and they could not be read"}
          </div>
        </MetricCardShell>
      </div>
    </section>
  );
}
