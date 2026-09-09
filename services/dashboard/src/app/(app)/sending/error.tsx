"use client";

export default function SendingError({ error }: { error: Error }) {
  return (
    <div className="error-state">
      Failed to load the send rate control. No daily limit has been changed.
      {process.env.NODE_ENV !== "production" ? <div className="error-detail">{error.message}</div> : null}
    </div>
  );
}
