"use client";

export default function PipelineError({ error }: { error: Error }) {
  return (
    <div className="error-state">
      Failed to load pipeline data.
      {process.env.NODE_ENV !== "production" ? <div className="error-detail">{error.message}</div> : null}
    </div>
  );
}
