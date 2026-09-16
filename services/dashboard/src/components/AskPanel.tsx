"use client";

import { Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AgentChat,
  type AgentMessage,
  type ChatStatus,
  type MessagePart,
} from "@/components/ui/agent-chat";
import type { SuggestionItem } from "@/components/ui/suggestions";
import { createAskEventParser } from "@/lib/ask/client-stream";

/**
 * Ask anything about the pipeline, in a panel that opens over whatever page
 * you are on.
 *
 * It only answers when asked. It does not watch, poll or notify: the alarms
 * and the reply agent already do that, and a second thing shouting would make
 * both easier to ignore.
 *
 * Every read it makes is shown with the answer, collapsed, so a number can be
 * checked rather than trusted.
 */

const SUGGESTIONS: SuggestionItem[] = [
  { id: "today", label: "How is sending going today?" },
  { id: "replies", label: "Anything waiting on me?" },
  { id: "broken", label: "Is anything broken right now?" },
  { id: "bounces", label: "Which mailboxes are bouncing?" },
  { id: "money", label: "What came in this week?" },
];

let messageCounter = 0;
function nextMessageId(): string {
  messageCounter += 1;
  return `ask-${Date.now()}-${messageCounter}`;
}

export function AskPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<{ message: string; title?: string } | undefined>();
  const conversationIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("ready");
  }, []);

  const send = useCallback(async ({ content }: { role: "user"; content: string }) => {
    setError(undefined);

    const history = messages.flatMap((message) => {
      const text = message.parts
        .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();

      return text.length > 0 ? [{ role: message.role, content: text }] : [];
    });

    const answerId = nextMessageId();

    setMessages((current) => [
      ...current,
      { id: nextMessageId(), role: "user", parts: [{ type: "text", text: content }] },
      { id: answerId, role: "assistant", parts: [] },
    ]);
    setStatus("submitted");

    /** Updates the answer in place, so text and tool calls land in order. */
    const updateAnswer = (update: (parts: MessagePart[]) => MessagePart[]) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === answerId ? { ...message, parts: update([...message.parts]) } : message,
        ),
      );
    };

    const appendText = (text: string) => {
      updateAnswer((parts) => {
        const last = parts[parts.length - 1];
        if (last && last.type === "text") {
          parts[parts.length - 1] = { type: "text", text: last.text + text };
          return parts;
        }
        return [...parts, { type: "text", text }];
      });
    };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: content,
          conversationId: conversationIdRef.current,
          history,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response
          .json()
          .then((body: { error?: string }) => body.error)
          .catch(() => undefined);
        throw new Error(detail ?? `The dashboard returned ${response.status}.`);
      }

      setStatus("streaming");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createAskEventParser();

      /** Tool calls are keyed by id, because results come back out of order. */
      const toolIndexById = new Map<string, number>();

      const handle = (event: ReturnType<typeof parser.push>[number]) => {
        if (event.type === "conversation") {
          conversationIdRef.current = event.conversationId;
          return;
        }

        if (event.type === "text") {
          appendText(event.text);
          return;
        }

        if (event.type === "tool_start") {
          updateAnswer((parts) => {
            toolIndexById.set(event.id, parts.length);
            return [
              ...parts,
              {
                type: "tool",
                name: event.name,
                state: "running",
                input: (event.input ?? {}) as Record<string, unknown>,
              },
            ];
          });
          return;
        }

        if (event.type === "tool_end") {
          updateAnswer((parts) => {
            const index = toolIndexById.get(event.id);
            if (index === undefined) {
              return parts;
            }
            const existing = parts[index];
            if (!existing || existing.type !== "tool") {
              return parts;
            }
            parts[index] = {
              ...existing,
              state: event.failed ? "error" : "completed",
              ...(event.failed ? { error: event.output } : { output: event.output }),
            };
            return parts;
          });
          return;
        }

        if (event.type === "error") {
          setError({ title: "The answer stopped", message: event.message });
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          handle(event);
        }
      }

      for (const event of parser.flush()) {
        handle(event);
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        appendText("\n\n(stopped)");
      } else {
        setError({
          title: "Could not get an answer",
          message: caught instanceof Error ? caught.message : "Unknown error",
        });
      }
    } finally {
      abortRef.current = null;
      setStatus("ready");
    }
  }, [messages]);

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost topbar-ask"
        aria-label="Ask about the pipeline"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Sparkles size={14} aria-hidden="true" />
        Ask
      </button>

      {open ? (
        <>
          <button
            type="button"
            className="ask-backdrop"
            aria-label="Close the ask panel"
            onClick={() => setOpen(false)}
          />
          <aside className="ask-panel" role="dialog" aria-modal="true" aria-label="Ask about the pipeline">
            <header className="ask-panel-header">
              <div>
                <div className="ask-panel-title">Ask</div>
                <div className="ask-panel-subtitle">Reads only. It cannot send or change anything.</div>
              </div>
              <button
                type="button"
                className="btn btn-ghost ask-panel-close"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <div className="ask-panel-body">
              <AgentChat
                messages={messages}
                onSend={send}
                onStop={stop}
                status={status}
                error={error}
                emptyStatePosition={messages.length === 0 ? "center" : "default"}
                suggestions={SUGGESTIONS}
              />
            </div>
          </aside>
        </>
      ) : null}
    </>
  );
}
