"use client";

/**
 * The chat shell: scrolling message list with a composer at the bottom.
 * From 21st.dev Agent Elements ("Agent Chat" by serafimcloud).
 *
 * Two changes from the fetched version, both marked below:
 *  - a `tool` message part, rendered with the tool call component, so every
 *    read behind an answer is visible next to it;
 *  - suggestion chips in the empty state, so the panel opens showing what it
 *    can answer rather than a blank box.
 */
import {
  memo,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import {
  AiToolCall,
  AiToolCallContent,
  AiToolCallError,
  AiToolCallHeader,
  AiToolCallInput,
  AiToolCallOutput,
  type ToolCallState,
} from "./tool-call";
import { Suggestions, type SuggestionItem } from "./suggestions";

export type ChatStatus = "ready" | "streaming" | "submitted" | "idle";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "error"; title?: string; message: string }
  /** Added: one read the answer stands on. */
  | {
      type: "tool";
      name: string;
      state: ToolCallState;
      input?: Record<string, unknown>;
      output?: string;
      error?: string;
    };

export type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
};

export type AgentChatProps = {
  messages: AgentMessage[];
  onSend?: (message: { role: "user"; content: string }) => void;
  onStop?: () => void;
  status?: ChatStatus;
  error?: { message: string; title?: string };
  emptyStatePosition?: "default" | "center";
  /** Added: chips shown with the empty state. */
  suggestions?: SuggestionItem[];
  className?: string;
};

const SendIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);

const StopIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="1" />
  </svg>
);

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl bg-muted px-3.5 py-2 text-sm text-foreground whitespace-pre-wrap break-words">
        {text}
      </div>
    </div>
  );
}

function AssistantText({ text }: { text: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
        {text}
      </div>
    </div>
  );
}

function ErrorBubble({
  title = "Something went wrong",
  message,
}: {
  title?: string;
  message: string;
}) {
  return (
    <div className="flex justify-start">
      <div className="rounded-[8px] border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm">
        <div className="font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-muted-foreground">{message}</div>
      </div>
    </div>
  );
}

/** Added: a read, collapsed by default, expandable to what was asked and what came back. */
function ToolPart({ part }: { part: Extract<MessagePart, { type: "tool" }> }) {
  const hasDetail =
    part.input !== undefined || part.output !== undefined || part.error !== undefined;

  return (
    <AiToolCall name={part.name} state={part.state}>
      <AiToolCallHeader />
      {hasDetail ? (
        <AiToolCallContent>
          {part.input !== undefined ? <AiToolCallInput input={part.input} /> : null}
          {part.output !== undefined ? (
            <AiToolCallOutput>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                {part.output}
              </pre>
            </AiToolCallOutput>
          ) : null}
          {part.error !== undefined ? <AiToolCallError error={part.error} /> : null}
        </AiToolCallContent>
      ) : null}
    </AiToolCall>
  );
}

