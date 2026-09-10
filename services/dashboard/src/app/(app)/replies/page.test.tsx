import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getDashboardTenantIdMock,
  getReplyInboxPageMock,
  getReplyInboxFilterCountsMock,
  getReplyIngestSignalMock,
  replyInboxMock,
} = vi.hoisted(() => ({
  getDashboardTenantIdMock: vi.fn(),
  getReplyInboxPageMock: vi.fn(),
  getReplyInboxFilterCountsMock: vi.fn(),
  getReplyIngestSignalMock: vi.fn(),
  replyInboxMock: vi.fn(() => null),
}));

vi.mock("@/auth/tenant", () => ({
  getDashboardTenantId: getDashboardTenantIdMock,
}));

vi.mock("@/db/queries", () => ({
  getReplyInboxPage: getReplyInboxPageMock,
  getReplyInboxFilterCounts: getReplyInboxFilterCountsMock,
  getReplyIngestSignal: getReplyIngestSignalMock,
}));

vi.mock("@/components/ReplyInbox", () => ({
  ReplyInbox: replyInboxMock,
}));

import RepliesPage from "./page";

const tenantId = "10000000-0000-0000-0000-000000000001";

const counts = {
  all: 3,
  needs_attention: 2,
  interested: 1,
  question: 0,
  objection: 0,
  not_interested: 1,
  unsubscribe: 0,
  abusive: 0,
};

describe("RepliesPage", () => {
  beforeEach(() => {
    getDashboardTenantIdMock.mockReset();
    getReplyInboxPageMock.mockReset();
    getReplyInboxFilterCountsMock.mockReset();
    getReplyIngestSignalMock.mockReset();
    replyInboxMock.mockClear();

    getReplyIngestSignalMock.mockResolvedValue({ lastInboundAt: null, firstHandoffAt: null });
    getDashboardTenantIdMock.mockReturnValue(tenantId);
    getReplyInboxFilterCountsMock.mockResolvedValue(counts);
    getReplyInboxPageMock.mockResolvedValue({
      rows: [],
      total: 0,
      page: 1,
      totalPages: 1,
      pageSize: 25,
    });
  });

  it("defaults to the replies that need a human", async () => {
    await RepliesPage({ searchParams: Promise.resolve({}) });

    expect(getReplyInboxPageMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, filter: "needs_attention", page: 1, pageSize: 25 }),
    );
  });

  it("passes the requested filter and page into the query", async () => {
    await RepliesPage({ searchParams: Promise.resolve({ filter: "interested", page: "2" }) });

    expect(getReplyInboxPageMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, filter: "interested", page: 2 }),
    );
  });

  it("hands the loaded page straight to the inbox view", async () => {
    getReplyInboxPageMock.mockResolvedValue({
      rows: [{ id: "conv-1" }],
      total: 1,
      page: 1,
      totalPages: 1,
      pageSize: 25,
    });

    render(await RepliesPage({ searchParams: Promise.resolve({ filter: "all" }) }));

    expect(replyInboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ id: "conv-1" }],
        counts,
        filter: "all",
        page: 1,
        totalPages: 1,
        total: 1,
      }),
      undefined,
    );
  });

  it("hands the inbox a health line derived from the last inbound write", async () => {
    getReplyIngestSignalMock.mockResolvedValue({
      lastInboundAt: new Date("2026-08-20T00:00:00.000Z"),
      firstHandoffAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    render(await RepliesPage({ searchParams: Promise.resolve({ filter: "all" }) }));

    expect(getReplyIngestSignalMock).toHaveBeenCalledWith({ tenantId });
    const props = (replyInboxMock.mock.calls[0] as unknown[])[0] as { ingestHealth: { message: string } | null };
    expect(props.ingestHealth?.message).toContain("No inbound reply has been recorded since 20 Aug 2026");
  });

  it("passes no health line at all when the health signal cannot be read", async () => {
    getReplyIngestSignalMock.mockRejectedValue(new Error("connection refused"));

    render(await RepliesPage({ searchParams: Promise.resolve({ filter: "all" }) }));

    const props = (replyInboxMock.mock.calls[0] as unknown[])[0] as { ingestHealth: unknown };
    expect(props.ingestHealth).toBeNull();
  });

  it("does not tell the operator that inbound replies are delivered by Instantly", async () => {
    const { container } = render(await RepliesPage({ searchParams: Promise.resolve({ filter: "all" }) }));

    expect(container.textContent).not.toContain("delivered by Instantly");
    expect(container.textContent).toContain("recorded by the reply agent webhook");
  });

  it("reports a missing tenant instead of rendering an empty inbox", async () => {
    getDashboardTenantIdMock.mockReturnValue(undefined);

    const { container } = render(await RepliesPage({ searchParams: Promise.resolve({}) }));

    expect(replyInboxMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Failed to load replies");
  });
});
