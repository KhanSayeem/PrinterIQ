const INSTANTLY_BASE_URL = "https://api.instantly.ai";

type FetchFn = typeof fetch;

type InstantlyClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: FetchFn;
  pausedListId?: string;
};

export type InstantlyCampaign = {
  id: string;
  name: string;
  status: number;
};

/**
 * Lifetime totals for one campaign, from GET /api/v2/campaigns/analytics
 * called without a date range.
 */
export type InstantlyCampaignTotals = {
  campaignId: string;
  /** Every email the campaign has sent, follow ups included. */
  emailsSent: number;
  bounced: number;
  /** Distinct leads the campaign has emailed at least once. */
  contacted: number;
};

const CAMPAIGN_ANALYTICS_PATH = "/api/v2/campaigns/analytics";

/** A count this figure depends on is thrown when absent, never read as zero. */
function requiredCampaignCount(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Instantly API GET ${CAMPAIGN_ANALYTICS_PATH} returned a campaign row with no ${field}`);
  }
  return value;
}

export type InstantlyReplyInput = {
  instantlyEmailId: string;
  instantlyAccountId: string;
  subject?: string | null;
  body: string;
};

/**
 * Field names and enum values below are taken from the Instantly v2 OpenAPI
 * document at https://api.instantly.ai/openapi/api_v2.json, schema
 * `components.schemas.Account`. Only the fields the deliverability panel reads
 * are declared. Nullable fields are nullable in the spec, so a `null` here is a
 * genuinely absent value and must not be rendered as a zero.
 */
type InstantlyAccountsPage = {
  items?: unknown;
  next_starting_after?: unknown;
};

const ACCOUNTS_PATH = "/api/v2/accounts";

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type InstantlySendingAccount = {
  email: string;
  dailyLimit: number | null;
  status: number | null;
};

function toSendingAccount(raw: unknown): InstantlySendingAccount | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.email !== "string" || record.email.trim() === "") {
    return null;
  }
  return {
    email: record.email,
    dailyLimit: toNullableNumber(record.daily_limit),
    status: toNullableNumber(record.status),
  };
}

export type InstantlyAccount = {
  /** Mailbox address. Required in the spec. */
  email: string;
  timestamp_created: string;
  /** 0 Paused, 1 Active, -1 Banned, -2 Spam Folder Unknown, -3 Permanent Suspension. */
  warmup_status: number;
  /** 1 Active, 2 Paused, 3 Temporarily paused, -1 Connection Error, -2 Soft Bounce Error, -3 Sending Error. */
  status?: number;
  /** Daily sending limit. Nullable in the spec. */
  daily_limit?: number | null;
  /** Warmup score. Nullable and read only in the spec. No range is declared. */
  stat_warmup_score?: number | null;
  setup_pending?: boolean;
};

/**
 * One row of GET /api/v2/accounts/analytics/daily. The account object carries no
 * send count and no bounce count, so this endpoint is the only source for both.
 */
export type InstantlyDailyAccountAnalytics = {
  /** YYYY-MM-DD. */
  date: string;
  email_account: string;
  sent: number;
  bounced: number;
};

export type InstantlyDailyAnalyticsQuery = {
  emails: string[];
  startDate: string;
  endDate: string;
};

/**
 * One sent email, narrowed to the two fields a per day send count needs.
 *
 * GET /api/v2/emails is the only Instantly endpoint that publishes a per email
 * instant. `timestamp_created` is when Instantly recorded the email, `Z`
 * suffixed UTC in the spec, and it is the field the endpoint's own
 * `min_timestamp_created` and `max_timestamp_created` filters act on. The
 * sibling `timestamp_email` field is the header date and the spec warns it "is
 * not always accurate, as it can be manipulated by the sender or the email
 * server", so it is not read here. Filtering and counting on the same field
 * means no row can be admitted by one and rejected by the other.
 */
export type InstantlySentEmail = {
  readonly sentAt: Date;
  /** The mailbox the email went out from. */
  readonly eaccount: string;
};

export type InstantlySentEmailsQuery = {
  /** Mailboxes to ask about. Empty means no request and no rows. */
  readonly emails: readonly string[];
  /** Lower bound of the window of interest, as a UTC instant. */
  readonly createdAtOrAfter: Date;
  /** Upper bound of the window of interest, as a UTC instant. */
  readonly createdBefore: Date;
};

export type InstantlySentEmailsResult = {
  readonly emails: readonly InstantlySentEmail[];
  /**
   * False when the page cap stopped the walk while Instantly still had rows.
   * A caller counting sends has to report the count as unavailable in that
   * case: a short count published as a day total is the exact failure this
   * endpoint was reached for in the first place.
   */
  readonly complete: boolean;
};

/** The list endpoint caps `limit` at 100, so paging is bounded rather than open ended. */
const ACCOUNTS_PAGE_SIZE = 100;
const MAX_ACCOUNT_PAGES = 20;
/** GET /api/v2/accounts/analytics/daily accepts at most 200 unique accounts. */
const MAX_ANALYTICS_EMAILS = 200;

const EMAILS_PATH = "/api/v2/emails";
/** GET /api/v2/emails caps `limit` at 100 in the spec. */
const EMAILS_PAGE_SIZE = 100;
/**
 * 10 pages is 1,000 sent emails in one window. The endpoint carries its own
 * rate limit of 20 requests per minute, lower than the rest of the API, and
 * this walk runs on a page render, so the cap keeps one render well inside it.
 * Hitting the cap is reported rather than swallowed.
 */
const MAX_EMAIL_PAGES = 10;
/**
 * The spec describes `min_timestamp_created` as "after this timestamp" and
 * `max_timestamp_created` as "before this timestamp" without saying whether
 * either end is inclusive. Widening both ends by a second demotes the server
 * side filter to a payload reduction: which day a row belongs to is then
 * decided only by the caller comparing the instants it gets back.
 */
const EMAILS_WINDOW_SLACK_MS = 1000;

/**
 * Throws rather than returning null. `toSendingAccount` above may skip a row it
 * cannot read because the deliverability panel lists whatever it can; a send
 * count may not, because a skipped row silently shortens a figure the today bar
 * presents as exact. The values themselves are kept out of the messages so a
 * failure can be logged without putting a mailbox address in the logs.
 */
function toSentEmail(raw: unknown): InstantlySentEmail {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Instantly API GET ${EMAILS_PATH} returned a row that is not an object`);
  }

  const record = raw as Record<string, unknown>;
  if (typeof record.timestamp_created !== "string") {
    throw new Error(`Instantly API GET ${EMAILS_PATH} returned a row with no timestamp_created`);
  }

  const sentAt = new Date(record.timestamp_created);
  if (Number.isNaN(sentAt.getTime())) {
    throw new Error(
      `Instantly API GET ${EMAILS_PATH} returned a row whose timestamp_created could not be parsed`,
    );
  }

  if (typeof record.eaccount !== "string" || record.eaccount.trim() === "") {
    throw new Error(`Instantly API GET ${EMAILS_PATH} returned a row with no eaccount`);
  }

  return { sentAt, eaccount: record.eaccount };
}

