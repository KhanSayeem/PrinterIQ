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

function importJobId(tenantId: string) {
  return `import-csv-${tenantId}`;
}

function createPipelineQueue() {
  const connectionUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

  return new Queue<IngestCsvPayload>("pipeline", {
    connection: { url: connectionUrl },
  });
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
