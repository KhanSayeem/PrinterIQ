import { describe, expect, it, vi } from "vitest";
import { processReplyJob, shouldStartReplyWorker, type ReplyWorkerDeps } from "../src/worker.js";
import { REPLIES_QUEUE_NAME, REPLY_JOB_OPTIONS } from "../src/queue.js";
import type { ProcessReplyJob, SendReplyJob } from "../src/types.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const leadId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";

function processJob(overrides: Partial<ProcessReplyJob> = {}): ProcessReplyJob {
  return {
    job_type: "process_reply",
    tenant_id: tenantId,
    lead_id: leadId,
    channel: "email",
    direction: "inbound",
    body: "Sounds good, send it through",
    raw_webhook: { event_type: "reply_received" },
    instantly_lead_id: "instantly-lead-123",
    instantly_email_id: "instantly-email-456",
    instantly_account_id: "sender@presciaiq.com",
    ...overrides,
  };
}

function sendJob(overrides: Partial<SendReplyJob> = {}): SendReplyJob {
  return {
    job_type: "send_reply",
    tenant_id: tenantId,
    lead_id: leadId,
    conversation_id: conversationId,
    channel: "email",
    action: "reply",
    body: "Happy to answer that.",
    instantly_lead_id: null,
    stripe_session_url: null,
    ...overrides,
  };
}

function createDeps(overrides: Partial<ReplyWorkerDeps> = {}): ReplyWorkerDeps {
  return {
    handleProcessReply: vi.fn().mockResolvedValue({ action: "reply", conversation_id: conversationId }),
    handleSendReply: vi.fn().mockResolvedValue({ action: "noop", conversation_id: conversationId }),
    escalate: vi.fn().mockResolvedValue(undefined),
    queries: {
      markConversationEscalated: vi.fn().mockResolvedValue({ body: "Yep send me the link" }),
    },
    queue: { add: vi.fn().mockResolvedValue(undefined) },
    logger: { warn: vi.fn() },
    ...overrides,
  };
}

