import { AlertCircle, ExternalLink, X } from "lucide-react";
import Link from "next/link";
import { OperatorActionButtons, type LeadActions } from "./OperatorActionButtons";

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

function initials(lead: LeadListRow) {
  const parts = [lead.firstName, lead.lastName].filter((part): part is string => Boolean(part));
  const source = parts.length ? parts : [lead.email];

  return source
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function locationText(lead: LeadListRow) {
  return [lead.businessName ?? "Unknown business", lead.city ?? "Unknown city"].join(" · ");
}

type LeadQuickPanelProps = {
  lead: LeadListRow | null;
  tenantId: string;
  actions?: LeadActions;
};

export function LeadQuickPanel({ lead, tenantId, actions }: LeadQuickPanelProps) {
  if (!lead) {
    return null;
  }

  return (
    <aside className="detail-panel sticky-detail-panel" aria-label="Lead quick panel">
      <LeadQuickPanelContent lead={lead} tenantId={tenantId} actions={actions} />
    </aside>
  );
}

export function LeadQuickPanelWithClose({
  lead,
  tenantId,
  onClose,
  actions,
}: {
  lead: LeadListRow | null;
  tenantId: string;
  onClose: () => void;
  actions?: LeadActions;
}) {
  if (!lead) {
    return null;
  }

  return (
    <aside className="detail-panel sticky-detail-panel" aria-label="Lead quick panel">
      <LeadQuickPanelContent lead={lead} tenantId={tenantId} actions={actions} onClose={onClose} />
    </aside>
  );
}

function LeadQuickPanelContent({
  lead,
  tenantId,
  actions,
  onClose,
}: {
  lead: LeadListRow;
  tenantId: string;
  actions?: LeadActions;
  onClose?: () => void;
}) {
  return (
    <>
      <div className="dp-header">
        <div className="dp-header-top">
          <div className="dp-identity">
            <div className="dp-avatar" aria-hidden="true">{initials(lead)}</div>
            <div className="dp-identity-copy">
              <div className="dp-name">{displayName(lead)}</div>
              <div className="dp-sub">{locationText(lead)}</div>
              <div className="dp-chip-row">
                <span className="dp-chip">{lead.vertical ?? "tradies"}</span>
                <span className="dp-chip">{lead.state ?? "State unknown"}</span>
              </div>
            </div>
          </div>
          <div className="dp-header-actions">
            <Link className="dp-icon-btn open-page" aria-label="Open full lead page" href={`/leads/${lead.id}`}>
              <ExternalLink size={15} />
            </Link>
            {onClose ? (
              <button className="dp-icon-btn" type="button" aria-label="Close quick panel" onClick={onClose}>
                <X size={15} />
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="dp-section dp-actions-section">
        <div className="dp-section-title">ACTIONS</div>
        <OperatorActionButtons
          tenantId={tenantId}
          leadId={lead.id}
          initialStatus={lead.status}
          score={lead.score}
          actions={actions}
          onConversationCreated={() => {}}
          compact
        />
      </div>
      <div className="dp-body">
        <div className="dp-section">
          <div className="dp-section-title">CONTACT</div>
          <div className="dp-row"><span className="dp-row-label">Email</span><span className="dp-row-value">{lead.email}</span></div>
          <div className="dp-row"><span className="dp-row-label">Phone</span><span className={lead.phone ? "dp-row-value" : "dp-row-value muted-placeholder"}>{lead.phone ?? "No phone on record"}</span></div>
        </div>
        <div className="dp-section">
          <div className="dp-section-title">TOP WEAKNESSES</div>
          {lead.weaknesses.length ? (
            <div className="weakness-wrap">
              {lead.weaknesses.slice(0, 4).map((weakness) => (
                <span className="w-chip" key={weakness}>{weakness}</span>
              ))}
            </div>
          ) : (
            <div className="dp-empty dp-empty-with-icon">
              <AlertCircle size={15} aria-label="No weaknesses recorded" />
              <span>No website weaknesses recorded yet.</span>
            </div>
          )}
        </div>
        <div className="dp-section">
          <div className="dp-section-title">LATEST MESSAGE</div>
          {lead.latestConversation ? (
            <div className="dp-message-card">
              <div className="dp-message-meta">
                <span className="dp-message-badge">{formatDirection(lead.latestConversation.direction)}</span>
                <span className="dp-message-time">{formatMessageTime(lead.latestConversation.createdAt)}</span>
              </div>
              <blockquote className="dp-message-quote">{lead.latestConversation.body}</blockquote>
            </div>
          ) : (
            <div className="dp-last-msg empty">No messages yet.</div>
          )}
        </div>
      </div>
    </>
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
    timeZone: "Australia/Sydney",
  }).format(date);
}
