import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getUserMock, enqueueIngestCsvJobMock, hasActiveIngestCsvJobMock, mkdirMock, writeFileMock, unlinkMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  enqueueIngestCsvJobMock: vi.fn(),
  hasActiveIngestCsvJobMock: vi.fn(),
  mkdirMock: vi.fn(),
  writeFileMock: vi.fn(),
  unlinkMock: vi.fn(),
}));

vi.mock("@/auth/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: getUserMock },
  }),
}));

vi.mock("@/queue/pipeline", () => ({
  enqueueIngestCsvJob: enqueueIngestCsvJobMock,
  hasActiveIngestCsvJob: hasActiveIngestCsvJobMock,
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: mkdirMock,
    writeFile: writeFileMock,
    unlink: unlinkMock,
  },
  mkdir: mkdirMock,
  writeFile: writeFileMock,
  unlink: unlinkMock,
}));

import { POST } from "./route";

function requestWithForm(formData: FormData) {
  const request = new NextRequest("http://localhost/api/import-csv", {
    method: "POST",
    body: formData,
  });
  request.headers.set("content-length", "1024");
  return request;
}

function requestWithUpload(
  fileName: string,
  contents: string,
  options: { type?: string; sourceFile?: string } = {},
) {
  const boundary = "----printeriq-test-boundary";
  const parts = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
    `Content-Type: ${options.type ?? "text/csv"}`,
    "",
    contents,
  ];

  if (options.sourceFile !== undefined) {
    parts.push(
      `--${boundary}`,
      'Content-Disposition: form-data; name="sourceFile"',
      "",
      options.sourceFile,
    );
  }

  parts.push(`--${boundary}--`, "");
  const body = parts.join("\r\n");
  const request = new NextRequest("http://localhost/api/import-csv", {
    method: "POST",
    body,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(Buffer.byteLength(body)),
    },
  });
  return request;
}

