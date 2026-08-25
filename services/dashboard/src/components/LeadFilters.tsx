"use client";

import type { PreviewViewFilter } from "@/lib/lead-list-params";

type LeadFilterCounts = {
  all: number;
  qualified: number;
  replied: number;
  paid: number;
  archived: number;
  unsubscribed: number;
  previewSeen: number;
  previewUnseen: number;
};

export type LeadFilterSelection = {
  status?: string;
  unsubscribed?: boolean;
};

const filters = [
  { label: "All", key: "all", selection: {} },
  { label: "Qualified", key: "qualified", selection: { status: "qualified" } },
  { label: "Replied", key: "replied", selection: { status: "replied" } },
  { label: "Paid", key: "paid", selection: { status: "paid" } },
  { label: "Archived", key: "archived", selection: { status: "archived" } },
  { label: "Unsubscribed", key: "unsubscribed", selection: { unsubscribed: true } },
] as const satisfies ReadonlyArray<{
  label: string;
  key: keyof LeadFilterCounts;
  selection: LeadFilterSelection;
}>;

// Open and click tracking are off for deliverability, so a preview view is the
// only engagement signal the operator has.
const previewFilters = [
  { label: "Preview seen", key: "previewSeen", value: "seen" },
  { label: "Preview unseen", key: "previewUnseen", value: "unseen" },
] as const satisfies ReadonlyArray<{
  label: string;
  key: keyof LeadFilterCounts;
  value: PreviewViewFilter;
}>;

export function LeadFilters({
  activeStatus,
  activeUnsubscribed,
  activePreviewView,
  searchValue,
  counts,
  pending,
  onSelect,
  onPreviewSelect,
  onSearchChange,
}: {
  activeStatus?: string;
  activeUnsubscribed?: boolean;
  activePreviewView?: PreviewViewFilter;
  searchValue: string;
  counts: LeadFilterCounts;
  pending?: boolean;
  onSelect: (selection: LeadFilterSelection) => void;
  onPreviewSelect: (previewView?: PreviewViewFilter) => void;
  onSearchChange: (value: string) => void;
}) {
  function isActive(selection: LeadFilterSelection) {
    if (selection.unsubscribed) return Boolean(activeUnsubscribed);
    if (selection.status) return !activeUnsubscribed && activeStatus === selection.status;
    return !activeUnsubscribed && !activeStatus;
  }

  return (
    <div className="filters">
      <input
        className="search-input"
        placeholder="Search leads"
        value={searchValue}
        onChange={(event) => onSearchChange(event.target.value)}
      />
      {filters.map((filter) => (
        <button
          key={filter.key}
          type="button"
          className={`pill ${isActive(filter.selection) ? "active" : ""}`}
          onClick={() => onSelect(filter.selection)}
          disabled={pending}
        >
          {filter.label}
          <span className="filter-count">{counts[filter.key]}</span>
        </button>
      ))}
      <span className="filter-divider" aria-hidden="true" />
      {previewFilters.map((filter) => {
        const active = activePreviewView === filter.value;
        return (
          <button
            key={filter.key}
            type="button"
            className={`pill ${active ? "active" : ""}`}
            aria-pressed={active}
            onClick={() => onPreviewSelect(active ? undefined : filter.value)}
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
