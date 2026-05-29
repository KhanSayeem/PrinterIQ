"use client";

import { useMemo, useState } from "react";
import { LeadQuickPanelWithClose, type LeadListRow } from "./LeadQuickPanel";
import { LeadTable } from "./LeadTable";

export function LeadsWorkbench({ tenantId, leads }: { tenantId: string; leads: LeadListRow[] }) {
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(leads[0]?.id ?? null);

  const selectedLead = useMemo(
    () => leads.find((lead) => lead.id === selectedLeadId) ?? null,
    [leads, selectedLeadId],
  );

  return (
    <div className="leads-screen">
      <section className="leads-list">
        {leads.length ? (
          <LeadTable leads={leads} selectedLeadId={selectedLeadId} onSelectLead={setSelectedLeadId} />
        ) : (
          <div className="empty-state">No leads yet. Import your Apollo CSV to get started.</div>
        )}
      </section>
      <LeadQuickPanelWithClose tenantId={tenantId} lead={selectedLead} onClose={() => setSelectedLeadId(null)} />
    </div>
  );
}
