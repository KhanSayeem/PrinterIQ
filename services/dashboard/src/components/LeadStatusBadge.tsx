const knownStatuses = new Set(["imported", "enriched", "qualified", "contacted", "replied", "paid", "archived"]);

export function LeadStatusBadge({ status }: { status: string }) {
  const normalized = knownStatuses.has(status) ? status : "imported";
  return <span className={`badge s-${normalized}`}>{status}</span>;
}
