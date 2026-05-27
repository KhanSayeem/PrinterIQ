import { MessageSquarePlus, Pause, Reply } from "lucide-react";

const title = "Available in a future update";

export function OperatorActionButtons() {
  return (
    <div className="lead-detail-actions">
      {/* TODO: D3 */}
      <button className="btn btn-ghost btn-muted" type="button" disabled title={title}>
        <MessageSquarePlus size={14} />
        Add note
      </button>
      {/* TODO: D3 */}
      <button className="btn btn-ghost btn-muted" type="button" disabled title={title}>
        <Reply size={14} />
        Override reply
      </button>
      {/* TODO: D3 */}
      <button className="btn btn-ghost btn-muted" type="button" disabled title={title}>
        <Pause size={14} />
        Pause lead
      </button>
    </div>
  );
}
