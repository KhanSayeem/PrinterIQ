"use client";

import { useState, useTransition } from "react";
import { MessageSquarePlus, Pause, PauseCircle, Reply, StickyNote, X } from "lucide-react";
import {
  addNote,
  overrideReply,
  pauseLead,
} from "@/app/actions/lead-actions";
import { initialLeadActionState, type LeadActionState } from "@/app/actions/lead-actions-core";
import { LeadStatusBadge } from "./LeadStatusBadge";

type Conversation = {
  id: string;
  leadId?: string;
  direction: string;
  channel: string;
  body: string;
  createdAt: Date | string;
};

export type LeadActions = {
  addNote: (previousState: LeadActionState, formData: FormData) => Promise<LeadActionState>;
  overrideReply: (previousState: LeadActionState, formData: FormData) => Promise<LeadActionState>;
  pauseLead: (previousState: LeadActionState, formData: FormData) => Promise<LeadActionState>;
};

const defaultActions: LeadActions = {
  addNote,
  overrideReply,
  pauseLead,
};

export function OperatorActionButtons({
  tenantId,
  leadId,
  initialStatus,
  score,
  actions = defaultActions,
  onConversationCreated,
  compact = false,
}: {
  tenantId: string;
  leadId: string;
  initialStatus: string;
  score: number | null;
  actions?: LeadActions;
  onConversationCreated: (conversation: Conversation) => void;
  compact?: boolean;
}) {
  const [noteBody, setNoteBody] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [message, setMessage] = useState("");
  const [openDrawer, setOpenDrawer] = useState<"note" | "reply" | null>(null);
  const [isPending, startTransition] = useTransition();

  function applyResult(result: LeadActionState) {
    setMessage(result.message);
    if (result.status) {
      setStatus(result.status);
    }
    if (result.conversation) {
      onConversationCreated(result.conversation);
    }
  }

  function run(
    action: (previousState: LeadActionState, formData: FormData) => Promise<LeadActionState>,
    formData: FormData,
    onSuccess?: () => void,
  ) {
    startTransition(async () => {
      try {
        const result = await action(initialLeadActionState, formData);
        applyResult(result);
        if (result.ok) {
          onSuccess?.();
        }
      } catch {
        setMessage("Action failed. Check Instantly and database connectivity.");
      }
    });
  }

  const actionButtonClass = compact ? "btn btn-ghost operator-compact-btn" : "btn btn-ghost";
  const NoteIcon = compact ? StickyNote : MessageSquarePlus;
  const PauseIcon = compact ? PauseCircle : Pause;
  const noteLabel = compact ? "note" : "Add note";
  const replyLabel = compact ? "reply" : "Override reply";
  const pauseLabel = compact ? "pause" : "Pause lead";

  return (
    <div className={compact ? "operator-actions-panel compact" : "operator-actions-panel"}>
      <div className={compact ? "lead-detail-actions compact" : "lead-detail-actions"}>
        {compact ? null : <LeadStatusBadge status={status} />}
        {compact ? null : <span className="lead-detail-score-pill">score {score ?? "N/A"} / 100</span>}
        <button
          className={actionButtonClass}
          type="button"
          disabled={isPending}
          onClick={() => setOpenDrawer(openDrawer === "note" ? null : "note")}
        >
          <NoteIcon size={compact ? 18 : 14} />
          {noteLabel}
        </button>
        <button
          className={actionButtonClass}
          type="button"
          disabled={isPending}
          onClick={() => setOpenDrawer(openDrawer === "reply" ? null : "reply")}
        >
          <Reply size={compact ? 18 : 14} />
          {replyLabel}
        </button>
        <button
          className={actionButtonClass}
          type="button"
          disabled={isPending}
          onClick={() => {
            if (window.confirm("Are you sure? This will stop all automated sends for this lead.")) {
              const formData = new FormData();
              formData.set("leadId", leadId);
              run(actions.pauseLead, formData);
            }
          }}
        >
          <PauseIcon size={compact ? 18 : 14} />
          {pauseLabel}
        </button>
      </div>

      {openDrawer === "note" ? (
        <form
          className="operator-action-drawer"
          action={(formData) => run(actions.addNote, formData, () => setNoteBody(""))}
        >
          <input type="hidden" name="leadId" value={leadId} />
          <div className="operator-drawer-header">
            <label className="form-label" htmlFor="operator-note">Add note</label>
            <button className="dp-icon-btn" type="button" aria-label="Close note drawer" onClick={() => setOpenDrawer(null)}>
              <X size={14} />
            </button>
          </div>
          <textarea
            id="operator-note"
            name="body"
            className="form-input operator-textarea"
            value={noteBody}
            onChange={(event) => setNoteBody(event.target.value)}
          />
          <button className="btn btn-primary" type="submit" disabled={isPending}>Submit note</button>
        </form>
      ) : null}

      {openDrawer === "reply" ? (
        <form
          className="operator-action-drawer"
          action={(formData) => run(actions.overrideReply, formData, () => setReplyBody(""))}
        >
          <input type="hidden" name="leadId" value={leadId} />
          <div className="operator-drawer-header">
            <label className="form-label" htmlFor="operator-reply">Override reply</label>
            <button className="dp-icon-btn" type="button" aria-label="Close reply drawer" onClick={() => setOpenDrawer(null)}>
              <X size={14} />
            </button>
          </div>
          <textarea
            id="operator-reply"
            name="body"
            className="form-input operator-textarea"
            value={replyBody}
            onChange={(event) => setReplyBody(event.target.value)}
          />
          <button className="btn btn-primary" type="submit" disabled={isPending}>Submit reply</button>
        </form>
      ) : null}

      {message ? <div className={message.includes("failed") ? "form-error" : "operator-action-message"}>{message}</div> : null}
    </div>
  );
}
