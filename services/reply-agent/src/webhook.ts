import { Queue } from "bullmq";
import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { ProcessReplyJob } from "./types.js";
import { stripePayments } from "./stripe.js";

export type ReplyQueue = {
  add(name: string, payload: ProcessReplyJob): Promise<unknown>;
  close?(): Promise<void>;
};

type BuildServerOptions = {
  instantlySecret: string;
  queue: ReplyQueue;
  stripeWebhookSecret?: string;
  stripe?: {
    handleWebhook(rawBody: string | Buffer, signature: string, options?: { webhookSecret?: string }): Promise<unknown>;
  };
};

const webhookPayloadSchema = z.record(z.unknown());

function readString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function readNestedString(payload: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = payload;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

function mapInstantlyPayload(payload: Record<string, unknown>): ProcessReplyJob {
  const tenantId =
    readString(payload, ["tenant_id", "tenantId"]) ??
    readNestedString(payload, ["metadata", "tenant_id"]) ??
    readNestedString(payload, ["custom_variables", "tenant_id"]);
  const leadId =
    readString(payload, ["lead_id", "leadId"]) ??
    readNestedString(payload, ["metadata", "lead_id"]) ??
    readNestedString(payload, ["custom_variables", "lead_id"]);
  const body = readString(payload, ["reply_text", "body", "text", "message"]);

  if (!tenantId || !leadId || !body) {
    throw new Error("missing required webhook fields");
  }

  return {
    job_type: "process_reply",
    tenant_id: tenantId,
    lead_id: leadId,
    channel: "email",
    direction: "inbound",
    body,
    raw_webhook: payload,
  };
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const server = Fastify({ logger: false });
  const stripe = options.stripe ?? stripePayments;

  server.addContentTypeParser<string>("application/json", { parseAs: "string" }, (request, body, done) => {
    (request as typeof request & { rawBody?: string }).rawBody = body;

    if (request.url.startsWith("/stripe")) {
      done(null, body);
      return;
    }

    try {
      done(null, JSON.parse(body) as unknown);
    } catch (error) {
      done(error as Error);
    }
  });

  server.setErrorHandler((_error, _request, reply) => {
    return reply.code(500).send({ error: "webhook processing failed" });
  });

  server.post("/instantly", {
    onRequest: async (request, reply) => {
      const providedSecret = request.headers["x-instantly-secret"];

      if (providedSecret !== options.instantlySecret) {
        return reply.code(400).send({ error: "invalid webhook secret" });
      }
    },
  }, async (request, reply) => {
    const providedSecret = request.headers["x-instantly-secret"];

    if (providedSecret !== options.instantlySecret) {
      return reply.code(400).send({ error: "invalid webhook secret" });
    }

    const parsed = webhookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid webhook payload" });
    }

    let job: ProcessReplyJob;
    try {
      job = mapInstantlyPayload(parsed.data);
    } catch {
      return reply.code(400).send({ error: "invalid webhook payload" });
    }

    try {
      await options.queue.add("process_reply", job);
    } catch {
      return reply.code(500).send({ error: "webhook processing failed" });
    }

    return reply.code(200).send({ ok: true });
  });

  server.post("/stripe", async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string" || signature.length === 0) {
      return reply.code(400).send({ error: "invalid stripe signature" });
    }

    const rawBody = (request as typeof request & { rawBody?: string }).rawBody;
    if (!rawBody) {
      return reply.code(400).send({ error: "invalid stripe signature" });
    }

    try {
      await stripe.handleWebhook(rawBody, signature, {
        webhookSecret: options.stripeWebhookSecret,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.toLowerCase().includes("signature")) {
        return reply.code(400).send({ error: "invalid stripe signature" });
      }

      return reply.code(500).send({ error: "stripe webhook processing failed" });
    }

    return reply.code(200).send({ ok: true });
  });

  return server;
}

function createQueue(): Queue<ProcessReplyJob> {
  const connectionUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

  return new Queue<ProcessReplyJob>("replies", {
    connection: { url: connectionUrl },
  });
}

async function main(): Promise<void> {
  const instantlySecret = process.env.INSTANTLY_WEBHOOK_SECRET;
  if (!instantlySecret) {
    throw new Error("INSTANTLY_WEBHOOK_SECRET is required");
  }

  const queue = createQueue();
  const server = buildServer({ instantlySecret, queue });
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);

  await server.listen({ port, host: "0.0.0.0" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "reply-agent failed to start");
    process.exit(1);
  });
}
