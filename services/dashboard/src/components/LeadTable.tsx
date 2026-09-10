import type { LeadListRow } from "./LeadQuickPanel";
import { LeadStatusBadge } from "./LeadStatusBadge";

function displayName(lead: LeadListRow) {
  return [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email;
}

export function LeadTable({
  leads,
  selectedLeadId,
  onSelectLead,
}: {
  leads: LeadListRow[];
  selectedLeadId: string | null;
  onSelectLead: (leadId: string) => void;
}) {
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Business</th>
              <th>State</th>
              <th>Status</th>
              <th>Score</th>
              {/* leads.updated_at, which moves on any write to the row,
                  including a background status change. It is not the prospect
                  doing anything, so the column does not claim to be. */}
              <th>Last updated</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr
                key={lead.id}
                className={lead.id === selectedLeadId ? "selected" : ""}
                onClick={() => onSelectLead(lead.id)}
              >
                <td>
                  <button
                    className="td-name table-preview-btn"
                    type="button"
                    onClick={() => onSelectLead(lead.id)}
                    aria-label={`Preview ${displayName(lead)}`}
                  >
                    {displayName(lead)}
                  </button>
                  <div className="td-muted">{lead.email}</div>
                </td>
                <td>{lead.businessName ?? "Unknown business"}</td>
                <td>{lead.state ?? "--"}</td>
                <td><LeadStatusBadge status={lead.status} /></td>
                <td>
                  <div className="score-cell">
                    <div className="score-track"><div className="score-fill" style={{ width: `${lead.score ?? 0}%` }} /></div>
                    <span>{lead.score ?? "--"}</span>
                  </div>
                </td>
                <td className="td-muted">{formatLastUpdated(lead.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="lead-card-list" aria-label="Lead cards">
        {leads.map((lead) => {
          const name = displayName(lead);

          return (
            <li key={lead.id} aria-label={name}>
              <button
                type="button"
                className={`lead-card${lead.id === selectedLeadId ? " selected" : ""}`}
                aria-label={`Preview ${name}`}
                onClick={() => onSelectLead(lead.id)}
              >
                <div className="lead-card-main">
                  <div className="lead-card-title">{name}</div>
                  <div className="lead-card-sub">{lead.businessName ?? "Unknown business"}</div>
                  <div className="lead-card-email">{lead.email}</div>
                </div>
                <div className="lead-card-meta">
                  <LeadStatusBadge status={lead.status} />
                  <span>{lead.state ?? "--"}</span>
                  <span>Score {lead.score ?? "--"}</span>
                </div>
                <div className="lead-card-footer">
                  <span>{formatLastUpdated(lead.updatedAt)}</span>
                  <span className="lead-card-link" aria-hidden="true">Preview</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function formatLastUpdated(value: Date | string | null | undefined) {
  if (!value) return "--";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Australia/Sydney",
  }).format(date);
}
