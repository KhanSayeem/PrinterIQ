import { ExternalLink, MessageSquare, Pause, PenLine, X } from "lucide-react";
import Link from "next/link";
import { LeadStatusBadge } from "./LeadStatusBadge";

export type LeadListRow = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  businessName: string | null;
  city: string | null;
  state: string | null;
  vertical: string | null;
  status: string;
  email: string;
  phone: string | null;
  websiteUrl: string | null;
  score: number | null;
  topWeakness: string | null;
  weaknesses: string[];
  personalisedOpener: string | null;
  latestConversation: {
    id: string;
    direction: string;
    body: string;
    createdAt: Date | string;
  } | null;
  updatedAt: Date | string | null;
};

function displayName(lead: LeadListRow) {
  return [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email;
}

export function LeadQuickPanel({ lead }: { lead: LeadListRow | null }) {
  if (!lead) {
    return <aside className="detail-panel" aria-label="Lead quick panel"><div className="empty-state">Select a lead to preview details.</div></aside>;
  }

  return (
    <aside className="detail-panel" aria-label="Lead quick panel">
      <div className="dp-header">
        <div className="dp-header-top">
          <div>
            <div className="dp-name">{displayName(lead)}</div>
            <div className="dp-sub">
              {lead.businessName ?? "Unknown business"} · {lead.city ?? "Unknown city"}, {lead.state ?? "--"} · {lead.vertical ?? "tradies"}
            </div>
          </div>
          <div className="dp-header-actions">
            <Link className="dp-icon-btn open-page" aria-label="Open full lead page" href={`/leads/${lead.id}`}>
              <ExternalLink size={15} />
            </Link>
          </div>
        </div>
        <div className="dp-meta">
          <LeadStatusBadge status={lead.status} />
          <span className="dp-score">score {lead.score ?? "--"} / 100</span>
        </div>
      </div>
      <div className="dp-actions">
        <button className="btn btn-muted" type="button" disabled title="Available in a future update">
          <PenLine size={13} />
          Note
        </button>
        <button className="btn btn-muted" type="button" disabled title="Available in a future update">
          <MessageSquare size={13} />
          Reply
        </button>
        <button className="btn btn-muted" type="button" disabled title="Available in a future update">
          <Pause size={13} />
          Pause
        </button>
      </div>
      <div className="dp-body">
        <div className="dp-section">
          <div className="dp-section-title">Contact</div>
          <div className="dp-row"><span className="dp-row-label">Email</span><span className="dp-row-value">{lead.email}</span></div>
          <div className="dp-row"><span className="dp-row-label">Phone</span><span className="dp-row-value">{lead.phone ?? "--"}</span></div>
          <div className="dp-row"><span className="dp-row-label">State</span><span className="dp-row-value">{lead.state ?? "--"}</span></div>
          <div className="dp-row"><span className="dp-row-label">Industry</span><span className="dp-row-value">{lead.vertical ?? "--"}</span></div>
        </div>
        <div className="dp-section">
          <div className="dp-section-title">Top weaknesses</div>
          {lead.weaknesses.length ? (
            <div className="weakness-wrap">
              {lead.weaknesses.slice(0, 4).map((weakness) => (
                <span className="w-chip" key={weakness}>{weakness}</span>
              ))}
            </div>
          ) : (
            <div className="dp-empty">No website weaknesses recorded yet.</div>
          )}
        </div>
        <div className="dp-section">
          <div className="dp-section-title">Latest message</div>
          {lead.latestConversation ? (
            <div className="dp-last-msg">
              <div className="dp-msg-meta">
                {formatDirection(lead.latestConversation.direction)} · {formatMessageTime(lead.latestConversation.createdAt)}
              </div>
              {lead.latestConversation.body}
            </div>
          ) : (
            <div className="dp-last-msg empty">No messages yet.</div>
          )}
        </div>
      </div>
    </aside>
  );
}

export function LeadQuickPanelWithClose({
  lead,
  onClose,
}: {
  lead: LeadListRow | null;
  onClose: () => void;
}) {
  if (!lead) {
    return <LeadQuickPanel lead={null} />;
  }

  return (
    <aside className="detail-panel" aria-label="Lead quick panel">
      <div className="dp-header">
        <div className="dp-header-top">
          <div>
            <div className="dp-name">{displayName(lead)}</div>
            <div className="dp-sub">
              {lead.businessName ?? "Unknown business"} · {lead.city ?? "Unknown city"}, {lead.state ?? "--"} · {lead.vertical ?? "tradies"}
            </div>
          </div>
          <div className="dp-header-actions">
            <Link className="dp-icon-btn open-page" aria-label="Open full lead page" href={`/leads/${lead.id}`}>
              <ExternalLink size={15} />
            </Link>
            <button className="dp-icon-btn" type="button" aria-label="Close quick panel" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="dp-meta">
          <LeadStatusBadge status={lead.status} />
          <span className="dp-score">score {lead.score ?? "--"} / 100</span>
        </div>
      </div>
      <div className="dp-actions">
        <button className="btn btn-muted" type="button" disabled title="Available in a future update">
          <PenLine size={13} />
          Note
        </button>
        <button className="btn btn-muted" type="button" disabled title="Available in a future update">
          <MessageSquare size={13} />
          Reply
        </button>
        <button className="btn btn-muted" type="button" disabled title="Available in a future update">
          <Pause size={13} />
          Pause
        </button>
      </div>
      <div className="dp-body">
        <div className="dp-section">
          <div className="dp-section-title">Contact</div>
          <div className="dp-row"><span className="dp-row-label">Email</span><span className="dp-row-value">{lead.email}</span></div>
          <div className="dp-row"><span className="dp-row-label">Phone</span><span className="dp-row-value">{lead.phone ?? "--"}</span></div>
          <div className="dp-row"><span className="dp-row-label">State</span><span className="dp-row-value">{lead.state ?? "--"}</span></div>
          <div className="dp-row"><span className="dp-row-label">Industry</span><span className="dp-row-value">{lead.vertical ?? "--"}</span></div>
        </div>
        <div className="dp-section">
          <div className="dp-section-title">Top weaknesses</div>
          {lead.weaknesses.length ? (
            <div className="weakness-wrap">
              {lead.weaknesses.slice(0, 4).map((weakness) => (
                <span className="w-chip" key={weakness}>{weakness}</span>
              ))}
            </div>
          ) : (
            <div className="dp-empty">No website weaknesses recorded yet.</div>
          )}
        </div>
        <div className="dp-section">
          <div className="dp-section-title">Latest message</div>
          {lead.latestConversation ? (
            <div className="dp-last-msg">
              <div className="dp-msg-meta">
                {formatDirection(lead.latestConversation.direction)} · {formatMessageTime(lead.latestConversation.createdAt)}
              </div>
              {lead.latestConversation.body}
            </div>
          ) : (
            <div className="dp-last-msg empty">No messages yet.</div>
          )}
        </div>
      </div>
    </aside>
  );
}

function formatDirection(direction: string) {
  return direction.charAt(0).toUpperCase() + direction.slice(1);
}

function formatMessageTime(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "time unknown";

  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
