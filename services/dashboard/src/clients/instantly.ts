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

/** The list endpoint caps `limit` at 100, so paging is bounded rather than open ended. */
const ACCOUNTS_PAGE_SIZE = 100;
const MAX_ACCOUNT_PAGES = 20;
/** GET /api/v2/accounts/analytics/daily accepts at most 200 unique accounts. */
const MAX_ANALYTICS_EMAILS = 200;

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
