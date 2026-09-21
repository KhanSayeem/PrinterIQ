/**
 * The part of a database error worth logging.
 *
 * Drizzle wraps the driver's error: `message` is "Failed query: <the SQL>",
 * and the reason (a timeout, a dropped connection, `max clients reached`) is on
 * `cause`. The leads page logged only the message, so 231 failures in a week
 * said which query failed and never why. The cause is clamped and has emails
 * masked, because a Postgres error can quote the value it rejected.
 */

const MAX_LENGTH = 240;

function mask(text: string): string {
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").slice(0, MAX_LENGTH);
}

export type DbErrorSummary = {
  readonly query: string;
  readonly cause: string;
  readonly code: string | null;
};

export function describeDbError(error: unknown): DbErrorSummary {
  if (!(error instanceof Error)) {
    return { query: "unknown", cause: "unknown error", code: null };
  }

  const cause = (error as { cause?: unknown }).cause;
  const causeMessage =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "no cause recorded";
  const code =
    cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : null;

  // The first line of the query is enough to recognise it; params are dropped.
  const firstLine = error.message.split("\n")[0] ?? error.message;

  return { query: mask(firstLine), cause: mask(causeMessage), code };
}
