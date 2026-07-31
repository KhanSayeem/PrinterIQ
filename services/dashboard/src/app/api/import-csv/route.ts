import { randomUUID } from "crypto";
import { mkdir, unlink, writeFile } from "fs/promises";
import path from "path";
import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedOperator } from "@/auth/operators";
import { createSupabaseServerClient } from "@/auth/server";
import { getDashboardTenantId } from "@/auth/tenant";
import { enqueueIngestCsvJob, hasActiveIngestCsvJob } from "@/queue/pipeline";

export const runtime = "nodejs";

const defaultMaxCsvUploadBytes = 50 * 1024 * 1024;
const maxAllowedCsvUploadBytes = 75 * 1024 * 1024;
const maxMultipartOverheadBytes = 1024 * 1024;
const maxCsvFileNameLength = 120;
const contentLengthRequiredMessage = "Content-Length header is required";
const qualificationThresholdMissingMessage = "Qualification score threshold is not configured";
const qualificationThresholdInvalidMessage = "Qualification score threshold must be an integer from 0 to 100";

function uploadRoot() {
  return process.env.DASHBOARD_UPLOAD_DIR ?? path.resolve(process.cwd(), "..", "..", "uploads", "dashboard-imports");
}

function capFileName(fileName: string) {
  if (fileName.length <= maxCsvFileNameLength) {
    return fileName;
  }

  const extension = fileName.toLowerCase().endsWith(".csv") ? ".csv" : "";
  return `${fileName.slice(0, maxCsvFileNameLength - extension.length)}${extension}`;
}

function normalizeCsvFileName(fileName: string) {
  const sanitized = fileName.replace(/[/\\]/g, "_").replace(/[^a-zA-Z0-9 ._-]/g, "_");
  const cleanName = sanitized.replace(/^[._-]+|[._-]+$/g, "") || "apollo.csv";
  return capFileName(cleanName);
}

function toPathSafeCsvFileName(fileName: string) {
  return fileName.replace(/ /g, "_");
}

function isCsvFileName(fileName: string) {
  return fileName.toLowerCase().endsWith(".csv");
}

function readMaxCsvUploadBytes() {
  const configured = process.env.DASHBOARD_MAX_CSV_UPLOAD_BYTES;
  if (!configured) return defaultMaxCsvUploadBytes;
  if (!/^[1-9][0-9]*$/.test(configured)) return defaultMaxCsvUploadBytes;

  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value > maxAllowedCsvUploadBytes) {
    return defaultMaxCsvUploadBytes;
  }

  return value;
}

function readQualificationScoreThreshold() {
  const configured = process.env.QUALIFICATION_SCORE_THRESHOLD?.trim();
  if (!configured) {
    return { error: qualificationThresholdMissingMessage };
  }
  if (!/^(0|[1-9][0-9]*)$/.test(configured)) {
    return { error: qualificationThresholdInvalidMessage };
  }

  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    return { error: qualificationThresholdInvalidMessage };
  }

  return { value };
}

function maxRequestUploadBytes(maxCsvUploadBytes: number) {
  return maxCsvUploadBytes + maxMultipartOverheadBytes;
}

function formatUploadLimitMegabytes(bytes: number) {
  const megabytes = bytes / (1024 * 1024);
  if (Number.isInteger(megabytes)) {
    return String(megabytes);
  }

  return megabytes.toFixed(1).replace(/\.0$/, "");
}

function maxCsvUploadMessage(maxCsvUploadBytes: number) {
  return `CSV file must be ${formatUploadLimitMegabytes(maxCsvUploadBytes)}MB or smaller`;
}

function isUploadedFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "name" in value &&
    "size" in value
  );
}

function readContentLength(request: NextRequest) {
  const header = request.headers.get("content-length");
  if (!header) return null;
  if (!/^[1-9][0-9]*$/.test(header)) return null;

  const value = Number(header);
  return Number.isSafeInteger(value) ? value : null;
}