function MessageList({ messages }: { messages: AgentMessage[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    /** jsdom has no scrollIntoView, so this is checked rather than assumed. */
    if (typeof endRef.current?.scrollIntoView === "function") {
      endRef.current.scrollIntoView({ block: "end" });
    }
  }, [messages]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
      <div className="mx-auto flex max-w-[640px] flex-col gap-4">
        {messages.map((message) => (
          <div key={message.id} className="flex flex-col gap-2">
            {message.parts.map((part, index) => {
              if (part.type === "error") {
                return <ErrorBubble key={index} title={part.title} message={part.message} />;
              }
              if (part.type === "tool") {
                return <ToolPart key={index} part={part} />;
              }
              if (message.role === "user") {
                return <UserBubble key={index} text={part.text} />;
              }
              return <AssistantText key={index} text={part.text} />;
            })}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function InputBar({
  onSend,
  onStop,
  status = "ready",
  placeholder = "Ask about sending, leads, replies or anything broken...",
  className,
  value: controlledValue,
  onChange,
  disabled,
}: {
  onSend?: (message: { role: "user"; content: string }) => void;
  onStop?: () => void;
  status?: ChatStatus;
  placeholder?: string;
  className?: string;
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  const [internal, setInternal] = useState("");
  const isControlled = controlledValue !== undefined;
  const input = isControlled ? controlledValue : internal;
  const setInput = useCallback(
    (value: string) => {
      if (isControlled) {
        onChange?.(value);
      } else {
        setInternal(value);
      }
    },
    [isControlled, onChange],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = status === "streaming" || status === "submitted";
  const hasInput = input.trim().length > 0;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    element.style.height = "0";
    const next = Math.min(element.scrollHeight, 120);
    element.style.height = `${next}px`;
    element.style.overflowY = element.scrollHeight > 120 ? "auto" : "hidden";
  }, [input]);

  const submit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming || disabled) {
      return;
    }
    onSend?.({ role: "user", content: trimmed });
    setInput("");
  }, [input, isStreaming, disabled, onSend, setInput]);

  return (
    <div className={cn("w-full shrink-0 px-3 pb-3", className)}>
      <div className="mx-auto max-w-[640px]">
        <div
          className="relative cursor-text rounded-[16px] bg-card shadow-sm ring-1 ring-border"
          onClick={(event) => {
            if (!(event.target as HTMLElement).closest("button, textarea")) {
              textareaRef.current?.focus();
            }
          }}
        >
          <div className="min-h-[44px] pt-3 pr-3 pb-0 pl-3.5">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={placeholder}
              disabled={disabled}
              rows={1}
              aria-label="Ask a question"
              className={cn(
                "w-full resize-none overflow-hidden border-0 bg-transparent text-[14px] leading-[1.6] text-foreground outline-none placeholder:text-muted-foreground",
                disabled && "cursor-not-allowed opacity-50",
              )}
            />
          </div>
          <div className="flex items-center justify-end gap-3 px-2 pt-1 pb-2">
            <button
              type="button"
              aria-label={isStreaming ? "Stop" : "Send"}
              onClick={() => {
                if (isStreaming) {
                  onStop?.();
                } else if (hasInput) {
                  submit();
                }
              }}
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center rounded-full transition-all duration-150",
                isStreaming || hasInput
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {isStreaming ? <StopIcon /> : <SendIcon />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export const AgentChat = memo(function AgentChat({
  messages,
  onSend,
  onStop,
  status = "ready",
  error,
  emptyStatePosition = "default",
  suggestions = [],
  className,
}: AgentChatProps) {
  const [draft, setDraft] = useState("");

  const messagesWithError: AgentMessage[] = useMemo(() => {
    if (!error) {
      return messages;
    }
    return [
      ...messages,
      {
        id: "agent-chat-error",
        role: "assistant" as const,
        parts: [
          {
            type: "error" as const,
            title: error.title ?? "Request failed",
            message: error.message,
          },
        ],
      },
    ];
  }, [messages, error]);

  const isEmpty = !error && messages.length === 0;
  const isCenteredEmpty = isEmpty && emptyStatePosition === "center";

  const inputBar: ReactNode = (
    <InputBar
      onSend={onSend}
      onStop={onStop}
      status={status}
      value={draft}
      onChange={setDraft}
      className={isCenteredEmpty ? "px-0 pb-0" : undefined}
    />
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {isCenteredEmpty ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-4">
          <div className="w-full max-w-[640px]">
            {inputBar}
            {/* Added: the panel opens saying what it can answer. */}
            {suggestions.length > 0 ? (
              <Suggestions
                items={suggestions}
                onSelect={(item) => setDraft(item.value ?? item.label)}
                className="justify-center px-3 pt-3"
              />
            ) : null}
          </div>
        </div>
      ) : (
        <MessageList messages={messagesWithError} />
      )}
      {!isCenteredEmpty && inputBar}
    </div>
  );
});

export default AgentChat;
