import { InstantlyHttpClient } from "@/clients/instantly";
import type { InstantlyDailyAccountAnalytics } from "@/clients/instantly";
import { DeliverabilityPanel } from "@/components/DeliverabilityPanel";
import {
  BOUNCE_WINDOW_DAYS,
  buildDeliverabilityReport,
  filterAccountsBySendingDomains,
  isoDateDaysBefore,
  sendingDayIsoDate,
  type MailboxSends,
} from "@/lib/deliverability";
import { MISSING_SENDING_DOMAINS_MESSAGE, resolveSendingDomains } from "@/lib/sending-domains";
import { loadMailboxSendsBySydneyDay } from "@/lib/today-sends";

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
  const now = new Date();
  const today = sendingDayIsoDate(now, timeZone);

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

  /** Same allowlist as /sending, read through the same resolver.
   *
   * These two pages used to read different env vars, so a drift between them
   * would have reported two different estate sizes with nothing on screen
   * saying so. See src/lib/sending-domains.ts.
   */
  const sendingDomains = resolveSendingDomains();
  const mailboxes = filterAccountsBySendingDomains(accounts, sendingDomains);

  /**
   * The analytics call is separate on purpose. If it fails the panel still shows
   * warmup and limits, and every analytics backed figure reads "not available"
   * rather than zero.
   *
   * Only the 30 day bounce window reads it now. Sent today, limit used and the
   * ramp are counted one email at a time for the Sydney day, because the
   * analytics rows are UTC calendar days and the morning burst lands on the
   * previous UTC date. See loadMailboxSendsBySydneyDay in src/lib/today-sends.ts.
   * That loader never throws and reports each failure as its own reason, so the
   * two run side by side.
   */
  const loadAnalytics = async () => {
    try {
      return await client.getDailyAccountAnalytics({
        emails: mailboxes.map((account) => account.email),
        startDate: isoDateDaysBefore(today, BOUNCE_WINDOW_DAYS - 1),
        endDate: today,
      });
    } catch (error) {
      const message = loadErrorMessage(error);
      console.error("Failed to load Instantly daily account analytics", { message });
      return null;
    }
  };

  const [analytics, sends]: [InstantlyDailyAccountAnalytics[] | null, MailboxSends] =
    await Promise.all([
      loadAnalytics(),
      loadMailboxSendsBySydneyDay({
        client,
        mailboxes: mailboxes.map((account) => account.email),
        now,
      }),
    ]);

  let notice: string | null = null;
  if (!analytics) {
    notice = `Daily analytics could not be loaded from Instantly, so the ${BOUNCE_WINDOW_DAYS} day send and bounce counts and the bounce rate are not available.`;
  }

  if (!notice && !sendingDomains.length) {
    notice = `${MISSING_SENDING_DOMAINS_MESSAGE} Every mailbox in the workspace is listed below, and ADR 005 records that some of them belong to a different project and are not PrinterIQ capacity.`;
  }

  const report = buildDeliverabilityReport({ accounts: mailboxes, analytics, sends });

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
