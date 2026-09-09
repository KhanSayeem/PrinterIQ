"use client";

export default function RepliesError() {
  return <div className="error-state">Failed to load replies. Check DATABASE_URL and Supabase connectivity.</div>;
}
