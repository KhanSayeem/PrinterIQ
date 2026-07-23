"use client";

export default function RevenueError({ error }: { error: Error }) {
  return (
    <div className="error-state">
      Failed to load revenue data.
      {process.env.NODE_ENV !== "production" ? <div className="error-detail">{error.message}</div> : null}
    </div>
  );
}
