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

  private async request(path: string, init: Pick<RequestInit, "method" | "body">): Promise<void> {
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
      throw new Error(`Instantly API ${init.method} ${path} failed with ${response.status}; response body omitted`);
    }
  }
}
