"use client";

/**
 * The waiting state: a line of status text with a shimmer sweeping through it.
 *
 * Adapted from 21st.dev "AI Text Loading" by @kokonutui.
 * https://21st.dev/@kokonutd/components/ai-text-loading
 *
 * Two changes from upstream. The sweep is a CSS animation rather than
 * motion/react, because one shimmer is not worth an animation library in a
 * dashboard that has none. And the text is the real status, not a cycling list
 * of moods: while a tool is running it names that read, so the wait says what
 * is being read rather than pretending to think.
 */
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

export type AiTextLoadingProps = {
  /** One label, or several to cycle through while nothing more specific is known. */
  texts: string[];
  intervalMs?: number;
  className?: string;
};

export function AiTextLoading({ texts, intervalMs = 2_000, className }: AiTextLoadingProps) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (texts.length <= 1) {
      return;
    }

    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % texts.length);
    }, intervalMs);

    return () => clearInterval(timer);
  }, [texts.length, intervalMs]);

  /** A label can disappear mid cycle, so the index is clamped on every render. */
  const label = texts[index % texts.length] ?? texts[0] ?? "Working";

  return (
    <div className={cn("flex items-center gap-2", className)} role="status" aria-live="polite">
      <span className="ask-shimmer text-sm font-medium">{label}</span>
    </div>
  );
}

export default AiTextLoading;