async function cleanupUploadedFile(filePath: string) {
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    console.error("Failed to clean up uploaded CSV", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return false;
  }
}

export async function POST(request: NextRequest) {
  const maxCsvUploadBytes = readMaxCsvUploadBytes();
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isAuthorizedOperator(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenantId = getDashboardTenantId();
  if (!tenantId) {
    return NextResponse.json({ error: "Dashboard tenant not configured" }, { status: 500 });
  }

  const qualificationThreshold = readQualificationScoreThreshold();
  if ("error" in qualificationThreshold) {
    return NextResponse.json({ error: qualificationThreshold.error }, { status: 500 });
  }

  const contentLength = readContentLength(request);
  if (contentLength === null) {
    return NextResponse.json({ error: contentLengthRequiredMessage }, { status: 411 });
  }

  if (contentLength > maxRequestUploadBytes(maxCsvUploadBytes)) {
    return NextResponse.json({ error: maxCsvUploadMessage(maxCsvUploadBytes) }, { status: 413 });
  }

  try {
    if (await hasActiveIngestCsvJob(tenantId)) {
      return NextResponse.json(
        {
          error: "An import is already queued or running",
          jobId: `import-csv-${tenantId}`,
        },
        { status: 409 },
      );
    }
  } catch (error) {
    console.error("Failed to check active CSV import", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Failed to queue import" }, { status: 500 });
  }

  let writtenFilePath: string | null = null;

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!isUploadedFile(file) || file.size === 0) {
      return NextResponse.json({ error: "CSV file is required" }, { status: 400 });
    }

    if (file.size > maxCsvUploadBytes) {
      return NextResponse.json({ error: maxCsvUploadMessage(maxCsvUploadBytes) }, { status: 413 });
    }

    const sourceFile = normalizeCsvFileName(file.name);

    if (!isCsvFileName(sourceFile)) {
      return NextResponse.json({ error: "Upload an Apollo CSV file" }, { status: 400 });
    }

    const dir = uploadRoot();
    const filePath = path.join(dir, `${Date.now()}-${randomUUID()}-${toPathSafeCsvFileName(sourceFile)}`);
    const buffer = Buffer.from(await file.arrayBuffer());

    await mkdir(dir, { recursive: true });
    await writeFile(filePath, buffer);
    writtenFilePath = filePath;

    let job: Awaited<ReturnType<typeof enqueueIngestCsvJob>>;
    try {
      job = await enqueueIngestCsvJob({
        tenantId,
        filePath,
        sourceFile,
        vertical: "tradies",
        dryRun: false,
        scoreThreshold: qualificationThreshold.value,
      });
    } catch (error) {
      const cleanedUp = await cleanupUploadedFile(filePath);
      if (!cleanedUp) {
        return NextResponse.json({ error: "Failed to clean up uploaded CSV" }, { status: 500 });
      }
      console.error("Failed to queue CSV import", { errorName: error instanceof Error ? error.name : "UnknownError" });
      return NextResponse.json({ error: "Failed to queue import" }, { status: 500 });
    }

    if (!job.acquired) {
      const cleanedUp = await cleanupUploadedFile(filePath);
      if (!cleanedUp) {
        return NextResponse.json({ error: "Failed to clean up uploaded CSV" }, { status: 500 });
      }
      return NextResponse.json(
        {
          error: "An import is already queued or running",
          jobId: job.id,
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        message: "Import queued",
        jobId: job.id,
        sourceFile,
      },
      { status: 202 },
    );
  } catch (error) {
    if (writtenFilePath) {
      const cleanedUp = await cleanupUploadedFile(writtenFilePath);
      if (!cleanedUp) {
        return NextResponse.json({ error: "Failed to clean up uploaded CSV" }, { status: 500 });
      }
    }
    console.error("Failed to queue CSV import", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return NextResponse.json({ error: "Failed to queue import" }, { status: 500 });
  }
}
