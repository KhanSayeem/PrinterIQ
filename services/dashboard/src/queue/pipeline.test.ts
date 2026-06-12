import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  addMock,
  closeMock,
  getJobMock,
  getStateMock,
  lrangeMock,
  removeMock,
  queueConstructorMock,
  zrangeMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  closeMock: vi.fn(),
  getJobMock: vi.fn(),
  getStateMock: vi.fn(),
  lrangeMock: vi.fn(),
  removeMock: vi.fn(),
  queueConstructorMock: vi.fn(),
  zrangeMock: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: queueConstructorMock.mockImplementation(function Queue() {
    return {
      add: addMock,
      client: Promise.resolve({
        lrange: lrangeMock,
        zrange: zrangeMock,
      }),
      close: closeMock,
      getJob: getJobMock,
    };
  }),
}));

import { enqueueIngestCsvJob, hasActiveIngestCsvJob } from "./pipeline";

describe("enqueueIngestCsvJob", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockReset();
    getStateMock.mockReset();
    lrangeMock.mockReset();
    removeMock.mockReset();
    zrangeMock.mockReset();
    queueConstructorMock.mockClear();
    addMock.mockResolvedValue({ id: "import-csv-tenant-1" });
    closeMock.mockResolvedValue(undefined);
    getJobMock.mockResolvedValue(null);
    lrangeMock.mockResolvedValue([]);
    zrangeMock.mockResolvedValue([]);
  });

  it("fails closed in production when REDIS_URL is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("REDIS_URL", "");

    await expect(
      enqueueIngestCsvJob({
        tenantId: "tenant-1",
        filePath: "C:\\printeriq\\uploads\\apollo.csv",
        sourceFile: "apollo.csv",
        vertical: "tradies",
        dryRun: false,
      }),
    ).rejects.toThrow("Missing env var: REDIS_URL");

    expect(queueConstructorMock).not.toHaveBeenCalled();
  });

  it("adds the documented ingest_csv payload to the pipeline BullMQ queue", async () => {
    vi.stubEnv("REDIS_URL", "redis://redis.example:6379");

    getJobMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      data: {
        file_path: "C:\\printeriq\\uploads\\apollo.csv",
      },
    });

    const result = await enqueueIngestCsvJob({
      tenantId: "tenant-1",
      filePath: "C:\\printeriq\\uploads\\apollo.csv",
      sourceFile: "apollo.csv",
      vertical: "tradies",
      dryRun: false,
    });

    expect(result).toEqual({ id: "import-csv-tenant-1", acquired: true });
    expect(queueConstructorMock).toHaveBeenCalledWith("pipeline", {
      connection: { url: "redis://redis.example:6379" },
    });
    expect(addMock).toHaveBeenCalledWith(
      "ingest_csv",
      {
        job_type: "ingest_csv",
        tenant_id: "tenant-1",
        file_path: "C:\\printeriq\\uploads\\apollo.csv",
        source_file: "apollo.csv",
        vertical: "tradies",
        dry_run: false,
      },
      {
        attempts: 3,
        jobId: "import-csv-tenant-1",
        removeOnComplete: true,
      },
    );
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("returns acquired=false when a tenant import is already waiting or active", async () => {
    getStateMock.mockResolvedValue("active");
    getJobMock.mockResolvedValue({
      id: "import-csv-tenant-1",
      getState: getStateMock,
    });

    const result = await enqueueIngestCsvJob({
      tenantId: "tenant-1",
      filePath: "C:\\printeriq\\uploads\\apollo.csv",
      sourceFile: "apollo.csv",
      vertical: "tradies",
      dryRun: false,
    });

    expect(result).toEqual({ id: "import-csv-tenant-1", acquired: false });
    expect(addMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("reports an active tenant import without adding a new job", async () => {
    getStateMock.mockResolvedValue("active");
    getJobMock.mockResolvedValue({
      id: "import-csv-tenant-1",
      getState: getStateMock,
    });

    const result = await hasActiveIngestCsvJob("tenant-1");

    expect(result).toBe(true);
    expect(addMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("waits for raw queued import checks before closing the queue", async () => {
    let queueClosed = false;
    closeMock.mockImplementation(async () => {
      queueClosed = true;
    });
    lrangeMock.mockImplementation(async (key: string) => {
      await Promise.resolve();
      if (queueClosed) {
        throw new Error("Connection is closed.");
      }
      if (key === "bull:pipeline:wait") {
        return [
          JSON.stringify({
            job_type: "ingest_csv",
            tenant_id: "tenant-1",
            file_path: "C:\\printeriq\\uploads\\retry.csv",
            source_file: "retry.csv",
          }),
        ];
      }
      return [];
    });
    zrangeMock.mockImplementation(async () => {
      await Promise.resolve();
      if (queueClosed) {
        throw new Error("Connection is closed.");
      }
      return [];
    });

    const result = await hasActiveIngestCsvJob("tenant-1");

    expect(result).toBe(true);
    expect(addMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("returns acquired=false when a Python retry for the tenant import is already queued", async () => {
    lrangeMock.mockImplementation(async (key: string) => {
      if (key === "bull:pipeline:wait") {
        return [
          JSON.stringify({
            job_type: "ingest_csv",
            tenant_id: "tenant-1",
            file_path: "C:\\printeriq\\uploads\\retry.csv",
            source_file: "retry.csv",
          }),
        ];
      }
      return [];
    });

    const result = await enqueueIngestCsvJob({
      tenantId: "tenant-1",
      filePath: "C:\\printeriq\\uploads\\apollo.csv",
      sourceFile: "apollo.csv",
      vertical: "tradies",
      dryRun: false,
    });

    expect(result).toEqual({ id: "import-csv-tenant-1", acquired: false });
    expect(addMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("returns acquired=false when a concurrent upload wins the BullMQ job id race", async () => {
    getJobMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      data: {
        file_path: "C:\\printeriq\\uploads\\already-queued.csv",
      },
    });

    const result = await enqueueIngestCsvJob({
      tenantId: "tenant-1",
      filePath: "C:\\printeriq\\uploads\\new-upload.csv",
      sourceFile: "new-upload.csv",
      vertical: "tradies",
      dryRun: false,
    });

    expect(result).toEqual({ id: "import-csv-tenant-1", acquired: false });
    expect(addMock).toHaveBeenCalledOnce();
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("keeps an acquired enqueue result when closing the BullMQ connection fails", async () => {
    closeMock.mockRejectedValue(new Error("redis close failed"));
    getJobMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      data: {
        file_path: "C:\\printeriq\\uploads\\apollo.csv",
      },
    });

    const result = await enqueueIngestCsvJob({
      tenantId: "tenant-1",
      filePath: "C:\\printeriq\\uploads\\apollo.csv",
      sourceFile: "apollo.csv",
      vertical: "tradies",
      dryRun: false,
    });

    expect(result).toEqual({ id: "import-csv-tenant-1", acquired: true });
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("keeps an acquired=false result when closing the BullMQ connection fails", async () => {
    closeMock.mockRejectedValue(new Error("redis close failed"));
    getJobMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      data: {
        file_path: "C:\\printeriq\\uploads\\already-queued.csv",
      },
    });

    const result = await enqueueIngestCsvJob({
      tenantId: "tenant-1",
      filePath: "C:\\printeriq\\uploads\\new-upload.csv",
      sourceFile: "new-upload.csv",
      vertical: "tradies",
      dryRun: false,
    });

    expect(result).toEqual({ id: "import-csv-tenant-1", acquired: false });
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("removes stale completed or failed jobs before adding a fresh import", async () => {
    getStateMock.mockResolvedValue("failed");
    getJobMock
      .mockResolvedValueOnce({
        id: "import-csv-tenant-1",
        getState: getStateMock,
        remove: removeMock,
      })
      .mockResolvedValueOnce({
        data: {
          file_path: "C:\\printeriq\\uploads\\apollo.csv",
        },
      });

    await enqueueIngestCsvJob({
      tenantId: "tenant-1",
      filePath: "C:\\printeriq\\uploads\\apollo.csv",
      sourceFile: "apollo.csv",
      vertical: "tradies",
      dryRun: false,
    });

    expect(removeMock).toHaveBeenCalledOnce();
    expect(addMock).toHaveBeenCalledOnce();
  });
});
