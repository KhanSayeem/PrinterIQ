import { describe, expect, it, vi } from "vitest";

import {
  UNCLASSIFIED_ESCALATION_REASON,
  escalateUnprocessedReply,
} from "../src/worker.js";
import type { ProcessReplyJob } from "../src/types.js";

const job: ProcessReplyJob = {
  job_type: "process_reply",
  tenant_id: "tenant-1",
  lead_id: "lead-1",
  channel: "email",
  direction: "inbound",
  body: "Thanks, not right now.",
  raw_webhook: {},
  instantly_email_id: "email-1",
  instantly_account_id: "alex@example.com",
};

function fakes() {
  return {
    queries: {
      insertInboundConversation: vi.fn().mockResolvedValue({ id: "conversation-1" }),
      markConversationEscalated: vi.fn().mockResolvedValue({ body: job.body }),
    },
    escalate: vi.fn().mockResolvedValue(undefined),
    logger: { warn: vi.fn() },
  };
}

/**
 * Production on 2026-09-17: a reply from Beyond Training failed
 * classification three times, BullMQ gave up, and nothing told the operator.
 * The reply sat for five days. A reply that cannot be processed must reach a
 * human, not a log line.
 */
describe("escalateUnprocessedReply", () => {
  it("finds the reply's conversation, marks it escalated and tells the operator", async () => {
    const deps = fakes();

    await escalateUnprocessedReply(job, deps);

    expect(deps.queries.markConversationEscalated).toHaveBeenCalledWith(
      "tenant-1",
      "conversation-1",
      UNCLASSIFIED_ESCALATION_REASON,
    );
    expect(deps.escalate).toHaveBeenCalledWith({
      tenant_id: "tenant-1",
      lead_id: "lead-1",
      conversation_id: "conversation-1",
      reason: UNCLASSIFIED_ESCALATION_REASON,
      inbound_body: job.body,
    });
  });

  it("uses the same dedupe key as the handler, so it finds the row rather than adding one", async () => {
    const deps = fakes();

    await escalateUnprocessedReply(job, deps);

    const metadata = deps.queries.insertInboundConversation.mock.calls[0]![4] as { dedupe_key: string };
    expect(metadata.dedupe_key).toBe("reply:email:email-1");
  });

  it("never throws, because it runs inside the worker's failure handler", async () => {
    const deps = fakes();
    deps.escalate.mockRejectedValue(new Error("Twilio is down"));

    await expect(escalateUnprocessedReply(job, deps)).resolves.toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("logs no reply text when it fails", async () => {
    const deps = fakes();
    deps.escalate.mockRejectedValue(new Error(`failed for ${job.body}`));

    await escalateUnprocessedReply(job, deps);

    const logged = deps.logger.warn.mock.calls.map((call) => String(call[0])).join(" ");
    expect(logged).not.toContain("not right now");
  });
});
