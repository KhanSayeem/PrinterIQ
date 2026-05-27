import { LeadListRow } from "./LeadQuickPanel";
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
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Business</th>
            <th>State</th>
            <th>Status</th>
            <th>Score</th>
            <th>Last Activity</th>
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
              <td className="td-muted">{formatLastActivity(lead.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatLastActivity(value: Date | string | null | undefined) {
  if (!value) return "--";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
