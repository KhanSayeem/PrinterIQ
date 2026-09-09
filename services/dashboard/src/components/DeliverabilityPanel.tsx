import { AlertTriangle, CircleAlert, CircleCheck, CircleHelp } from "lucide-react";
import {
  BOUNCE_RATE_INVESTIGATE_THRESHOLD,
  formatPercent,
  type DeliverabilityReport,
  type HealthVerdict,
  type MailboxHealth,
  type MetricAvailability,
} from "@/lib/deliverability";
import { MetricCardShell } from "./MetricCardShell";

const VERDICT_COPY: Record<HealthVerdict, { headline: string; detail: string }> = {
  critical: {
    headline: "Stop sending and investigate",
    detail: "At least one mailbox is past a threshold. Sending more from it makes the domain worse.",
  },
  warning: {
    headline: "Check before the next send",
    detail: "At least one mailbox needs attention before the ramp moves up a level.",
  },
  unknown: {
    headline: "Not enough data to judge",
    detail: "At least one figure this verdict depends on is not available. Do not read that as healthy.",
  },
  ok: {
    headline: "Safe to keep sending",
    detail: "Every mailbox is inside its thresholds on the figures Instantly reports.",
  },
};

const VERDICT_ICON: Record<HealthVerdict, typeof CircleCheck> = {
  critical: CircleAlert,
  warning: AlertTriangle,
  unknown: CircleHelp,
  ok: CircleCheck,
};

export function DeliverabilityPanel({
  report,
  notice,
}: {
  report: DeliverabilityReport;
  notice?: string | null;
}) {
  const VerdictIcon = VERDICT_ICON[report.verdict];
  const copy = VERDICT_COPY[report.verdict];

  return (
    <div className="deliv-panel">
      <div className={`deliv-verdict deliv-verdict-${report.verdict}`} role="status">
        <span className="deliv-verdict-icon" aria-hidden="true">
          <VerdictIcon size={18} />
        </span>
        <div className="deliv-verdict-copy">
          <div className="deliv-verdict-headline">{copy.headline}</div>
          <div className="deliv-verdict-detail">{copy.detail}</div>
        </div>
        <div className="deliv-verdict-counts">
          <span className="deliv-count deliv-count-critical">{report.criticalCount} critical</span>
          <span className="deliv-count deliv-count-warning">{report.warningCount} warning</span>
          <span className="deliv-count deliv-count-unknown">{report.unknownCount} unknown</span>
          <span className="deliv-count deliv-count-ok">{report.okCount} ok</span>
        </div>
      </div>

      {notice ? <div className="deliv-notice">{notice}</div> : null}

      <div className="metrics-grid">
        {/* The limit is changed on the sending page, so that is where a click
            on the estate total should land. */}
        <MetricCardShell className="metric-card" href="/sending">
          <div className="metric-label">Estate daily limit</div>
          <div className="metric-value">
            <MetricText metric={report.totalDailyLimit} format={(value) => value.toLocaleString()} />
          </div>
          <div className="metric-delta">Sum of every mailbox limit Instantly reports</div>
        </MetricCardShell>
        {/* Sent today and the spam rate stay unlinked: the per mailbox
            breakdown of both is already further down this same page. */}
        <div className="metric-card">
          <div className="metric-label">Sent today</div>
          <div className="metric-value">
            <MetricText metric={report.totalSentToday} format={(value) => value.toLocaleString()} />
          </div>
          <div className="metric-delta">Campaign sends recorded by Instantly for today</div>
        </div>
        <div className="metric-card" role="group" aria-label="Spam complaint rate">
          <div className="metric-label">Spam complaint rate</div>
          <div className="metric-value">
            <MetricText metric={report.spamComplaintRate} format={(value) => formatPercent(value, 2)} />
          </div>
          <div className="metric-delta">
            Instantly exposes no spam figure. Read it in Google Postmaster Tools, and treat any single
            complaint as a stop signal at this volume.
          </div>
        </div>
      </div>

      <section className="deliv-thresholds">
        <div className="dp-section-title">Thresholds and where they come from</div>
        <ul className="deliv-threshold-list">
          <li>
            Google&apos;s sender guidelines: keep the spam rate below 0.1%, and never let it reach
            0.3% or higher.
          </li>
          <li>
            Bounce rate above {formatPercent(BOUNCE_RATE_INVESTIGATE_THRESHOLD)} is the line where a
            sender should stop and investigate. This is a PrinterIQ operating threshold: no mailbox
            provider publishes a bounce rate figure.
          </li>
          <li>
            Google&apos;s guidance on increasing volume describes a common daily increase of 25% to
            100%. Anything faster than that is flagged here.
          </li>
        </ul>
      </section>

      {report.mailboxes.length ? (
        <div className="deliv-mailboxes">
          {report.mailboxes.map((mailbox) => (
            <MailboxCard key={mailbox.email} mailbox={mailbox} windowDays={report.bounceWindowDays} />
          ))}
        </div>
      ) : (
        <div className="empty-state">Instantly returned no sending accounts.</div>
      )}
    </div>
  );
}

