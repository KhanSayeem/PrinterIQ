"use client";

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
  pending,
  onSelect,
}: {
  activeStatus?: string;
  counts: LeadFilterCounts;
  pending?: boolean;
  onSelect: (status?: string) => void;
}) {
  return (
    <div className="filters">
      <input className="search-input" placeholder="Search leads" readOnly />
      {filters.map((filter) => {
        const active = filter.status ? activeStatus === filter.status : !activeStatus;
        return (
          <button
            key={filter.key}
            type="button"
            className={`pill ${active ? "active" : ""}`}
            onClick={() => onSelect(filter.status)}
            disabled={pending}
          >
            {filter.label}
            <span className="filter-count">{counts[filter.key]}</span>
          </button>
        );
      })}
    </div>
  );
}
