import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReplyInbox } from "./ReplyInbox";
import type { ReplyInboxFilterCounts, ReplyInboxRow } from "@/db/queries";

const now = new Date("2026-09-09T12:00:00.000Z");

const emptyCounts: ReplyInboxFilterCounts = {
  all: 0,
  needs_attention: 0,
  interested: 0,
  question: 0,
  objection: 0,
  not_interested: 0,
  unsubscribe: 0,
  abusive: 0,
};

function reply(overrides: Partial<ReplyInboxRow> = {}): ReplyInboxRow {
  return {
    id: "conv-1",
    leadId: "lead-1",
    body: "Sounds good, send me the link",
    channel: "email",
    intent: "interested",
    intentConfidence: 92,
    agentAction: "send_checkout",
    escalated: false,
    escalationReason: null,
    createdAt: new Date("2026-09-09T10:00:00.000Z"),
    firstName: "Jo",
    lastName: "Nguyen",
    businessName: "Nguyen Plumbing",
    email: "jo@nguyenplumbing.com.au",
    ...overrides,
  };
}

function renderInbox(props: Partial<Parameters<typeof ReplyInbox>[0]> = {}) {
  return render(
    <ReplyInbox
      replies={[reply()]}
      counts={{ ...emptyCounts, all: 1, needs_attention: 1, interested: 1 }}
      filter="all"
      page={1}
      totalPages={1}
      total={1}
      now={now}
      {...props}
    />,
  );
}

describe("ReplyInbox", () => {
  it("shows who replied, when, and what they said", () => {
    renderInbox();

    expect(screen.getByText("Jo Nguyen")).toBeInTheDocument();
    expect(screen.getByText("Nguyen Plumbing")).toBeInTheDocument();
    expect(screen.getByText("jo@nguyenplumbing.com.au")).toBeInTheDocument();
    expect(screen.getByText("Sounds good, send me the link")).toBeInTheDocument();
    expect(screen.getByText("2 hours ago")).toBeInTheDocument();
  });

  it("falls back to the email address when the lead has no name", () => {
    renderInbox({ replies: [reply({ firstName: null, lastName: null, businessName: null })] });

    expect(screen.getByRole("link", { name: "Open jo@nguyenplumbing.com.au in leads" })).toBeInTheDocument();
    expect(screen.getByText("Unknown business")).toBeInTheDocument();
  });

  it("links each reply through to that lead's detail view", () => {
    renderInbox();

    expect(screen.getByRole("link", { name: "Open Jo Nguyen in leads" })).toHaveAttribute(
      "href",
      "/leads/lead-1",
    );
  });

  it("shows the classification the reply agent already assigned", () => {
    renderInbox({
      replies: [
        reply({ id: "a", leadId: "lead-a", intent: "not_interested" }),
        reply({ id: "b", leadId: "lead-b", intent: "unsubscribe" }),
      ],
    });

    const list = screen.getByRole("list", { name: "Inbound replies" });
    expect(within(list).getByText("Not interested")).toBeInTheDocument();
    expect(within(list).getByText("Unsubscribe request")).toBeInTheDocument();
  });

  it("marks a reply the agent has not classified rather than guessing one", () => {
    renderInbox({ replies: [reply({ intent: null, intentConfidence: null, agentAction: null })] });

    const list = screen.getByRole("list", { name: "Inbound replies" });
    expect(within(list).getByText("Unclassified")).toBeInTheDocument();
    expect(within(list).queryByText("Interested")).not.toBeInTheDocument();
  });

  it("flags an escalated reply", () => {
    renderInbox({ replies: [reply({ escalated: true, escalationReason: "hardcoded_escalation_phrase" })] });

    expect(screen.getByText("Escalated")).toBeInTheDocument();
  });

  it("renders replies in the order given, newest first", () => {
    renderInbox({
      replies: [
        reply({ id: "c3", leadId: "lead-3", body: "third", createdAt: new Date("2026-09-09T11:00:00.000Z") }),
        reply({ id: "c2", leadId: "lead-2", body: "second", createdAt: new Date("2026-09-09T10:00:00.000Z") }),
        reply({ id: "c1", leadId: "lead-1", body: "first", createdAt: new Date("2026-09-09T09:00:00.000Z") }),
      ],
    });

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText("third")).toBeInTheDocument();
    expect(within(items[1]).getByText("second")).toBeInTheDocument();
    expect(within(items[2]).getByText("first")).toBeInTheDocument();
  });

  it("explains an empty inbox as normal before launch", () => {
    renderInbox({ replies: [], counts: emptyCounts, total: 0 });

    expect(screen.getByText(/No replies yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("distinguishes an empty filter from an empty inbox", () => {
    renderInbox({
      replies: [],
      counts: { ...emptyCounts, all: 4, not_interested: 4 },
      filter: "interested",
      total: 0,
    });

    expect(screen.getByText(/No replies match this filter/i)).toBeInTheDocument();
    expect(screen.queryByText(/No replies yet/i)).not.toBeInTheDocument();
  });

  it("offers the needs-a-human filter and marks the active one", () => {
    renderInbox({ filter: "needs_attention" });

    const needsHuman = screen.getByRole("link", { name: /Needs a human/i });
    expect(needsHuman).toHaveAttribute("href", "/replies?filter=needs_attention");
    expect(needsHuman).toHaveClass("active");
    expect(screen.getByRole("link", { name: /^All/i })).not.toHaveClass("active");
  });

  it("shows the tally beside each filter", () => {
    renderInbox({
      counts: { ...emptyCounts, all: 9, needs_attention: 4, interested: 2 },
      filter: "all",
    });

    const needsHuman = screen.getByRole("link", { name: /Needs a human/i });
    expect(within(needsHuman).getByText("4")).toBeInTheDocument();
  });

  it("pages through older replies while keeping the active filter", () => {
    renderInbox({ filter: "interested", page: 3, totalPages: 5, total: 120 });

    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute(
      "href",
      "/replies?filter=interested&page=2",
    );
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      "/replies?filter=interested&page=4",
    );
  });

  it("drops the page parameter when stepping back to the first page", () => {
    renderInbox({ filter: "interested", page: 2, totalPages: 3, total: 60 });

    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute(
      "href",
      "/replies?filter=interested",
    );
  });

  it("hides pagination when everything fits on one page", () => {
    renderInbox({ page: 1, totalPages: 1, total: 1 });

    expect(screen.queryByRole("link", { name: "Next" })).not.toBeInTheDocument();
  });

  it("does not offer a way to send a reply from the dashboard", () => {
    renderInbox();

    expect(screen.queryByRole("button", { name: /reply/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
