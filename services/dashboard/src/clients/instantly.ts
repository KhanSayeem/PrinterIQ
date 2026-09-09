const INSTANTLY_BASE_URL = "https://api.instantly.ai";

type FetchFn = typeof fetch;

type InstantlyClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: FetchFn;
  pausedListId?: string;
};

export type InstantlyReplyInput = {
  instantlyEmailId: string;
  instantlyAccountId: string;
  subject?: string | null;
  body: string;
};

export type InstantlySendingAccount = {
  email: string;
  dailyLimit: number | null;
  status: number | null;
};

type InstantlyAccountsPage = {
  items?: unknown;
  next_starting_after?: unknown;
};

const ACCOUNTS_PATH = "/api/v2/accounts";
const ACCOUNTS_PAGE_SIZE = 100;
// Instantly's page size ceiling is 100. The estate is single digit mailboxes, so
// this only exists to stop a malformed cursor turning into an unbounded loop.
const MAX_ACCOUNT_PAGES = 20;

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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
   * Every sending account on the workspace, with its current daily sending limit.
   *
   * Instantly v2 exposes this as `GET /api/v2/accounts`, returning
   * `{ items, next_starting_after }` where each item carries `email` and
   * `daily_limit`. A failed page throws rather than returning what was collected
   * so far, because a short list read as the whole estate would understate the
   * campaign total.
   */
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

  /**
   * Set one sending account's daily sending limit.
   *
   * Instantly v2 exposes this as `PATCH /api/v2/accounts/{email}` with a partial
   * account body; `daily_limit` is a documented optional field on it.
   */
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
    errorPathLabel: string = path,
  ): Promise<void> {
    await this.send(path, init, errorPathLabel);
  }

  private async requestJson<T>(
    path: string,
    init: Pick<RequestInit, "method" | "body">,
    errorPathLabel: string = path,
  ): Promise<T> {
    const response = await this.send(path, init, errorPathLabel);
    return (await response.json()) as T;
  }

  private async send(
    path: string,
    init: Pick<RequestInit, "method" | "body">,
    errorPathLabel: string,
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
      body: init.body,
    });

    if (!response.ok) {
      throw new Error(
        `Instantly API ${init.method} ${errorPathLabel} failed with ${response.status}; response body omitted`,
      );
    }

    return response;
  }
}
