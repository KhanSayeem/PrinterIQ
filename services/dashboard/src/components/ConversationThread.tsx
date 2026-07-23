import { useState } from "react";
import { Trash2 } from "lucide-react";

type Conversation = {
  id: string;
  direction: string;
  channel: string;
  body: string;
  createdAt: Date | string;
};

function directionClass(direction: string) {
  if (direction === "inbound") return { pill: "dir-in", bubble: "bubble-in" };
  if (direction === "note") return { pill: "dir-note", bubble: "bubble-note" };
  return { pill: "dir-out", bubble: "bubble-out" };
}

function formatRelativeTime(createdAt: Date | string, now: Date) {
  const created = new Date(createdAt);
  const diffMs = Math.max(now.getTime() - created.getTime(), 0);
  const minutes = Math.max(Math.floor(diffMs / 60000), 0);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function ConversationThread({
  conversations,
  now = new Date(),
  onDeleteNote,
}: {
  conversations: Conversation[];
  now?: Date;
  onDeleteNote?: (conversationId: string) => void;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  if (conversations.length === 0) {
    return <div className="empty-state">No conversations yet. Replies will appear here after outreach starts.</div>;
  }

  return (
    <div>
      {conversations.map((conversation) => {
        const classes = directionClass(conversation.direction);
        return (
          <div className="convo-item" key={conversation.id}>
            <div className="convo-item-meta">
              <span className={`convo-dir ${classes.pill}`}>{conversation.direction}</span>
              {conversation.direction !== "note" ? <span>{conversation.channel}</span> : null}
              <span>{formatRelativeTime(conversation.createdAt, now)}</span>
              {conversation.direction === "note" && onDeleteNote ? (
                <span className="convo-note-delete">
                  <button
                    className="dp-icon-btn"
                    type="button"
                    title="Delete note"
                    aria-label="Delete note"
                    onClick={() => setConfirmingId(conversation.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                  {confirmingId === conversation.id ? (
                    <span className="delete-confirm">
                      Delete this note?
                      <button
                        type="button"
                        aria-label="Confirm delete note"
                        onClick={() => onDeleteNote(conversation.id)}
                      >
                        Confirm
                      </button>
                      <button type="button" onClick={() => setConfirmingId(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
            <div className={`convo-bubble ${classes.bubble}`}>{conversation.body}</div>
          </div>
        );
      })}
    </div>
  );
}