describe("POST /api/import-csv", () => {
  beforeEach(() => {
    vi.stubEnv("DASHBOARD_OPERATOR_EMAILS", "operator@presciaiq.com");
    vi.stubEnv("QUALIFICATION_SCORE_THRESHOLD", "40");
    getUserMock.mockReset();
    enqueueIngestCsvJobMock.mockReset();
    hasActiveIngestCsvJobMock.mockReset();
    mkdirMock.mockReset();
    writeFileMock.mockReset();
    unlinkMock.mockReset();
    enqueueIngestCsvJobMock.mockResolvedValue({ id: "job-1", acquired: true });
    hasActiveIngestCsvJobMock.mockResolvedValue(false);
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 when there is no authenticated user", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const response = await POST(requestWithForm(new FormData()));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the authenticated user is not in the operator allowlist", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "intruder@example.com" } } });

    const response = await POST(requestWithForm(new FormData()));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("returns 403 when no operator allowlist is configured", async () => {
    vi.stubEnv("DASHBOARD_OPERATOR_EMAILS", "");
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const response = await POST(requestWithForm(new FormData()));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("fails closed before writing files when TENANT_ID is missing in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TENANT_ID", "");
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const response = await POST(requestWithForm(new FormData()));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Dashboard tenant not configured" });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("fails closed before writing files when TENANT_ID is not a UUID", async () => {
    vi.stubEnv("TENANT_ID", "not-a-uuid");
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const response = await POST(requestWithUpload("apollo.csv", "Email\nlead@example.com\n"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Dashboard tenant not configured" });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("fails closed before writing files when QUALIFICATION_SCORE_THRESHOLD is missing", async () => {
    vi.stubEnv("QUALIFICATION_SCORE_THRESHOLD", "");
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const response = await POST(requestWithUpload("apollo.csv", "Email\nlead@example.com\n"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Qualification score threshold is not configured" });
    expect(hasActiveIngestCsvJobMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("fails closed before writing files when QUALIFICATION_SCORE_THRESHOLD is malformed", async () => {
    vi.stubEnv("QUALIFICATION_SCORE_THRESHOLD", "40.5");
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const response = await POST(requestWithUpload("apollo.csv", "Email\nlead@example.com\n"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Qualification score threshold must be an integer from 0 to 100" });
    expect(hasActiveIngestCsvJobMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("fails closed before writing files when QUALIFICATION_SCORE_THRESHOLD is out of range", async () => {
    vi.stubEnv("QUALIFICATION_SCORE_THRESHOLD", "101");
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const response = await POST(requestWithUpload("apollo.csv", "Email\nlead@example.com\n"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Qualification score threshold must be an integer from 0 to 100" });
    expect(hasActiveIngestCsvJobMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("returns a JSON validation response when no file is uploaded", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const response = await POST(requestWithForm(new FormData()));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "CSV file is required" });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("rejects oversized uploads before writing files", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    const request = requestWithUpload("apollo.csv", "Email\nlead@example.com\n");
    request.headers.set("content-length", String(52 * 1024 * 1024));

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "CSV file must be 50MB or smaller" });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("uses DASHBOARD_MAX_CSV_UPLOAD_BYTES for the upload limit message", async () => {
    vi.stubEnv("DASHBOARD_MAX_CSV_UPLOAD_BYTES", String(12 * 1024 * 1024));
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    const request = requestWithUpload("apollo.csv", "Email\nlead@example.com\n");
    request.headers.set("content-length", String(14 * 1024 * 1024));

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "CSV file must be 12MB or smaller" });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("falls back to the default upload limit when DASHBOARD_MAX_CSV_UPLOAD_BYTES is above the bounded ceiling", async () => {
    vi.stubEnv("DASHBOARD_MAX_CSV_UPLOAD_BYTES", String(200 * 1024 * 1024));
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    const request = requestWithUpload("apollo.csv", "Email\nlead@example.com\n");
    request.headers.set("content-length", String(52 * 1024 * 1024));

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "CSV file must be 50MB or smaller" });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("queues valid uploads that are above the old hardcoded 10MB cap but under the configured cap", async () => {
    vi.stubEnv("DASHBOARD_MAX_CSV_UPLOAD_BYTES", String(12 * 1024 * 1024));
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    const csvContents = `Email\n${"a".repeat(11 * 1024 * 1024)}@example.com\n`;
    const request = requestWithUpload("apollo.csv", csvContents);

    const response = await POST(request);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      message: "Import queued",
      jobId: "job-1",
      sourceFile: "apollo.csv",
    });
    expect(writeFileMock).toHaveBeenCalledOnce();
    expect(Buffer.byteLength(writeFileMock.mock.calls[0]?.[1] as Buffer)).toBeGreaterThan(10 * 1024 * 1024);
    expect(enqueueIngestCsvJobMock).toHaveBeenCalledOnce();
  });

  it("allows multipart overhead above the configured CSV file limit", async () => {
    vi.stubEnv("DASHBOARD_MAX_CSV_UPLOAD_BYTES", String(1024));
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    const request = requestWithUpload("apollo.csv", `Email\n${"a".repeat(900)}@example.com\n`);

    const response = await POST(request);

    expect(response.status).toBe(202);
    expect(writeFileMock).toHaveBeenCalledOnce();
    expect(Buffer.byteLength(writeFileMock.mock.calls[0]?.[1] as Buffer)).toBeLessThanOrEqual(1024);
    expect(Number(request.headers.get("content-length"))).toBeGreaterThan(1024);
  });

  it("rejects uploads without a valid content length before parsing", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    const response = await POST(
      new NextRequest("http://localhost/api/import-csv", {
        method: "POST",
        body: new FormData(),
      }),
    );

    expect(response.status).toBe(411);
    expect(await response.json()).toEqual({ error: "Content-Length header is required" });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("rejects a duplicate active import before parsing the multipart body", async () => {
    vi.stubEnv("TENANT_ID", "11111111-1111-4111-8111-111111111111");
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    hasActiveIngestCsvJobMock.mockResolvedValue(true);
    const request = requestWithUpload("apollo.csv", "Email\nlead@example.com\n");
    const formDataSpy = vi.spyOn(request, "formData");

    const response = await POST(request);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "An import is already queued or running",
      jobId: "import-csv-11111111-1111-4111-8111-111111111111",
    });
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("returns JSON when the active import preflight fails before parsing the multipart body", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    hasActiveIngestCsvJobMock.mockRejectedValue(new Error("redis unavailable"));
    const request = requestWithUpload("apollo.csv", "Email\nlead@example.com\n");
    const formDataSpy = vi.spyOn(request, "formData");

    const response = await POST(request);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to queue import" });
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("rejects malformed content length before parsing", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    for (const value of ["not-a-number", "1e3", "0x400", "+1024", "1.0"]) {
      const request = new NextRequest("http://localhost/api/import-csv", {
        method: "POST",
        body: new FormData(),
      });
      request.headers.set("content-length", value);

      const response = await POST(request);

      expect(response.status).toBe(411);
      expect(await response.json()).toEqual({ error: "Content-Length header is required" });
    }
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("rejects non-CSV uploads before writing the file", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const response = await POST(requestWithUpload("apollo.txt", "not csv", { type: "text/plain" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Upload an Apollo CSV file" });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("does not trust a spoofed sourceFile name for CSV validation", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const response = await POST(requestWithUpload("apollo.txt", "not csv", {
      type: "text/plain",
      sourceFile: "spoofed.csv",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Upload an Apollo CSV file" });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("rejects uploaded files whose actual filename is not a CSV before writing the file", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const textResponse = await POST(requestWithUpload("apollo.txt", "Email\nlead@example.com\n"));

    expect(textResponse.status).toBe(400);
    expect(await textResponse.json()).toEqual({ error: "Upload an Apollo CSV file" });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(enqueueIngestCsvJobMock).not.toHaveBeenCalled();
  });

  it("stores a valid CSV and queues an ingest_csv job for the server tenant", async () => {
    vi.stubEnv("TENANT_ID", "11111111-1111-4111-8111-111111111111");
    vi.stubEnv("DASHBOARD_UPLOAD_DIR", "C:\\printeriq\\uploads");
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const response = await POST(requestWithUpload("Apollo Export.csv", "Email,First Name\nlead@example.com,Darren\n"));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({
      message: "Import queued",
      jobId: "job-1",
      sourceFile: "Apollo Export.csv",
    });
    expect(mkdirMock).toHaveBeenCalledWith("C:\\printeriq\\uploads", { recursive: true });
    expect(writeFileMock).toHaveBeenCalledOnce();
    expect(enqueueIngestCsvJobMock).toHaveBeenCalledWith({
      tenantId: "11111111-1111-4111-8111-111111111111",
      filePath: expect.stringContaining("Apollo_Export.csv"),
      sourceFile: "Apollo Export.csv",
      vertical: "tradies",
      dryRun: false,
      scoreThreshold: 40,
    });
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("uses the uploaded file name for import metadata instead of sourceFile", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const response = await POST(requestWithUpload("actual.csv", "Email\nlead@example.com\n", {
      sourceFile: "spoofed.csv",
    }));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.sourceFile).toBe("actual.csv");
    expect(enqueueIngestCsvJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFile: "actual.csv",
        filePath: expect.stringContaining("actual.csv"),
      }),
    );
  });

  it("normalizes unsafe uploaded file names before queueing metadata", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });

    const response = await POST(requestWithUpload("../Lead Export.csv", "Email\nlead@example.com\n"));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.sourceFile).toBe("Lead Export.csv");
    expect(enqueueIngestCsvJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFile: "Lead Export.csv",
        filePath: expect.stringContaining("Lead_Export.csv"),
      }),
    );
  });

  it("caps long uploaded file names before building the upload path", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    const longFileName = `${"a".repeat(300)}.csv`;

    const response = await POST(requestWithUpload(longFileName, "Email\nlead@example.com\n"));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.sourceFile).toHaveLength(120);
    expect(body.sourceFile.endsWith(".csv")).toBe(true);
    expect(enqueueIngestCsvJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFile: body.sourceFile,
        filePath: expect.stringMatching(/a+\.csv$/),
      }),
    );
  });

  it("cleans up the upload and returns JSON conflict when an ingest job is already active", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    enqueueIngestCsvJobMock.mockResolvedValue({ id: "existing-job", acquired: false });

    const response = await POST(requestWithUpload("apollo.csv", "Email\nlead@example.com\n"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "An import is already queued or running",
      jobId: "existing-job",
    });
    expect(unlinkMock).toHaveBeenCalledOnce();
  });

  it("returns JSON cleanup failure when an active import blocks the upload and deletion fails", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    enqueueIngestCsvJobMock.mockResolvedValue({ id: "existing-job", acquired: false });
    unlinkMock.mockRejectedValue(new Error("permission denied"));

    const response = await POST(requestWithUpload("apollo.csv", "Email\nlead@example.com\n"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to clean up uploaded CSV" });
  });

  it("returns JSON when queueing fails after upload validation", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    enqueueIngestCsvJobMock.mockRejectedValue(new Error("database down"));

    const response = await POST(requestWithUpload("apollo.csv", "Email\nlead@example.com\n"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to queue import" });
    expect(unlinkMock).toHaveBeenCalledOnce();
  });

  it("returns JSON cleanup failure when queueing fails and deletion fails", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@presciaiq.com" } } });
    enqueueIngestCsvJobMock.mockRejectedValue(new Error("database down"));
    unlinkMock.mockRejectedValue(new Error("permission denied"));

    const response = await POST(requestWithUpload("apollo.csv", "Email\nlead@example.com\n"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to clean up uploaded CSV" });
  });
});
