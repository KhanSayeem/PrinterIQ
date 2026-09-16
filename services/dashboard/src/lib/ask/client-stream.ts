/**
 * Reads the newline delimited events /api/ask streams back.
 *
 * Split out from the panel so the parsing can be tested without a browser: a
 * chunk boundary can land in the middle of a line, and a half parsed event
 * would either throw or silently drop a tool call.
 */

export type AskStreamEvent =
  | { type: "conversation"; conversationId: string | null }
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; failed: boolean; output: string }
  | { type: "done"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string };

const KNOWN_TYPES = new Set([
  "conversation",
  "text",
  "tool_start",
  "tool_end",
  "done",
  "error",
]);

/**
 * Turns a stream of text chunks into whole events.
 *
 * Holds the tail of a chunk until its newline arrives. A line that is not
 * valid JSON, or carries a type we do not know, is skipped rather than thrown,
 * because one bad line should not lose the answer around it.
 */
export function createAskEventParser(): {
  push: (chunk: string) => AskStreamEvent[];
  flush: () => AskStreamEvent[];
} {
  let buffer = "";

  const parseLine = (line: string): AskStreamEvent | null => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown };
      if (typeof parsed.type !== "string" || !KNOWN_TYPES.has(parsed.type)) {
        return null;
      }
      return parsed as AskStreamEvent;
    } catch {
      return null;
    }
  };

  return {
    push(chunk: string): AskStreamEvent[] {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      return lines.map(parseLine).filter((event): event is AskStreamEvent => event !== null);
    },
    flush(): AskStreamEvent[] {
      const remaining = buffer;
      buffer = "";
      const event = parseLine(remaining);
      return event ? [event] : [];
    },
  };
}
