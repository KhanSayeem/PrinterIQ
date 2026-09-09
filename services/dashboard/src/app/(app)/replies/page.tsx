import { getDashboardTenantId } from "@/auth/tenant";
import { ReplyInbox } from "@/components/ReplyInbox";
import {
  getReplyInboxFilterCounts,
  getReplyInboxPage,
  type ReplyInboxFilterCounts,
  type ReplyInboxRow,
} from "@/db/queries";
import { parseReplyInboxParams } from "@/lib/reply-inbox-params";

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
            Inbound replies delivered by Instantly, newest first. Read only: sending stays in Instantly.
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
      />
    </>
  );
}
