import { InstantlyHttpClient } from "@/clients/instantly";
import type { InstantlyDailyAccountAnalytics } from "@/clients/instantly";
import { DeliverabilityPanel } from "@/components/DeliverabilityPanel";
import {
  BOUNCE_WINDOW_DAYS,
  buildDeliverabilityReport,
  filterAccountsBySendingDomains,
  isoDateDaysBefore,
  parseSendingDomains,
  sendingDayIsoDate,
} from "@/lib/deliverability";

/** The sending estate is Australian, so the sending day is read in Sydney time. */
const DEFAULT_TIMEZONE = "Australia/Sydney";

export const dynamic = "force-dynamic";

function loadErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Instantly loading error";
}

export default async function DeliverabilityPage() {
  if (!process.env.INSTANTLY_API_KEY) {
    return (
      <>
        <PageHeader subtitle="Sending account health" />
        <div className="error-state">
          INSTANTLY_API_KEY is not configured, so mailbox health cannot be read. Set it in
          services/dashboard/.env.production and restart the dashboard.
        </div>
      </>
    );
  }

  const client = new InstantlyHttpClient();
  const timeZone = process.env.DASHBOARD_TIMEZONE || DEFAULT_TIMEZONE;
  const today = sendingDayIsoDate(new Date(), timeZone);

  let accounts;
  try {
    accounts = await client.listAccounts();
  } catch (error) {
    const message = loadErrorMessage(error);
    console.error("Failed to load Instantly sending accounts", { message });

    return (
      <>
        <PageHeader subtitle="Sending account health" />
        <div className="error-state">
          Failed to load sending accounts from Instantly. Check INSTANTLY_API_KEY and connectivity.
          {process.env.NODE_ENV !== "production" ? <div className="error-detail">{message}</div> : null}
        </div>
      </>
    );
  }

  const sendingDomains = parseSendingDomains(process.env.DELIVERABILITY_SENDING_DOMAINS);
  const mailboxes = filterAccountsBySendingDomains(accounts, sendingDomains);

  /**
   * The analytics call is separate on purpose. If it fails the panel still shows
   * warmup and limits, and every analytics backed figure reads "not available"
   * rather than zero.
   */
  let analytics: InstantlyDailyAccountAnalytics[] | null = null;
  let notice: string | null = null;
  try {
    analytics = await client.getDailyAccountAnalytics({
      emails: mailboxes.map((account) => account.email),
      startDate: isoDateDaysBefore(today, BOUNCE_WINDOW_DAYS - 1),
      endDate: today,
    });
  } catch (error) {
    const message = loadErrorMessage(error);
    console.error("Failed to load Instantly daily account analytics", { message });
    notice =
      "Daily analytics could not be loaded from Instantly, so send counts, bounce rate and ramp are not available.";
  }

  if (!notice && !sendingDomains.length) {
    notice =
      "DELIVERABILITY_SENDING_DOMAINS is not set, so every mailbox in the Instantly workspace is listed. ADR 005 records that some of them belong to a different project and are not PrinterIQ capacity.";
  }

  const report = buildDeliverabilityReport({ accounts: mailboxes, analytics, today });

  return (
    <>
      <PageHeader subtitle={`Sending account health · ${today} (${timeZone})`} />
      <div className="funnel-content">
        <DeliverabilityPanel report={report} notice={notice} />
      </div>
    </>
  );
}

function PageHeader({ subtitle }: { subtitle: string }) {
  return (
    <div className="page-header">
      <div className="page-title-wrap">
        <div className="page-title">Deliverability</div>
        <div className="page-subtitle">{subtitle}</div>
      </div>
    </div>
  );
}
