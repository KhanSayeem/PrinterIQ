"use client";

/**
 * A tool call, collapsed to a row and expandable to its input and result.
 * From 21st.dev ("AI Tool Call" by elements-), kept as fetched.
 * https://21st.dev/@elements-/components/tool-call
 *
 * This is the honesty surface of the ask panel: every figure the answer quotes
 * has a row here showing which read produced it, so a number can be traced
 * rather than trusted.
 */
import * as React from "react";

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock,
  Loader2,
  ShieldQuestion,
  Wrench,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";

type ToolCallState =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "awaiting-approval"
  | "denied";

interface AiToolCallContextValue {
  name: string;
  state: ToolCallState;
  isOpen: boolean;
}

const AiToolCallContext = React.createContext<AiToolCallContextValue | null>(null);

function useToolCallContext() {
  const context = React.useContext(AiToolCallContext);
  if (!context) {
    throw new Error("AiToolCall components must be used within <AiToolCall>");
  }
  return context;
}

interface AiToolCallProps {
  name: string;
  state: ToolCallState;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
  className?: string;
}

function AiToolCall({
  name,
  state,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  children,
  className,
}: AiToolCallProps) {
  /** null until the operator opens or closes it themselves, and then it wins. */
  const [toggledOpen, setToggledOpen] = React.useState<boolean | null>(null);

  const isControlled = controlledOpen !== undefined;

  // Derived rather than set in an effect, so a failed read is open on its
  // first render instead of after a second one.
  //
  // Deliberately NOT auto-opening on completed: the panel shows many reads per
  // answer and opening all of them buries the answer itself. An error is worth
  // opening, because the operator has to see which read failed and why.
  const autoOpen = state === "error" ? true : defaultOpen;
  const isOpen = isControlled ? controlledOpen : (toggledOpen ?? autoOpen);

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      if (!isControlled) {
        setToggledOpen(open);
      }
      onOpenChange?.(open);
    },
    [isControlled, onOpenChange],
  );

  const contextValue = React.useMemo(
    () => ({ name, state, isOpen }),
    [name, state, isOpen],
  );

  return (
    <AiToolCallContext.Provider value={contextValue}>
      <CollapsiblePrimitive.Root
        data-slot="ai-tool-call"
        open={isOpen}
        onOpenChange={handleOpenChange}
        className={cn(
          "rounded-lg border border-border bg-card text-card-foreground overflow-hidden",
          className,
        )}
      >
        {children}
      </CollapsiblePrimitive.Root>
    </AiToolCallContext.Provider>
  );
}

function AiToolCallHeader({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  const { name, state, isOpen } = useToolCallContext();

  const stateConfig = React.useMemo(() => {
    const configs: Record<
      ToolCallState,
      { icon: React.ReactNode; label: string; className: string }
    > = {
      pending: {
        icon: <Clock className="size-3.5" />,
        label: "Pending",
        className: "bg-muted text-muted-foreground",
      },
      running: {
        icon: <Loader2 className="size-3.5 animate-spin" />,
        label: "Running",
        className: "bg-blue-100 text-blue-700",
      },
      completed: {
        icon: <Check className="size-3.5" />,
        label: "Read",
        className: "bg-green-100 text-green-700",
      },
      error: {
        icon: <X className="size-3.5" />,
        label: "Failed",
        className: "bg-red-100 text-red-700",
      },
      "awaiting-approval": {
        icon: <ShieldQuestion className="size-3.5" />,
        label: "Awaiting approval",
        className: "bg-amber-100 text-amber-700",
      },
      denied: {
        icon: <AlertTriangle className="size-3.5" />,
        label: "Denied",
        className: "bg-orange-100 text-orange-700",
      },
    };
    return configs[state];
  }, [state]);

  return (
    <CollapsiblePrimitive.Trigger
      data-slot="ai-tool-call-header"
      className={cn(
        "flex w-full items-center gap-3 px-4 py-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <Wrench className="size-4 text-muted-foreground" />
      </div>
      <div className="flex flex-1 items-center gap-2 text-left">
        <span className="font-mono text-sm">{name}</span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
            stateConfig.className,
          )}
        >
          {stateConfig.icon}
          {stateConfig.label}
        </span>
      </div>
      {children}
      <ChevronDown
        className={cn(
          "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
          isOpen && "rotate-180",
        )}
      />
    </CollapsiblePrimitive.Trigger>
  );
}

function AiToolCallContent({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <CollapsiblePrimitive.Content
      data-slot="ai-tool-call-content"
      className={cn("border-t border-border", className)}
    >
      <div className="p-4 space-y-4">{children}</div>
    </CollapsiblePrimitive.Content>
  );
}

function AiToolCallInput({
  input,
  className,
}: {
  input: Record<string, unknown>;
  className?: string;
}) {
  const formattedJson = React.useMemo(() => JSON.stringify(input, null, 2), [input]);

  return (
    <div data-slot="ai-tool-call-input" className={cn("space-y-1.5", className)}>
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Asked
      </span>
      <pre className="rounded-md bg-muted p-3 overflow-x-auto text-xs font-mono text-foreground">
        {formattedJson}
      </pre>
    </div>
  );
}

function AiToolCallOutput({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="ai-tool-call-output" className={cn("space-y-1.5", className)}>
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Came back
      </span>
      <div className="rounded-md bg-muted p-3 overflow-x-auto text-sm">{children}</div>
    </div>
  );
}

function AiToolCallError({ error, className }: { error: string; className?: string }) {
  return (
    <div data-slot="ai-tool-call-error" className={cn("space-y-1.5", className)}>
      <span className="text-xs font-medium text-red-600 uppercase tracking-wider">Error</span>
      <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
        {error}
      </div>
    </div>
  );
}

export {
  AiToolCall,
  AiToolCallHeader,
  AiToolCallContent,
  AiToolCallInput,
  AiToolCallOutput,
  AiToolCallError,
};
export type { AiToolCallProps, ToolCallState };
