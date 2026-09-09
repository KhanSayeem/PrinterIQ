import { describe, expect, it, vi } from "vitest";
import {
  extractPreviewSlug,
  isNonHumanRequest,
  recordPreviewView,
  type PreviewViewQueries,
} from "../src/preview_view.js";
import { fetchPreviewViewStates, recordWebsitePreviewView } from "../src/db/queries.js";
import { buildServer, type ReplyQueue } from "../src/webhook.js";

const tenantId = "10000000-0000-0000-0000-000000000001";
const leadId = "22222222-2222-4222-8222-222222222222";
const previewSlug = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const previewViewSecret = "preview-view-token";

const chromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function createPreviewViewQueries(overrides: Partial<PreviewViewQueries> = {}): PreviewViewQueries {
  return {
    recordWebsitePreviewView: vi.fn().mockResolvedValue({ lead_id: leadId }),
    ...overrides,
  };
}

function createQueue(): ReplyQueue {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("preview slug extraction", () => {
  it("reads the slug from the served preview path", () => {
    expect(extractPreviewSlug("/p/" + previewSlug + "/")).toBe(previewSlug);
    expect(extractPreviewSlug("/p/" + previewSlug)).toBe(previewSlug);
    expect(extractPreviewSlug("/p/" + previewSlug + "/index.html")).toBe(previewSlug);
    expect(extractPreviewSlug("/p/" + previewSlug + "/?utm_source=email")).toBe(previewSlug);
  });

  // /assets/ is shared page chrome served from the same root. Counting an
  // asset fetch as a view would multiply every real visit by the number of
  // images on the page.
  it("refuses any path that is not a preview page", () => {
    expect(extractPreviewSlug("/assets/previews/plumbing/hero.jpg")).toBeNull();
    expect(extractPreviewSlug("/p/")).toBeNull();
    expect(extractPreviewSlug("/")).toBeNull();
    expect(extractPreviewSlug(undefined)).toBeNull();
    expect(extractPreviewSlug("/p/../../etc/passwd")).toBeNull();
  });
});

describe("non-human traffic", () => {
  it("counts a request from a real browser", () => {
    expect(isNonHumanRequest("GET", chromeUserAgent)).toBe(false);
  });

  it("does not count a HEAD request", () => {
    expect(isNonHumanRequest("HEAD", chromeUserAgent)).toBe(true);
  });

  it("does not count a known bot user agent", () => {
    expect(
      isNonHumanRequest("GET", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"),
    ).toBe(true);
    expect(isNonHumanRequest("GET", "curl/8.5.0")).toBe(true);
    expect(isNonHumanRequest("GET", "python-requests/2.31.0")).toBe(true);
  });

  // These are the ones that actually matter here. A search crawler cannot
  // reach a preview: the slug is high entropy, the page carries an
  // X-Robots-Tag noindex header, and the URL only ever appears inside one
  // email. Mail security scanners are the real source of a fake view,
  // because they fetch every URL in a message before the prospect sees it.
  it("does not count a mail security scanner fetching the link before delivery", () => {
    expect(isNonHumanRequest("GET", "Mozilla/5.0 (compatible; proofpoint-urldefense)")).toBe(true);
    expect(isNonHumanRequest("GET", "Mozilla/5.0 (compatible; BingPreview/1.0b)")).toBe(true);
    expect(isNonHumanRequest("GET", "Barracuda Link Protection")).toBe(true);
    expect(isNonHumanRequest("GET", "Mimecast MTA")).toBe(true);
  });

  it("does not count a request with no user agent at all", () => {
    expect(isNonHumanRequest("GET", undefined)).toBe(true);
    expect(isNonHumanRequest("GET", "   ")).toBe(true);
  });
});

describe("recordPreviewView", () => {
  it("records a view for a preview page loaded by a browser", async () => {
    const queries = createPreviewViewQueries();

    const outcome = await recordPreviewView(
      { path: "/p/" + previewSlug + "/", method: "GET", userAgent: chromeUserAgent },
      { tenantId, queries },
    );

    expect(queries.recordWebsitePreviewView).toHaveBeenCalledWith(tenantId, previewSlug);
    expect(outcome).toEqual({ recorded: true, leadId });
  });

  it("does not touch the database for non-human traffic", async () => {
    const queries = createPreviewViewQueries();

    const outcome = await recordPreviewView(
      { path: "/p/" + previewSlug + "/", method: "GET", userAgent: "Googlebot/2.1" },
      { tenantId, queries },
    );

    expect(queries.recordWebsitePreviewView).not.toHaveBeenCalled();
    expect(outcome).toEqual({ recorded: false, reason: "non_human" });
  });

  // The whole point of the mirror design is that a tracking outage is
  // invisible to the prospect. If this throws, the failure lands on an nginx
  // subrequest for a page that has already been served, where nobody is
  // looking, and the only delivery signal we have goes quiet unnoticed.
  it("swallows a database failure instead of propagating it", async () => {
    const queries = createPreviewViewQueries({
      recordWebsitePreviewView: vi
        .fn()
        .mockRejectedValue(new Error("connection terminated unexpectedly")),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const outcome = await recordPreviewView(
      { path: "/p/" + previewSlug + "/", method: "GET", userAgent: chromeUserAgent },
      { tenantId, queries },
    );

    expect(outcome).toEqual({ recorded: false, reason: "record_failed" });
    expect(warn).toHaveBeenCalled();

    // The slug is the only thing between a stranger and a named prospect's
    // page, so it is masked in logs the way an email address is.
    const logged = warn.mock.calls.map((call) => String(call[0])).join(" ");
    expect(logged).not.toContain(previewSlug);
    warn.mockRestore();
  });

  it("reports a slug that matches no preview for this tenant", async () => {
    const queries = createPreviewViewQueries({
      recordWebsitePreviewView: vi.fn().mockResolvedValue(null),
    });

    const outcome = await recordPreviewView(
      { path: "/p/" + previewSlug + "/", method: "GET", userAgent: chromeUserAgent },
      { tenantId, queries },
    );

    expect(outcome).toEqual({ recorded: false, reason: "unknown_slug" });
  });
});

describe("recordWebsitePreviewView query", () => {
  it("sets first_viewed_at once and updates last_viewed_at and view_count on every view", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ lead_id: leadId }] });

    const result = await recordWebsitePreviewView(tenantId, previewSlug, { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("UPDATE website_previews");
    expect(sql).toContain("first_viewed_at = COALESCE(first_viewed_at, NOW())");
    expect(sql).toContain("last_viewed_at  = NOW()");
    expect(sql).toContain("view_count      = view_count + 1");
    expect(sql).toContain("RETURNING lead_id");
    expect(params).toEqual([tenantId, previewSlug]);
    expect(result).toEqual({ lead_id: leadId });
  });

  it("scopes the write by tenant_id", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ lead_id: leadId }] });

    await recordWebsitePreviewView(tenantId, previewSlug, { query });

    const [sql] = query.mock.calls[0]!;
    expect(sql).toContain("WHERE tenant_id = $1");
    expect(sql).toContain("AND preview_slug = $2");
  });

  it("returns null when the slug belongs to no preview for this tenant", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(recordWebsitePreviewView(tenantId, previewSlug, { query })).resolves.toBeNull();
  });
});

