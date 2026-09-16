"use client";

/**
 * Quick prompt chips. From 21st.dev Agent Elements ("Suggestions" by
 * serafimcloud), kept as fetched so upstream fixes are easy to diff in.
 * https://21st.dev/@serafimcloud/components/suggestions
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SuggestionItem = {
  id: string;
  label: string;
  value?: string;
  icon?: ReactNode;
  className?: string;
};

export type SuggestionsProps = {
  items: SuggestionItem[];
  onSelect: (item: SuggestionItem) => void;
  disabled?: boolean;
  className?: string;
  itemClassName?: string;
};

export function Suggestions({
  items,
  onSelect,
  disabled,
  className,
  itemClassName,
}: SuggestionsProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(item)}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-[6px] border border-border bg-transparent px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:pointer-events-none",
            itemClassName,
            item.className,
          )}
        >
          {item.icon && <span className="inline-flex shrink-0">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>
  );
}
