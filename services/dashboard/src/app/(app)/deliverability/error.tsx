"use client";

export default function DeliverabilityError({ error }: { error: Error }) {
  return (
    <div className="error-state">
      Failed to load deliverability data from Instantly.
      {process.env.NODE_ENV !== "production" ? <div className="error-detail">{error.message}</div> : null}
    </div>
  );
}
