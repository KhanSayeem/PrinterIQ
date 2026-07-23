import { Queue } from "bullmq";
import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { ProcessReplyJob } from "./types.js";
import { stripePayments } from "./stripe.js";
import { queries as defaultQueries } from "./db/queries.js";

export type ReplyQueue = {
  add(name: string, payload: ProcessReplyJob): Promise<unknown>;
  close?(): Promise<void>;
};

type BuildServerOptions = {
  instantlyWebhookIds: {
    reply: string;
    bounced: string;
    unsubbed: string;
  };
  queue: ReplyQueue;
  queries?: Pick<typeof defaultQueries, "recordInstantlyBounce" | "recordInstantlyUnsubscribe">;
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
  const tenantId = readNestedString(payload, ["metadata", "tenant_id"]);
  const leadId = readNestedString(payload, ["metadata", "lead_id"]);
  const body = readString(payload, ["reply_text", "body", "text", "message"]);
  const instantlyLeadId = readNestedString(payload, ["lead", "id"]);
  const instantlyEmailId = readNestedString(payload, ["email", "id"]);
  const instantlyAccountId = readNestedString(payload, ["email", "eaccount"]);

  if (!tenantId || !leadId || !body || !instantlyLeadId || !instantlyEmailId || !instantlyAccountId) {
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
    instantly_lead_id: instantlyLeadId,
    instantly_email_id: instantlyEmailId,
    instantly_account_id: instantlyAccountId,
  };
}

function mapInstantlyLeadEventPayload(payload: Record<string, unknown>): {
  tenantId: string;
  leadId: string;
  instantlyLeadId: string;
} {
  const tenantId = readNestedString(payload, ["metadata", "tenant_id"]);
  const leadId = readNestedString(payload, ["metadata", "lead_id"]);
  const instantlyLeadId = readNestedString(payload, ["lead", "id"]);

  if (!tenantId || !leadId || !instantlyLeadId) {
    throw new Error("missing required webhook fields");
  }

  return { tenantId, leadId, instantlyLeadId };
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const server = Fastify({ logger: false });
  const stripe = options.stripe ?? stripePayments;
  const queries = options.queries ?? defaultQueries;

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
      return reply.code(400).send({ error: "invalid instantly webhook route" });
    },
  }, async () => undefined);

  server.post("/instantly/", {
    onRequest: async (request, reply) => {
      return reply.code(400).send({ error: "invalid instantly webhook route" });
    },
  }, async () => undefined);

  server.post("/instantly/reply/:webhookId", {
    onRequest: async (request, reply) => {
      const { webhookId } = request.params as { webhookId?: string };

      if (webhookId !== options.instantlyWebhookIds.reply) {
        return reply.code(400).send({ error: "invalid webhook id" });
      }
    },
  }, async (request, reply) => {
    const { webhookId } = request.params as { webhookId?: string };

    if (webhookId !== options.instantlyWebhookIds.reply) {
      return reply.code(400).send({ error: "invalid webhook id" });
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

  server.post("/instantly/bounced/:webhookId", {
    onRequest: async (request, reply) => {
      const { webhookId } = request.params as { webhookId?: string };

      if (webhookId !== options.instantlyWebhookIds.bounced) {
        return reply.code(400).send({ error: "invalid webhook id" });
      }
    },
  }, async (request, reply) => {
    const { webhookId } = request.params as { webhookId?: string };

    if (webhookId !== options.instantlyWebhookIds.bounced) {
      return reply.code(400).send({ error: "invalid webhook id" });
    }

    const parsed = webhookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid webhook payload" });
    }

    let event: { tenantId: string; leadId: string; instantlyLeadId: string };
    try {
      event = mapInstantlyLeadEventPayload(parsed.data);
    } catch {
      return reply.code(400).send({ error: "invalid webhook payload" });
    }

    try {
      await queries.recordInstantlyBounce(event.tenantId, event.leadId, event.instantlyLeadId);
    } catch {
      return reply.code(500).send({ error: "webhook processing failed" });
    }

    return reply.code(200).send({ ok: true });
  });

  server.post("/instantly/unsubbed/:webhookId", {
    onRequest: async (request, reply) => {
      const { webhookId } = request.params as { webhookId?: string };

      if (webhookId !== options.instantlyWebhookIds.unsubbed) {
        return reply.code(400).send({ error: "invalid webhook id" });
      }
    },
  }, async (request, reply) => {
    const { webhookId } = request.params as { webhookId?: string };

    if (webhookId !== options.instantlyWebhookIds.unsubbed) {
      return reply.code(400).send({ error: "invalid webhook id" });
    }

    const parsed = webhookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid webhook payload" });
    }

    let event: { tenantId: string; leadId: string; instantlyLeadId: string };
    try {
      event = mapInstantlyLeadEventPayload(parsed.data);
    } catch {
      return reply.code(400).send({ error: "invalid webhook payload" });
    }

    try {
      await queries.recordInstantlyUnsubscribe(event.tenantId, event.leadId, event.instantlyLeadId);
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
  const instantlyWebhookIds = {
    reply: process.env.INSTANTLY_WEBHOOK_ID_REPLY,
    bounced: process.env.INSTANTLY_WEBHOOK_ID_BOUNCED,
    unsubbed: process.env.INSTANTLY_WEBHOOK_ID_UNSUBBED,
  };
  const missingInstantlyWebhookId = Object.entries(instantlyWebhookIds).find(([, value]) => !value)?.[0];
  if (missingInstantlyWebhookId) {
    throw new Error(`INSTANTLY_WEBHOOK_ID_${missingInstantlyWebhookId.toUpperCase()} is required`);
  }

  const queue = createQueue();
  const server = buildServer({
    instantlyWebhookIds: instantlyWebhookIds as { reply: string; bounced: string; unsubbed: string },
    queue,
  });
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);

  await server.listen({ port, host: "0.0.0.0" });
}

export function shouldStartWebhookServer(entrypointPath: string | undefined, pmId: string | undefined, moduleUrl = import.meta.url): boolean {
  if (pmId) {
    return true;
  }

  return Boolean(entrypointPath && moduleUrl === pathToFileURL(entrypointPath).href);
}

if (shouldStartWebhookServer(process.argv[1], process.env.pm_id)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "reply-agent failed to start");
    process.exit(1);
  });
}
