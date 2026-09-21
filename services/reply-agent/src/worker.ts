import { Worker, type Job } from "bullmq";
import { pathToFileURL } from "node:url";
import {
  handleProcessReply as defaultHandleProcessReply,
  handleSendReply as defaultHandleSendReply,
  inboundDedupeKey,
} from "./handler.js";
import { escalate as defaultEscalate, maskSnippetPii, type EscalationInput } from "./escalation.js";
import { queries as defaultQueries } from "./db/queries.js";
import {
  createReplyQueue,
  redisConnectionUrl,
  REPLIES_QUEUE_NAME,
  REPLY_JOB_OPTIONS,
  type ReplyJobData,
} from "./queue.js";
import type { ProcessReplyJob, SendReplyJob } from "./types.js";

export { createReplyQueue, REPLIES_QUEUE_NAME, REPLY_JOB_OPTIONS, type ReplyJobData };

/** Escalation reason used when a reply could not be processed after every retry. */
export const UNCLASSIFIED_ESCALATION_REASON = "reply_not_processed_after_retries";

export type UnprocessedReplyDeps = {
  queries?: {
    insertInboundConversation: typeof defaultQueries.insertInboundConversation;
    markConversationEscalated(tenantId: string, conversationId: string, reason: string): Promise<unknown>;
  };
  escalate?: (input: EscalationInput) => Promise<void>;
  logger?: ReplyWorkerLogger;
};

/**
 * A reply that could not be processed goes to a human, not to a log line.
 *
 * On 2026-09-17 a reply from Beyond Training failed classification three
 * times, BullMQ gave up, and the only trace was "FAILED PERMANENTLY" in an
 * error log nobody reads. It sat for five days.
 *
 * The conversation id is found by repeating the handler's own insert, which
 * is idempotent on the dedupe key since migration 0015: it returns the row the
 * handler already wrote. If the handler failed before writing it, this writes
 * it, which is the right outcome too: the reply is recorded and escalated
 * rather than lost.
 *
 * Never throws. It runs inside the worker's failure handler, and a throw there
 * would only produce another log line.
 */
export async function escalateUnprocessedReply(
  job: ProcessReplyJob,
  deps: UnprocessedReplyDeps = {},
): Promise<void> {
  const queries = deps.queries ?? defaultQueries;
  const escalate = deps.escalate ?? defaultEscalate;
  const logger = deps.logger ?? console;

  try {
    const conversation = await queries.insertInboundConversation(
      job.tenant_id,
      job.lead_id,
      job.channel,
      job.body,
      {
        instantly_lead_id: job.instantly_lead_id ?? null,
        instantly_email_id: job.instantly_email_id ?? null,
        instantly_account_id: job.instantly_account_id ?? null,
        dedupe_key: inboundDedupeKey(job),
      },
    );

    await queries.markConversationEscalated(
      job.tenant_id,
      conversation.id,
      UNCLASSIFIED_ESCALATION_REASON,
    );

    await escalate({
      tenant_id: job.tenant_id,
      lead_id: job.lead_id,
      conversation_id: conversation.id,
      reason: UNCLASSIFIED_ESCALATION_REASON,
      inbound_body: job.body,
    });
  } catch (error) {
    // The error class only: a message here can quote the reply or the lead.
    logger.warn(
      `Could not escalate a reply that failed processing: ${error instanceof Error ? error.name : "unknown error"}`,
    );
  }
}

/** Escalation reason used when the operator, not the agent, must send checkout. */
export const SEND_CHECKOUT_ESCALATION_REASON = "send_checkout_requires_operator";

export type ReplyWorkerQueue = {
  add(name: string, payload: SendReplyJob, options?: { jobId: string }): Promise<unknown>;
};

export type ReplyWorkerQueries = {
  markConversationEscalated(
    tenantId: string,
    conversationId: string,
    reason: string,
  ): Promise<{ body: string }>;
};

export type ReplyWorkerLogger = {
  warn(message: string): void;
};

export type ReplyWorkerDeps = {
  handleProcessReply?: typeof defaultHandleProcessReply;
  handleSendReply?: typeof defaultHandleSendReply;
  escalate?: (input: EscalationInput) => Promise<void>;
  queries?: ReplyWorkerQueries;
  queue?: ReplyWorkerQueue;
  logger?: ReplyWorkerLogger;
};

export type ReplyJobResult = { action: string; conversation_id?: string };

/** Route a `send_reply` job whose action is `send_checkout` to a human.
 *
 * DELIBERATE: this override lives in the worker, not in `handleProcessReply`.
 * The handler's job is to classify and to record what it classified;
 * `agent_action = 'send_checkout'` is the audit trail of Claude's decision and
 * the input to `hasCheckoutAction`. Rewriting it inside the handler would
 * falsify that record. Whether a decision is delivered automatically or handed
 * to the operator is a delivery-layer policy, so it belongs here, where the
 * queue is drained. That also leaves `handleProcessReply` and its tests
 * untouched, so the policy can be lifted later by deleting this branch.
 */
async function escalateInsteadOfCheckout(
  job: SendReplyJob,
  deps: ReplyWorkerDeps,
): Promise<ReplyJobResult> {
  const conversationId = job.conversation_id;
  if (!conversationId) {
    throw new Error("conversation_id is required to escalate a send_checkout job");
  }

  const db = deps.queries ?? defaultQueries;
  const escalate = deps.escalate ?? defaultEscalate;

  // Recording first keeps the write idempotent across BullMQ retries: the SMS
  // is the step that can fail, and re-running the UPDATE costs nothing.
  // The returned body is the lead's own inbound message; `job.body` is the
  // drafted outbound reply and would misquote the lead in the operator's SMS.
  const conversation = await db.markConversationEscalated(
    job.tenant_id,
    conversationId,
    SEND_CHECKOUT_ESCALATION_REASON,
  );

  await escalate({
    tenant_id: job.tenant_id,
    lead_id: job.lead_id,
    conversation_id: conversationId,
    reason: SEND_CHECKOUT_ESCALATION_REASON,
    inbound_body: conversation.body,
  });

  return { action: "escalate", conversation_id: conversationId };
}