describe("fetchPreviewViewStates query", () => {
  it("returns per-lead view state scoped by tenant", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          lead_id: leadId,
          first_viewed_at: new Date("2026-08-26T01:00:00Z"),
          last_viewed_at: new Date("2026-08-26T02:00:00Z"),
          view_count: 2,
          preview_seen: true,
        },
      ],
    });

    const result = await fetchPreviewViewStates(tenantId, null, { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("FROM website_previews");
    expect(sql).toContain("WHERE website_previews.tenant_id = $1");
    expect(sql).toContain("website_previews.first_viewed_at IS NOT NULL AS preview_seen");
    expect(sql).toContain("website_previews.view_count");
    expect(params).toEqual([tenantId, null]);
    expect(result).toHaveLength(1);
    expect(result[0]!.preview_seen).toBe(true);
    expect(result[0]!.view_count).toBe(2);
  });

  it("narrows to the requested leads when a lead id list is supplied", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await fetchPreviewViewStates(tenantId, [leadId], { query });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("website_previews.lead_id = ANY($2::uuid[])");
    expect(params).toEqual([tenantId, [leadId]]);
  });
});

describe("POST /internal/preview-view", () => {
  function createServer(queries: PreviewViewQueries) {
    return buildServer({
      instantlyWebhookSecrets: { reply: "r", bounced: "b", unsubbed: "u" },
      queue: createQueue(),
      previewView: { secret: previewViewSecret, tenantId, queries },
    });
  }

  it("records a view mirrored from nginx", async () => {
    const queries = createPreviewViewQueries();
    const server = createServer(queries);

    const response = await server.inject({
      method: "POST",
      url: "/internal/preview-view",
      headers: {
        "x-preview-view-secret": previewViewSecret,
        "x-preview-path": "/p/" + previewSlug + "/",
        "x-preview-method": "GET",
        "user-agent": chromeUserAgent,
      },
    });

    expect(response.statusCode).toBe(204);
    expect(queries.recordWebsitePreviewView).toHaveBeenCalledWith(tenantId, previewSlug);
  });

  // webhooks.presciaiq.com proxies every path to this process, so the route
  // is publicly reachable even though nginx only ever calls it over
  // localhost. Without the secret anyone could forge a view and make a lead
  // that never opened the email look engaged.
  it("rejects a request without the shared secret", async () => {
    const queries = createPreviewViewQueries();
    const server = createServer(queries);

    const response = await server.inject({
      method: "POST",
      url: "/internal/preview-view",
      headers: {
        "x-preview-path": "/p/" + previewSlug + "/",
        "x-preview-method": "GET",
        "user-agent": chromeUserAgent,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(queries.recordWebsitePreviewView).not.toHaveBeenCalled();
  });

  it("does not record a HEAD of a preview page", async () => {
    const queries = createPreviewViewQueries();
    const server = createServer(queries);

    const response = await server.inject({
      method: "POST",
      url: "/internal/preview-view",
      headers: {
        "x-preview-view-secret": previewViewSecret,
        "x-preview-path": "/p/" + previewSlug + "/",
        "x-preview-method": "HEAD",
        "user-agent": chromeUserAgent,
      },
    });

    expect(response.statusCode).toBe(204);
    expect(queries.recordWebsitePreviewView).not.toHaveBeenCalled();
  });

  it("still answers 204 when recording fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const queries = createPreviewViewQueries({
      recordWebsitePreviewView: vi.fn().mockRejectedValue(new Error("pool exhausted")),
    });
    const server = createServer(queries);

    const response = await server.inject({
      method: "POST",
      url: "/internal/preview-view",
      headers: {
        "x-preview-view-secret": previewViewSecret,
        "x-preview-path": "/p/" + previewSlug + "/",
        "x-preview-method": "GET",
        "user-agent": chromeUserAgent,
      },
    });

    expect(response.statusCode).toBe(204);
    warn.mockRestore();
  });

  it("is absent when the service starts without preview view configuration", async () => {
    const server = buildServer({
      instantlyWebhookSecrets: { reply: "r", bounced: "b", unsubbed: "u" },
      queue: createQueue(),
    });

    const response = await server.inject({
      method: "POST",
      url: "/internal/preview-view",
      headers: { "x-preview-view-secret": previewViewSecret },
    });

    expect(response.statusCode).toBe(404);
  });
});

