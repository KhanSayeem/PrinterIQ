import Link from "next/link";

type LeadFilterCounts = {
  all: number;
  qualified: number;
  replied: number;
  paid: number;
  archived: number;
};

const filters = [
  { label: "All", status: undefined, key: "all" },
  { label: "Qualified", status: "qualified", key: "qualified" },
  { label: "Replied", status: "replied", key: "replied" },
  { label: "Paid", status: "paid", key: "paid" },
  { label: "Archived", status: "archived", key: "archived" },
] as const;

export function LeadFilters({
  activeStatus,
  counts,
}: {
  activeStatus?: string;
  counts: LeadFilterCounts;
}) {
  return (
    <div className="filters">
      <input className="search-input" placeholder="Search leads" readOnly />
      {filters.map((filter) => {
        const active = filter.status ? activeStatus === filter.status : !activeStatus;
        return (
          <Link
            key={filter.key}
            className={`pill ${active ? "active" : ""}`}
            href={filter.status ? `/leads?status=${filter.status}` : "/leads"}
          >
            {filter.label}
            <span className="filter-count">{counts[filter.key]}</span>
          </Link>
        );
      })}
    </div>
  );
}
