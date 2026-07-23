"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { deleteNote, type LeadActionState } from "@/app/actions/lead-actions";
import { initialLeadActionState } from "@/app/actions/lead-actions-core";
import { LeadDetailTabs } from "./LeadDetailTabs";
import { OperatorActionButtons } from "./OperatorActionButtons";
import type { WebsitePreviewDetail } from "./WebsitePreviewCard";

type Lead = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  businessName: string | null;
  city: string | null;
  state: string | null;
  vertical: string | null;
  status: string;
  websiteUrl: string | null;
  linkedinUrl: string | null;
};
type Enrichment = { cmsDetected: string | null; techSource: string; loadMs: number | null; hasSsl: boolean | null; weaknesses: unknown } | null;
type Qualification = { score: number; rationale: string; topWeakness: string; personalisedOpener: string | null; followup1: string | null; followup2: string | null } | null;
type Outreach = { id: string; step: number; channel: string; templateRef: string | null; sentAt: Date | null; delivered: boolean | null; opened: boolean | null; replied: boolean | null };
type Payment = { amountAud: string; status: string; stripeSessionId: string; paidAt: Date | null } | null;
type Conversation = { id: string; direction: string; channel: string; body: string; createdAt: Date | string };

type Actions = {
  deleteNote: (previousState: LeadActionState, formData: FormData) => Promise<LeadActionState>;
};

function displayName(lead: Lead) {
  return [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email;
}

export function LeadDetailView({
  tenantId,
  lead,
  enrichment,
  qualification,
  conversations: initialConversations,
  outreachSends,
  payment,
  websitePreview,
  actions = { deleteNote },
  now,
}: {
  tenantId: string;
  lead: Lead;
  enrichment: Enrichment;
  qualification: Qualification;
  conversations: Conversation[];
  outreachSends: Outreach[];
  payment: Payment;
  websitePreview: WebsitePreviewDetail | null;
  actions?: Partial<Actions>;
  now?: Date;
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [message, setMessage] = useState("");
  const [, startTransition] = useTransition();
  const name = displayName(lead);
  const deleteNoteAction = actions.deleteNote ?? deleteNote;

  function handleDeleteNote(conversationId: string) {
    const formData = new FormData();
    formData.set("tenantId", tenantId);
    formData.set("leadId", lead.id);
    formData.set("conversationId", conversationId);

    startTransition(async () => {
      const result = await deleteNoteAction(initialLeadActionState, formData);
      setMessage(result.message);
      if (result.ok && result.deletedConversationId) {
        setConversations((current) => current.filter((conversation) => conversation.id !== result.deletedConversationId));
      }
    });
  }

  return (
    <div className="lead-detail-shell">
      <header className="lead-detail-sticky-header" role="banner" aria-label="Lead detail header">
        <div className="breadcrumb">
          <Link href="/leads">Leads</Link>
          <span>/</span>
          <span>{name}</span>
        </div>
        <div className="lead-detail-header-row">
          <div>
            <div className="lead-detail-name">{name}</div>
            <div className="lead-detail-company">
              {lead.businessName ?? "Unknown business"} · {lead.city ?? "Unknown city"}, {lead.state ?? "--"} · {lead.vertical ?? "tradies"}
            </div>
          </div>
          <OperatorActionButtons
            tenantId={tenantId}
            leadId={lead.id}
            initialStatus={lead.status}
            score={qualification?.score ?? null}
            onConversationCreated={(conversation) => setConversations((current) => [...current, conversation])}
          />
        </div>
        {message ? <div className="operator-action-message">{message}</div> : null}
      </header>
      <LeadDetailTabs
        lead={lead}
        enrichment={enrichment}
        qualification={qualification}
        conversations={conversations}
        outreachSends={outreachSends}
        payment={payment}
        websitePreview={websitePreview}
        now={now}
        onDeleteNote={handleDeleteNote}
      />
    </div>
  );
}
