import { Queue } from "bullmq";
import type { ProcessReplyJob, SendReplyJob } from "./types.js";

/** Queue name and retry policy, shared by the producer and the consumer.
 *
 * This module exists so `webhook.ts` (producer) and `worker.ts` (consumer)
 * agree on both without either importing the other. Importing `worker.ts`
 * would run its `pm_id` self-start guard inside the webhook process and start
 * a second Worker on the same queue.
 */
export const REPLIES_QUEUE_NAME = "replies";

export type ReplyJobData = ProcessReplyJob | SendReplyJob;

/** Retry policy for the `replies` queue.
 *
 * BullMQ defaults to `attempts: 1`, so without this a thrown error retires the
 * job permanently and the only trace is one line in a PM2 log. That matters
 * most on the escalation path: mark the conversation escalated, have Twilio
 * return a 500, and the dashboard would show an escalation that never paged a
 * human while a lead who asked to pay hears nothing.
 *
 * The cost of retrying is a duplicate operator SMS, because `escalate()` sends
 * the SMS before it pauses Instantly and only the DB write is idempotent. A
 * second SMS to the operator is plainly better than a lost escalation, but it
 * is a real consequence, and it is why the attempt count is small rather than
 * generous. Failed jobs are kept so a stalled reply is inspectable rather than
 * evaporating.
 */
export const REPLY_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 30_000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};

export function redisConnectionUrl(): string {
  return process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
}

export function createReplyQueue(): Queue<ReplyJobData> {
  return new Queue<ReplyJobData>(REPLIES_QUEUE_NAME, {
    connection: { url: redisConnectionUrl() },
    defaultJobOptions: REPLY_JOB_OPTIONS,
  });
}