/** The regression suite for the silent failure shipped in #146.
 *
 * Every test above used the slug `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6`, invented
 * to look like the UUID-derived slug that migration 0007 backfilled onto rows
 * that already existed. No preview minted since then has looked like that.
 * `generate_preview._new_preview_slug` returns `secrets.token_urlsafe(24)`,
 * which is 32 characters of base64url: mixed case, digits, `-` and `_`. All
 * 570 preview rows in production carry that shape and not one matched the
 * hex-only pattern this module parsed with, so every mirrored hit was
 * discarded before it reached the database and the endpoint answered 204 to
 * every one of them.
 *
 * These slugs are therefore taken verbatim from the generator's alphabet
 * rather than written to fit the parser, which is the only reason the suite
 * above went green while the feature recorded nothing.
 */
describe("slugs in the shape generate_preview actually mints", () => {
  // secrets.token_urlsafe(24): 32 base64url characters.
  const tokenUrlsafeSlug = "y0ubWHHzg8-iebSdGpMNwEf3PXuqsJgu";
  const underscoreSlug = "vhUmD_5VrLk6H2xvXN9tJ3VchX941SLY";
  const leadingDashSlug = "-Pu8LfonEWv19WfCRfLxeOv_1615ijs5";
  // The UUID-derived shape migration 0007 backfilled. Still live on the
  // oldest rows, so it has to keep working.
  const legacyHexSlug = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

  it("reads a base64url slug off the served path", () => {
    expect(extractPreviewSlug(`/p/${tokenUrlsafeSlug}/`)).toBe(tokenUrlsafeSlug);
    expect(extractPreviewSlug(`/p/${tokenUrlsafeSlug}`)).toBe(tokenUrlsafeSlug);
    expect(extractPreviewSlug(`/p/${underscoreSlug}/`)).toBe(underscoreSlug);
    expect(extractPreviewSlug(`/p/${leadingDashSlug}/`)).toBe(leadingDashSlug);
    expect(extractPreviewSlug(`/p/${tokenUrlsafeSlug}/index.html`)).toBe(tokenUrlsafeSlug);
    expect(extractPreviewSlug(`/p/${tokenUrlsafeSlug}/?utm_source=email`)).toBe(tokenUrlsafeSlug);
  });

  it("still reads the UUID-derived slug backfilled by migration 0007", () => {
    expect(extractPreviewSlug(`/p/${legacyHexSlug}/`)).toBe(legacyHexSlug);
  });

  // Widening the alphabet must not widen it to include the separators that
  // keep a traversal attempt or a stray asset path out of the database.
  it("still refuses a path that is not a preview page", () => {
    expect(extractPreviewSlug("/p/../../etc/passwd")).toBeNull();
    expect(extractPreviewSlug("/p/..")).toBeNull();
    expect(extractPreviewSlug("/p/")).toBeNull();
    expect(extractPreviewSlug("/p/favicon.ico")).toBeNull();
    expect(extractPreviewSlug("/assets/previews/plumbing/hero.jpg")).toBeNull();
    expect(extractPreviewSlug("/")).toBeNull();
    expect(extractPreviewSlug(undefined)).toBeNull();
  });

  it("records a view for a real preview slug loaded by a browser", async () => {
    const queries = createPreviewViewQueries();

    const outcome = await recordPreviewView(
      { path: `/p/${tokenUrlsafeSlug}/`, method: "GET", userAgent: chromeUserAgent },
      { tenantId, queries },
    );

    expect(queries.recordWebsitePreviewView).toHaveBeenCalledWith(tenantId, tokenUrlsafeSlug);
    expect(outcome).toEqual({ recorded: true, leadId });
  });

  it("records through the route nginx mirrors to", async () => {
    const queries = createPreviewViewQueries();
    const server = buildServer({
      instantlyWebhookSecrets: { reply: "r", bounced: "b", unsubbed: "u" },
      queue: createQueue(),
      previewView: { secret: previewViewSecret, tenantId, queries },
    });

    const response = await server.inject({
      method: "POST",
      url: "/internal/preview-view",
      headers: {
        "x-preview-view-secret": previewViewSecret,
        "x-preview-path": `/p/${tokenUrlsafeSlug}/`,
        "x-preview-method": "GET",
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(queries.recordWebsitePreviewView).toHaveBeenCalledWith(tenantId, tokenUrlsafeSlug);
  });
});

/** A tracking write that does not happen has to leave a trace.
 *
 * nginx mirrors only requests under /p/, so a mirrored path that yields no
 * slug is never a stray asset fetch: it is a preview page this module did not
 * recognise. That is the exact condition that hid #146 for a full campaign,
 * and in the database it is indistinguishable from a campaign that landed in
 * spam, which is the one conclusion this feature exists to rule out.
 */
describe("an unrecordable view is reported, not discarded", () => {
  it("warns when a mirrored preview path yields no slug", async () => {
    const queries = createPreviewViewQueries();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const outcome = await recordPreviewView(
      { path: "/p/slug-in-some-unrecognised-shape!", method: "GET", userAgent: chromeUserAgent },
      { tenantId, queries },
    );

    expect(outcome).toEqual({ recorded: false, reason: "not_a_preview_path" });
    expect(queries.recordWebsitePreviewView).not.toHaveBeenCalled();

    const logged = warn.mock.calls.map((call) => String(call[0])).join(" ");
    expect(logged).toContain("preview view not recorded");
    expect(logged).toContain("unparsed_preview_path");
    // Long enough to diagnose a slug format change, short of reproducing the
    // slug: it is a bearer token for one named prospect's page.
    expect(logged).toContain("segment_length=32");
    expect(logged).not.toContain("slug-in-some-unrecognised-shape");
    warn.mockRestore();
  });

  // Nothing outside /p/ reaches this route through the mirror, so a path from
  // somewhere else is a probe, not a lost view. Warning on those would bury
  // the line above in noise on the day it matters.
  it("stays quiet for a path nginx would never mirror", async () => {
    const queries = createPreviewViewQueries();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const outcome = await recordPreviewView(
      { path: "/assets/previews/plumbing/hero.jpg", method: "GET", userAgent: chromeUserAgent },
      { tenantId, queries },
    );

    expect(outcome).toEqual({ recorded: false, reason: "not_a_preview_path" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
