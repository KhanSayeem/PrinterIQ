/** Turn a hit on a preview page into a per-lead view record.
 *
 * Preview pages are static HTML on disk. nginx serves them straight from
 * `/var/www/previews/p/{preview_slug}/` with `try_files`, so there is no
 * application code in the request path and nothing to hook. The page reaches
 * this module by way of the `mirror` directive in
 * `nginx/preview.presciaiq.com.conf`: nginx duplicates the request into an
 * internal location that posts here, and discards whatever comes back. The
 * prospect's page is served by the original request and is never held up by,
 * and never fails because of, anything below.
 *
 * That property is the whole design constraint. Everything here either
 * returns a value or logs, and nothing throws.
 */

export type PreviewViewRecord = { lead_id: string };

export type PreviewViewQueries = {
  recordWebsitePreviewView(tenantId: string, previewSlug: string): Promise<PreviewViewRecord | null>;
};

export type PreviewViewConfig = {
  secret: string;
  tenantId: string;
  queries: PreviewViewQueries;
};

export type PreviewViewRequest = {
  path: string | undefined;
  method: string | undefined;
  userAgent: string | undefined;
};

export type PreviewViewOutcome =
  | { recorded: true; leadId: string }
  | { recorded: false; reason: "not_a_preview_path" | "non_human" | "unknown_slug" | "record_failed" };

/** Preview slugs are 32 lowercase hex characters: a UUID with the dashes
 * stripped, minted by migration 0007 and by the generate_preview worker.
 * Matching the shape rather than "whatever follows /p/" means a traversal
 * attempt, a favicon request or a stray asset path can never become a
 * database round trip.
 */
const PREVIEW_PATH_PATTERN = /^\/p\/([0-9a-f]{32})(?:\/.*)?(?:\?.*)?$/;

/** Substrings matched against a lowercased user agent.
 *
 * Deliberately short. Elaborate bot detection is not worth building for this
 * signal, and a false negative only costs an overcounted view, whereas a
 * false positive erases the only evidence that a prospect engaged.
 *
 * The mail security scanners in the second group are the ones that matter.
 * Search crawlers cannot reach a preview at all: the slug is high entropy,
 * the page carries `X-Robots-Tag: noindex, nofollow, noarchive`, and the URL
 * appears in exactly one email. A scanner, by contrast, fetches every URL in
 * a message before the prospect has seen it, which is precisely a view that
 * did not happen.
 */
const NON_HUMAN_USER_AGENT_MARKERS = [
  // Generic automation and crawlers.
  "bot",
  "crawler",
  "spider",
  "slurp",
  "curl/",
  "wget",
  "python-requests",
  "httpclient",
  "go-http-client",
  "headlesschrome",
  "phantomjs",
  "monitoring",
  "uptimerobot",
  "pingdom",
  // Mail security and link scanners.
  "proofpoint",
  "urldefense",
  "bingpreview",
  "barracuda",
  "mimecast",
  "symantec",
  "forcepoint",
  "safelinks",
  "microsoft office",
  "ms-office",
];

/** Return the preview slug a request refers to, or null if it refers to none. */
export function extractPreviewSlug(path: string | undefined): string | null {
  if (!path) {
    return null;
  }

  const match = PREVIEW_PATH_PATTERN.exec(path);
  return match ? match[1]! : null;
}

/** Decide whether a request should be left uncounted.
 *
 * HEAD is excluded because no human reads a page they did not fetch a body
 * for: it is a link checker, a scanner or a monitor. An absent or blank user
 * agent is excluded for the same reason, since every real browser sends one.
 */
export function isNonHumanRequest(method: string | undefined, userAgent: string | undefined): boolean {
  if ((method ?? "GET").toUpperCase() === "HEAD") {
    return true;
  }

  const agent = userAgent?.trim().toLowerCase();
  if (!agent) {
    return true;
  }

  return NON_HUMAN_USER_AGENT_MARKERS.some((marker) => agent.includes(marker));
}

/** Show enough of a slug to correlate two log lines, not enough to open the page.
 *
 * A slug is a bearer token for one named prospect's page, so it gets the same
 * treatment the no-PII rule gives an email address.
 */
function maskSlug(previewSlug: string): string {
  return `${previewSlug.slice(0, 6)}...`;
}

export async function recordPreviewView(
  request: PreviewViewRequest,
  config: { tenantId: string; queries: PreviewViewQueries },
): Promise<PreviewViewOutcome> {
  const previewSlug = extractPreviewSlug(request.path);
  if (!previewSlug) {
    return { recorded: false, reason: "not_a_preview_path" };
  }

  if (isNonHumanRequest(request.method, request.userAgent)) {
    return { recorded: false, reason: "non_human" };
  }

  let record: PreviewViewRecord | null;
  try {
    record = await config.queries.recordWebsitePreviewView(config.tenantId, previewSlug);
  } catch (error) {
    // Logged rather than swallowed in silence. A green log has already meant
    // "never ran" on this project more than once, and a view recorder that
    // fails on every request would otherwise look exactly like a campaign
    // that landed in spam, which is the one conclusion this feature exists
    // to rule out.
    const reason = error instanceof Error ? error.message : "unknown error";
    console.warn(`preview view not recorded: slug=${maskSlug(previewSlug)} reason=${reason}`);
    return { recorded: false, reason: "record_failed" };
  }

  if (!record) {
    console.warn(`preview view not recorded: slug=${maskSlug(previewSlug)} reason=no_preview_for_tenant`);
    return { recorded: false, reason: "unknown_slug" };
  }

  return { recorded: true, leadId: record.lead_id };
}
