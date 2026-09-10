import { getDashboardTenantId } from "@/auth/tenant";
import { ReplyInbox } from "@/components/ReplyInbox";
import {
  getReplyIngestSignal,
  getReplyInboxFilterCounts,
  getReplyInboxPage,
  type ReplyInboxFilterCounts,
  type ReplyInboxRow,
} from "@/db/queries";
import { parseReplyInboxParams } from "@/lib/reply-inbox-params";
import { describeReplyIngestHealth, type ReplyIngestHealth } from "@/lib/reply-ingest-health";

const PAGE_SIZE = 25;

function getReplyLoadErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown reply loading error";
}

export default async function RepliesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { filter, page: requestedPage } = parseReplyInboxParams(await searchParams);

  let replies: ReplyInboxRow[];
  let counts: ReplyInboxFilterCounts;
  let total = 0;
  let page = requestedPage;
  let totalPages = 1;
  /** Null when the health signal itself could not be read.
   *
   * It is loaded separately from the inbox on purpose. A failure here must not
   * take the replies off the screen, and it must not be reported as a healthy
   * ingest path either, so the empty state says the check could not be read.
   */
  let ingestHealth: ReplyIngestHealth | null = null;

  try {
    const tenantId = getDashboardTenantId();
    if (!tenantId) {
      throw new Error("Dashboard tenant not configured");
    }

    const [filterCounts, replyPage] = await Promise.all([
      getReplyInboxFilterCounts({ tenantId }),
      getReplyInboxPage({ tenantId, filter, page: requestedPage, pageSize: PAGE_SIZE }),
    ]);

    counts = filterCounts;
    replies = replyPage.rows;
    total = replyPage.total;
    page = replyPage.page;
    totalPages = replyPage.totalPages;

    try {
      ingestHealth = describeReplyIngestHealth(await getReplyIngestSignal({ tenantId }));
    } catch (error) {
      console.error("Failed to read inbound reply ingest health", {
        message: getReplyLoadErrorMessage(error),
      });
    }
  } catch (error) {
    const message = getReplyLoadErrorMessage(error);
    console.error("Failed to load replies", { message });

    return (
      <div className="error-state">
        Failed to load replies. Check DATABASE_URL and Supabase connectivity.
        {process.env.NODE_ENV !== "production" ? <div className="error-detail">{message}</div> : null}
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title-wrap">
          <div className="page-title">Replies</div>
          <div className="page-subtitle">
            Inbound replies recorded by the reply agent webhook, newest first. Read only: sending stays in
            Instantly.
          </div>
        </div>
      </div>
      <ReplyInbox
        replies={replies}
        counts={counts}
        filter={filter}
        page={page}
        totalPages={totalPages}
        total={total}
        ingestHealth={ingestHealth}
      />
    </>
  );
}
