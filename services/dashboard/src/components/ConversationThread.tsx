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

export function ConversationThread({ conversations }: { conversations: Conversation[] }) {
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
              <span>{conversation.channel}</span>
            </div>
            <div className={`convo-bubble ${classes.bubble}`}>{conversation.body}</div>
          </div>
        );
      })}
    </div>
  );
}
