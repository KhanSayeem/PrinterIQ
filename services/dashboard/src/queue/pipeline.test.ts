import { beforeEach, describe, expect, it, vi } from "vitest";

const { addMock, closeMock, getJobMock, getStateMock, removeMock, queueConstructorMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  closeMock: vi.fn(),
  getJobMock: vi.fn(),
  getStateMock: vi.fn(),
  removeMock: vi.fn(),
  queueConstructorMock: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: queueConstructorMock.mockImplementation(function Queue() {
    return {
      add: addMock,
      close: closeMock,
      getJob: getJobMock,
    };
  }),
}));

import { enqueueIngestCsvJob } from "./pipeline";

describe("enqueueIngestCsvJob", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockReset();
    getStateMock.mockReset();
    removeMock.mockReset();
    queueConstructorMock.mockClear();
    addMock.mockResolvedValue({ id: "import-csv-tenant-1" });
    closeMock.mockResolvedValue(undefined);
    getJobMock.mockResolvedValue(null);
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