export class InstantlyHttpClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly pausedListId?: string;

  constructor(options: InstantlyClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.INSTANTLY_API_KEY;
    this.baseUrl = (options.baseUrl ?? INSTANTLY_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.pausedListId = options.pausedListId ?? process.env.INSTANTLY_PAUSED_LIST_ID;
  }

  async pauseLead(instantlyLeadId: string, instantlyCampaignId: string): Promise<void> {
    if (!this.pausedListId) {
      throw new Error("Missing env var: INSTANTLY_PAUSED_LIST_ID");
    }
    await this.request("/api/v2/leads/move", {
      method: "POST",
      body: JSON.stringify({
        ids: [instantlyLeadId],
        campaign: instantlyCampaignId,
        to_list_id: this.pausedListId,
      }),
    });
  }

  async getCampaign(instantlyCampaignId: string): Promise<InstantlyCampaign> {
    const path = `/api/v2/campaigns/${instantlyCampaignId}`;
    const body = await this.requestJson<unknown>(path, { method: "GET" });

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error(`Instantly API GET ${path} returned a non-object response`);
    }

    const campaign = body as Record<string, unknown>;
    return {
      id: typeof campaign.id === "string" ? campaign.id : instantlyCampaignId,
      name: typeof campaign.name === "string" ? campaign.name : "",
      status: typeof campaign.status === "number" ? campaign.status : Number.NaN,
    };
  }

  /**
   * Lifetime totals for the given campaigns, in the order Instantly returns them.
   *
   * The endpoint ignores its own campaign_id filter. Measured on 2026-09-14:
   * two requested ids came back as three rows, the dev preview smoke campaign
   * included, and an id that does not exist came back as every campaign in the
   * workspace. So the rows are filtered here. Only requested rows are checked: a
   * malformed row for another campaign is not this figure's problem, but a
   * missing count on a requested one is thrown rather than read as zero.
   */
  async getCampaignTotals(campaignIds: readonly string[]): Promise<InstantlyCampaignTotals[]> {
    const query = campaignIds.map((id) => `campaign_id=${encodeURIComponent(id)}`).join("&");
    const body = await this.requestJson<unknown>(
      `${CAMPAIGN_ANALYTICS_PATH}?${query}`,
      { method: "GET" },
      CAMPAIGN_ANALYTICS_PATH,
    );

    if (!Array.isArray(body)) {
      throw new Error(`Instantly API GET ${CAMPAIGN_ANALYTICS_PATH} returned a response that is not a list`);
    }

    const wanted = new Set(campaignIds);
    const totals: InstantlyCampaignTotals[] = [];
    for (const raw of body) {
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const record = raw as Record<string, unknown>;
      if (typeof record.campaign_id !== "string" || !wanted.has(record.campaign_id)) {
        continue;
      }
      totals.push({
        campaignId: record.campaign_id,
        emailsSent: requiredCampaignCount(record, "emails_sent_count"),
        bounced: requiredCampaignCount(record, "bounced_count"),
        contacted: requiredCampaignCount(record, "contacted_count"),
      });
    }
    return totals;
  }

  async pauseCampaign(instantlyCampaignId: string): Promise<void> {
    await this.request(`/api/v2/campaigns/${instantlyCampaignId}/pause`, { method: "POST" });
  }

  async activateCampaign(instantlyCampaignId: string): Promise<void> {
    await this.request(`/api/v2/campaigns/${instantlyCampaignId}/activate`, { method: "POST" });
  }

  async sendReply(input: InstantlyReplyInput): Promise<void> {
    const payload: {
      eaccount: string;
      reply_to_uuid: string;
      subject?: string;
      body: { text: string };
    } = {
      eaccount: input.instantlyAccountId,
      reply_to_uuid: input.instantlyEmailId,
      body: { text: input.body },
    };

    if (input.subject?.trim()) {
      payload.subject = input.subject.trim();
    }

    await this.request("/api/v2/emails/reply", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /**
   * Read only. Lists the sending accounts in the workspace so the operator can
   * see mailbox health. Never mutates warmup, campaigns or account state.
   */
  async listAccounts(): Promise<InstantlyAccount[]> {
    const accounts: InstantlyAccount[] = [];
    let startingAfter: string | undefined;

    for (let page = 0; page < MAX_ACCOUNT_PAGES; page += 1) {
      const params = new URLSearchParams({ limit: String(ACCOUNTS_PAGE_SIZE) });
      if (startingAfter) {
        params.set("starting_after", startingAfter);
      }

      const body = await this.requestJson<{
        items?: InstantlyAccount[];
        next_starting_after?: string | null;
      }>(`/api/v2/accounts?${params.toString()}`, { method: "GET" });

      accounts.push(...(body.items ?? []));

      if (!body.next_starting_after || !body.items?.length) {
        return accounts;
      }
      startingAfter = body.next_starting_after;
    }

    return accounts;
  }

  /**
   * Read only. Per account, per day sends and bounces. `emails` is a required
   * filter on this endpoint and the date range may not exceed 31 days.
   */
  async getDailyAccountAnalytics(
    query: InstantlyDailyAnalyticsQuery,
  ): Promise<InstantlyDailyAccountAnalytics[]> {
    if (!query.emails.length) {
      return [];
    }

    const params = new URLSearchParams({
      start_date: query.startDate,
      end_date: query.endDate,
    });
    for (const email of query.emails.slice(0, MAX_ANALYTICS_EMAILS)) {
      params.append("emails", email);
    }

    const body = await this.requestJson<InstantlyDailyAccountAnalytics[]>(
      `/api/v2/accounts/analytics/daily?${params.toString()}`,
      { method: "GET" },
    );

    return Array.isArray(body) ? body : [];
  }

  /**
   * Read only. Every campaign email these mailboxes sent in the window, one row
   * per email, each carrying the UTC instant Instantly recorded it at.
   *
   * `eaccount` takes a comma separated list per the spec, but the caller is
   * still expected to check each returned row against its own mailbox list: the
   * workspace is shared with other projects, and a filter that silently stopped
   * working would otherwise inflate a PrinterIQ figure with another project's
   * sends.
   */
  async listSentEmails(query: InstantlySentEmailsQuery): Promise<InstantlySentEmailsResult> {
    if (!query.emails.length) {
      return { emails: [], complete: true };
    }

    const sent: InstantlySentEmail[] = [];
    let startingAfter: string | undefined;

    for (let page = 0; page < MAX_EMAIL_PAGES; page += 1) {
      const params = new URLSearchParams({
        limit: String(EMAILS_PAGE_SIZE),
        email_type: "sent",
        eaccount: query.emails.join(","),
        min_timestamp_created: new Date(
          query.createdAtOrAfter.getTime() - EMAILS_WINDOW_SLACK_MS,
        ).toISOString(),
        max_timestamp_created: new Date(
          query.createdBefore.getTime() + EMAILS_WINDOW_SLACK_MS,
        ).toISOString(),
      });
      if (startingAfter) {
        params.set("starting_after", startingAfter);
      }

      // The query string carries every mailbox address, so the error text names
      // the endpoint on its own.
      const body = await this.requestJson<{ items?: unknown; next_starting_after?: unknown }>(
        `${EMAILS_PATH}?${params.toString()}`,
        { method: "GET" },
        EMAILS_PATH,
      );

      const items = Array.isArray(body.items) ? body.items : [];
      for (const item of items) {
        sent.push(toSentEmail(item));
      }

      const cursor = body.next_starting_after;
      if (typeof cursor !== "string" || cursor === "" || items.length === 0) {
        return { emails: sent, complete: true };
      }
      startingAfter = cursor;
    }

    return { emails: sent, complete: false };
  }

  async listSendingAccounts(): Promise<InstantlySendingAccount[]> {
    const accounts: InstantlySendingAccount[] = [];
    let startingAfter: string | undefined;

    for (let page = 0; page < MAX_ACCOUNT_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(ACCOUNTS_PAGE_SIZE) });
      if (startingAfter) {
        query.set("starting_after", startingAfter);
      }

      const payload = await this.requestJson<InstantlyAccountsPage>(
        `${ACCOUNTS_PATH}?${query.toString()}`,
        { method: "GET" },
        ACCOUNTS_PATH,
      );

      const items = Array.isArray(payload.items) ? payload.items : [];
      for (const item of items) {
        const account = toSendingAccount(item);
        if (account) {
          accounts.push(account);
        }
      }

      const cursor = payload.next_starting_after;
      if (typeof cursor !== "string" || cursor === "" || items.length === 0) {
        return accounts;
      }
      startingAfter = cursor;
    }

    return accounts;
  }

  async updateAccountDailyLimit(email: string, dailyLimit: number): Promise<void> {
    await this.request(
      `${ACCOUNTS_PATH}/${encodeURIComponent(email)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ daily_limit: dailyLimit }),
      },
      // The mailbox address is kept out of the error text so a failure can be
      // logged without leaking an address into the logs.
      `${ACCOUNTS_PATH}/{email}`,
    );
  }

  private async request(
    path: string,
    init: Pick<RequestInit, "method" | "body">,
    logPath?: string,
  ): Promise<void> {
    await this.send(path, init, logPath);
  }

  private async requestJson<T>(
    path: string,
    init: Pick<RequestInit, "method" | "body">,
    logPath?: string,
  ): Promise<T> {
    const response = await this.send(path, init, logPath);
    return (await response.json()) as T;
  }

  /** `logPath` names the endpoint in the error without the real URL. A PATCH
   * to an account carries the mailbox address in its path, and a failure
   * should be loggable without putting an address in the logs.
   */
  private async send(
    path: string,
    init: Pick<RequestInit, "method" | "body">,
    logPath?: string,
  ): Promise<Response> {
    if (!this.apiKey) {
      throw new Error("Missing env var: INSTANTLY_API_KEY");
    }

    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });

    if (!response.ok) {
      throw new Error(`Instantly API ${init.method} ${logPath ?? path} failed with ${response.status}; response body omitted`);
    }

    return response;
  }
}