function MailboxCard({ mailbox, windowDays }: { mailbox: MailboxHealth; windowDays: number }) {
  return (
    <article
      className={`deliv-card deliv-card-${mailbox.verdict}`}
      role="group"
      aria-label={mailbox.email}
    >
      <header className="deliv-card-header">
        <div className="deliv-card-identity">
          <div className="deliv-card-email">{mailbox.email}</div>
          <div className="deliv-card-domain">{mailbox.domain}</div>
        </div>
        <div className="deliv-chip-row">
          <span className={`deliv-chip ${mailbox.isActive ? "deliv-chip-ok" : "deliv-chip-muted"}`}>
            {mailbox.accountStatusLabel}
          </span>
          <span
            className={`deliv-chip ${mailbox.warmupEnabled ? "deliv-chip-ok" : "deliv-chip-warn"}`}
          >
            {mailbox.warmupEnabled ? "Warmup active" : "Warmup off"}
          </span>
        </div>
      </header>

      {mailbox.breaches.length ? (
        <ul className="deliv-breach-list">
          {mailbox.breaches.map((breach) => (
            <li className={`deliv-breach deliv-breach-${breach.severity}`} key={breach.id}>
              <span className="deliv-breach-label">{breach.label}</span>
              <span className="deliv-breach-detail">{breach.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="deliv-metric-grid">
        <MailboxMetric label="Daily limit" metric={mailbox.dailyLimit} format={(value) => String(value)} />
        <MailboxMetric label="Sent today" metric={mailbox.sentToday} format={(value) => String(value)} />
        <MailboxMetric
          label="Limit used today"
          metric={mailbox.limitUsedPct}
          format={(value) => `${value.toFixed(1)}%`}
        />
        <MailboxMetric
          label={`Bounce rate, ${windowDays} days`}
          metric={mailbox.bounceRate}
          format={(value) => formatPercent(value)}
          hint={bounceHint(mailbox)}
        />
        <MailboxMetric
          label="Warmup score"
          metric={mailbox.warmupScore}
          format={(value) => String(value)}
        />
        <MailboxMetric
          label="Day over day volume"
          metric={mailbox.dayOverDayIncrease}
          format={(value) => `${value >= 0 ? "+" : ""}${formatPercent(value)}`}
        />
      </div>
    </article>
  );
}

function bounceHint(mailbox: MailboxHealth): string | null {
  if (!mailbox.bouncedInWindow.available || !mailbox.sentInWindow.available) {
    return null;
  }
  return `${mailbox.bouncedInWindow.value} bounced of ${mailbox.sentInWindow.value} sent`;
}

function MailboxMetric({
  label,
  metric,
  format,
  hint,
}: {
  label: string;
  metric: MetricAvailability<number>;
  format: (value: number) => string;
  hint?: string | null;
}) {
  return (
    <div className="deliv-metric" role="group" aria-label={label}>
      <div className="metric-label">{label}</div>
      <div className="deliv-metric-value">
        <MetricText metric={metric} format={format} />
      </div>
      {metric.available && hint ? <div className="deliv-metric-hint">{hint}</div> : null}
    </div>
  );
}

/**
 * An unavailable metric renders as words, never as a zero. A zero here reads as
 * a healthy result and this project has already been burned by exactly that.
 */
function MetricText({
  metric,
  format,
}: {
  metric: MetricAvailability<number>;
  format: (value: number) => string;
}) {
  if (!metric.available) {
    return (
      <span className="deliv-unavailable">
        <span className="deliv-unavailable-label">Not available</span>
        <span className="deliv-unavailable-reason">{metric.reason}</span>
      </span>
    );
  }

  return <span>{format(metric.value)}</span>;
}
