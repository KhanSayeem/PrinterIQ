import { Queue } from "bullmq";

export type IngestCsvJobInput = {
  tenantId: string;
  filePath: string;
  sourceFile: string;
  vertical: string;
  dryRun: boolean;
};

export type QueueJobLease = {
  id: string;
  acquired: boolean;
};

type IngestCsvPayload = {
  job_type: "ingest_csv";
  tenant_id: string;
  file_path: string;
  source_file: string;
  vertical: string;
  dry_run: boolean;
};

const activeImportStates = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);
const pipelineQueueKeys = ["bull:pipeline:wait", "bull:pipeline:active"];
const pipelineDelayedKey = "bull:pipeline:delayed";

type PipelineRedisClient = {
  lrange(key: string, start: number, end: number): Promise<string[]>;
  zrange(key: string, start: number, end: number): Promise<string[]>;
};

function importJobId(tenantId: string) {
  return `import-csv-${tenantId}`;
}

function redisUrl() {
  const configuredUrl = process.env.REDIS_URL?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Missing env var: REDIS_URL");
  }
  return "redis://127.0.0.1:6379";
}

function createPipelineQueue() {
  return new Queue<IngestCsvPayload>("pipeline", {
    connection: { url: redisUrl() },
  });
}

function isRawTenantImportPayload(item: string, tenantId: string) {
  if (!item.startsWith("{")) {
    return false;
  }
  try {
    const payload: unknown = JSON.parse(item);
    return (
      typeof payload === "object" &&
      payload !== null &&
      "job_type" in payload &&
      "tenant_id" in payload &&
      payload.job_type === "ingest_csv" &&
      payload.tenant_id === tenantId
    );
  } catch {
    return false;
  }
}

async function hasRawTenantImportRetry(
  queue: Queue<IngestCsvPayload>,
  tenantId: string,
) {
  const redis = await queue.client as PipelineRedisClient;
  const listItems = (
    await Promise.all(pipelineQueueKeys.map((key) => redis.lrange(key, 0, -1)))
  ).flat();
  const delayedItems = await redis.zrange(pipelineDelayedKey, 0, -1);

  return [...listItems, ...delayedItems].some((item) => isRawTenantImportPayload(item, tenantId));
}

export async function enqueueIngestCsvJob(input: IngestCsvJobInput): Promise<QueueJobLease> {
  const queue = createPipelineQueue();
  const jobId = importJobId(input.tenantId);

  try {
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (activeImportStates.has(state)) {
        return { id: jobId, acquired: false };
      }
      await existingJob.remove();
    }

    if (await hasRawTenantImportRetry(queue, input.tenantId)) {
      return { id: jobId, acquired: false };
    }

    const payload: IngestCsvPayload = {
      job_type: "ingest_csv",
      tenant_id: input.tenantId,
      file_path: input.filePath,
      source_file: input.sourceFile,
      vertical: input.vertical,
      dry_run: input.dryRun,
    };

    const job = await queue.add("ingest_csv", payload, {
      attempts: 3,
      jobId,
      removeOnComplete: true,
    });

    const queuedJob = await queue.getJob(jobId);
    if (!queuedJob || queuedJob.data.file_path !== input.filePath) {
      return { id: jobId, acquired: false };
    }

    return { id: String(job.id ?? jobId), acquired: true };
  } finally {
    try {
      await queue.close();
    } catch (error) {
      console.error("Failed to close pipeline queue", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}

export async function hasActiveIngestCsvJob(tenantId: string) {
  const queue = createPipelineQueue();
  const jobId = importJobId(tenantId);

  try {
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (activeImportStates.has(state)) {
        return true;
      }
    }

    return await hasRawTenantImportRetry(queue, tenantId);
  } finally {
    try {
      await queue.close();
    } catch (error) {
      console.error("Failed to close pipeline queue", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