describe("replies worker dispatch", () => {
  it("routes a process_reply job to handleProcessReply and returns its result", async () => {
    const deps = createDeps();
    const job = processJob();

    const result = await processReplyJob({ data: job }, deps);

    expect(deps.handleProcessReply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.handleProcessReply!).mock.calls[0]![0]).toEqual(job);
    expect(result).toEqual({ action: "reply", conversation_id: conversationId });
    expect(deps.handleSendReply).not.toHaveBeenCalled();
  });

  it("hands handleProcessReply the replies queue so follow-up send_reply jobs are enqueued", async () => {
    const deps = createDeps();

    await processReplyJob({ data: processJob() }, deps);

    const handlerDeps = vi.mocked(deps.handleProcessReply!).mock.calls[0]![1];
    expect(handlerDeps?.queue).toBe(deps.queue);
  });

  it("routes a send_reply job to handleSendReply", async () => {
    const deps = createDeps();
    const job = sendJob();

    const result = await processReplyJob({ data: job }, deps);

    expect(deps.handleSendReply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.handleSendReply!).mock.calls[0]![0]).toEqual(job);
    expect(result).toEqual({ action: "noop", conversation_id: conversationId });
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  // A drained queue must not be mistaken for a working reply loop. Automated
  // delivery is deliberately not built yet, so a completed reply job means the
  // draft went nowhere, and the logs have to say so.
  it("says plainly that a reply job delivered nothing", async () => {
    const deps = createDeps();

    await processReplyJob({ data: sendJob({ action: "reply" }) }, deps);

    expect(deps.logger!.warn).toHaveBeenCalledTimes(1);
    const line = String(vi.mocked(deps.logger!.warn).mock.calls[0]![0]);
    expect(line).toContain("not delivered");
    expect(line).toContain(conversationId);
  });

  it("keeps the reply body out of the log line", async () => {
    const deps = createDeps();

    await processReplyJob(
      { data: sendJob({ action: "reply", body: "Hi Brett, email me at brett@stonebuilders.com.au" }) },
      deps,
    );

    const line = String(vi.mocked(deps.logger!.warn).mock.calls[0]![0]);
    expect(line).not.toContain("brett@stonebuilders.com.au");
    expect(line).not.toContain("Brett");
  });

  it("does not claim a send_checkout job went undelivered, since a human was paged", async () => {
    const deps = createDeps();

    await processReplyJob({ data: sendJob({ action: "send_checkout" }) }, deps);

    expect(deps.logger!.warn).not.toHaveBeenCalled();
  });

  // The operator's decision: a misclassified reply that auto-sends a payment
  // request is far worse than a checkout link sent late by hand. The classifier
  // has never run in production, so send_checkout goes to a human.
  it("escalates a send_checkout job to the operator instead of creating a checkout session", async () => {
    const deps = createDeps();

    const result = await processReplyJob({ data: sendJob({ action: "send_checkout" }) }, deps);

    expect(deps.handleSendReply).not.toHaveBeenCalled();
    expect(deps.escalate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.escalate!).mock.calls[0]![0]).toEqual({
      tenant_id: tenantId,
      lead_id: leadId,
      conversation_id: conversationId,
      reason: "send_checkout_requires_operator",
      inbound_body: "Yep send me the link",
    });
    expect(result).toEqual({ action: "escalate", conversation_id: conversationId });
  });

  it("escalates on the lead's own inbound words, not on the drafted outbound reply", async () => {
    const deps = createDeps();

    await processReplyJob(
      { data: sendJob({ action: "send_checkout", body: "Here is your payment link" }) },
      deps,
    );

    const escalationInput = vi.mocked(deps.escalate!).mock.calls[0]![0];
    expect(escalationInput.inbound_body).toBe("Yep send me the link");
    expect(escalationInput.inbound_body).not.toBe("Here is your payment link");
  });

  it("records the escalation on the conversation before paging the operator", async () => {
    const deps = createDeps();

    await processReplyJob({ data: sendJob({ action: "send_checkout" }) }, deps);

    expect(deps.queries!.markConversationEscalated).toHaveBeenCalledWith(
      tenantId,
      conversationId,
      "send_checkout_requires_operator",
    );
    expect(vi.mocked(deps.queries!.markConversationEscalated).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(deps.escalate!).mock.invocationCallOrder[0]!,
    );
  });

  it("fails a send_checkout job that carries no conversation_id rather than escalating blind", async () => {
    const deps = createDeps();

    await expect(
      processReplyJob({ data: sendJob({ action: "send_checkout", conversation_id: null }) }, deps),
    ).rejects.toThrow(/conversation_id/);
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("fails an unknown job_type instead of acknowledging it", async () => {
    const deps = createDeps();

    await expect(
      processReplyJob({ data: { job_type: "retry_checkout", tenant_id: tenantId } as never }, deps),
    ).rejects.toThrow(/unknown job_type/i);
    expect(deps.handleProcessReply).not.toHaveBeenCalled();
    expect(deps.handleSendReply).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it("clamps an untrusted job_type before it reaches a log line", async () => {
    const deps = createDeps();
    const hostile = { job_type: `x${"y".repeat(200)}\nInjected: log line`, tenant_id: tenantId };

    await expect(processReplyJob({ data: hostile as never }, deps)).rejects.toThrow(
      /unknown job_type on replies queue: xy{1,}$/,
    );
    await expect(processReplyJob({ data: hostile as never }, deps)).rejects.not.toThrow(/Injected/);
  });

  it("lets a handler failure fail the job so BullMQ retries it", async () => {
    const deps = createDeps({
      handleProcessReply: vi.fn().mockRejectedValue(new Error("classification failed")),
    });

    await expect(processReplyJob({ data: processJob() }, deps)).rejects.toThrow("classification failed");
  });

  it("lets an escalation failure fail the job so the operator page is retried", async () => {
    const deps = createDeps({ escalate: vi.fn().mockRejectedValue(new Error("Instantly unavailable")) });

    await expect(
      processReplyJob({ data: sendJob({ action: "send_checkout" }) }, deps),
    ).rejects.toThrow("Instantly unavailable");
  });
});

// Throwing only fails a job usefully if the queue is configured to retry it.
// BullMQ defaults to attempts: 1, which would retire a job on its first error
// and leave one PM2 log line as the only trace.
describe("replies queue policy", () => {
  it("retries a failed job rather than retiring it on the first error", () => {
    expect(REPLY_JOB_OPTIONS.attempts).toBeGreaterThan(1);
  });

  it("backs off between attempts so a flapping dependency is not hammered", () => {
    expect(REPLY_JOB_OPTIONS.backoff.type).toBe("exponential");
    expect(REPLY_JOB_OPTIONS.backoff.delay).toBeGreaterThanOrEqual(1_000);
  });

  it("keeps failed jobs so a stalled reply can still be found", () => {
    expect(REPLY_JOB_OPTIONS.removeOnFail).toBe(false);
  });

  it("names the queue the producer already writes to", () => {
    expect(REPLIES_QUEUE_NAME).toBe("replies");
  });
});

describe("reply worker bootstrap", () => {
  it("starts when run as its own entrypoint", () => {
    expect(shouldStartReplyWorker("C:/app/dist/worker.js", undefined, "file:///C:/app/dist/worker.js")).toBe(true);
  });

  it("starts under PM2", () => {
    expect(shouldStartReplyWorker(undefined, "3", "file:///C:/app/dist/worker.js")).toBe(true);
  });

  it("does not start when merely imported by a test or another module", () => {
    expect(shouldStartReplyWorker("C:/app/dist/webhook.js", undefined, "file:///C:/app/dist/worker.js")).toBe(false);
  });
});