function describeJobType(data: unknown): string {
  const raw = (data as { job_type?: unknown } | null | undefined)?.job_type;
  return String(raw).replace(/[\r\n]+/g, " ").slice(0, 40);
}

/** Dispatch one job off the `replies` queue.
 *
 * Exported separately from the BullMQ `Worker` so the routing is testable
 * without a Redis connection. Nothing here catches: a thrown error is how a
 * BullMQ job is marked failed and retried, and swallowing one would recreate
 * the silent-failure class of bug this worker exists to end.
 */
export async function processReplyJob(
  job: Pick<Job<ReplyJobData>, "data">,
  deps: ReplyWorkerDeps = {},
): Promise<ReplyJobResult> {
  const data = job.data;

  switch (data?.job_type) {
    case "process_reply":
      return (deps.handleProcessReply ?? defaultHandleProcessReply)(data, { queue: deps.queue });

    case "send_reply":
      if (data.action === "send_checkout") {
        return escalateInsteadOfCheckout(data, deps);
      }

      // NOTE FOR A FUTURE AGENT: when automated delivery is added, send through
      // Instantly's reply API, never Resend. The thread was started from an
      // Instantly mailbox; replying from a different sending domain breaks
      // threading and reads as phishing to the recipient and to spam filters.
      // Resend is for the post-payment welcome email only.
      //
      // Until that exists, `handleSendReply` validates the conversation and
      // returns without sending anything. Say so out loud: a queue that drains
      // cleanly while nothing reaches the lead is exactly the silent success
      // this worker was written to end. No PII: ids and the action only.
      {
        const result = await (deps.handleSendReply ?? defaultHandleSendReply)(data);
        (deps.logger ?? console).warn(
          `reply drafted but not delivered (automated reply sending is not implemented): ` +
            `tenant=${data.tenant_id} lead=${data.lead_id} conversation=${data.conversation_id ?? "unknown"}`,
        );
        return result;
      }

    default:
      // The value is clamped before it reaches a log line: it is job data, and
      // job data is never trusted to be a short, single-line, PII-free string.
      throw new Error(`unknown job_type on replies queue: ${describeJobType(data)}`);
  }
}

export function createReplyWorker(queue: ReplyWorkerQueue): Worker<ReplyJobData, ReplyJobResult> {
  return new Worker<ReplyJobData, ReplyJobResult>(
    REPLIES_QUEUE_NAME,
    async (job) => processReplyJob(job, { queue }),
    {
      connection: { url: redisConnectionUrl() },
      // Reply volume is a handful a week; one at a time keeps ordering simple
      // and keeps Claude and Twilio calls well inside their rate limits.
      concurrency: 1,
    },
  );
}

async function main(): Promise<void> {
  const queue = createReplyQueue();
  const worker = createReplyWorker(queue);

  // The job type is job data and the error text is third-party text: a pg
  // error quotes the offending value, and a Stripe or Claude error can carry
  // the lead's email. Both go through the same clamping and masking the
  // escalation path uses, so no PII reaches a log line.
  worker.on("failed", (job, error) => {
    const exhausted = job ? job.attemptsMade >= (job.opts?.attempts ?? 1) : false;
    console.error(
      `replies worker job ${exhausted ? "FAILED PERMANENTLY" : "failed, will retry"}: ` +
        `id=${job?.id ?? "unknown"} job_type=${describeJobType(job?.data)} ` +
        `attempt=${job?.attemptsMade ?? 0}/${job?.opts?.attempts ?? REPLY_JOB_OPTIONS.attempts} ` +
        `reason=${maskSnippetPii(error instanceof Error ? error.message : "unknown")}`,
    );

    if (exhausted && job?.data && (job.data as { job_type?: string }).job_type === "process_reply") {
      void escalateUnprocessedReply(job.data as ProcessReplyJob);
    }
  });

  // BullMQ forwards Redis connection failures as an `error` event. Node throws
  // on an `error` event with no listener, which would crash the process, and
  // PM2 gives up after max_restarts, leaving the queue silently unattended.
  worker.on("error", (error) => {
    console.error(`replies worker error: ${maskSnippetPii(error instanceof Error ? error.message : "unknown")}`);
  });

  process.on("unhandledRejection", (reason) => {
    console.error(
      `replies worker unhandled rejection: ${maskSnippetPii(reason instanceof Error ? reason.message : String(reason))}`,
    );
  });

  worker.on("ready", () => {
    console.log(`replies worker listening on queue=${REPLIES_QUEUE_NAME}`);
  });

  const shutdown = async (): Promise<void> => {
    await worker.close();
    await queue.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}

export function shouldStartReplyWorker(
  entrypointPath: string | undefined,
  pmId: string | undefined,
  moduleUrl = import.meta.url,
): boolean {
  if (pmId) {
    return true;
  }

  return Boolean(entrypointPath && moduleUrl === pathToFileURL(entrypointPath).href);
}

if (shouldStartReplyWorker(process.argv[1], process.env.pm_id)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "replies worker failed to start");
    process.exit(1);
  });
}
