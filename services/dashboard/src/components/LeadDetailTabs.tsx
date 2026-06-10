"use client";

import { useState } from "react";
import { ConversationThread } from "./ConversationThread";
import { WebsitePreviewCard, type WebsitePreviewDetail } from "./WebsitePreviewCard";

type Lead = { email: string; phone: string | null; websiteUrl: string | null; linkedinUrl: string | null };
type Enrichment = { cmsDetected: string | null; techSource: string; loadMs: number | null; hasSsl: boolean | null; weaknesses: unknown } | null;
type Qualification = { score: number; rationale: string; topWeakness: string; personalisedOpener: string | null; followup1: string | null; followup2: string | null } | null;
type Outreach = { id: string; step: number; channel: string; templateRef: string | null; sentAt: Date | null; delivered: boolean | null; opened: boolean | null; replied: boolean | null };
type Payment = { amountAud: string; status: string; stripeSessionId: string; paidAt: Date | null } | null;
type Conversation = { id: string; direction: string; channel: string; body: string; createdAt: Date | string };

const tabs = ["Overview", "Conversation", "Outreach", "Payment"] as const;

export function LeadDetailTabs({
  lead,
  enrichment,
  qualification,
  conversations,
  outreachSends,
  payment,
  websitePreview,
  now,
  onDeleteNote,
}: {
  lead: Lead;
  enrichment: Enrichment;
  qualification: Qualification;
  conversations: Conversation[];
  outreachSends: Outreach[];
  payment: Payment;
  websitePreview: WebsitePreviewDetail | null;
  now?: Date;
  onDeleteNote?: (conversationId: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("Overview");
  const outreachSent = outreachSends.some((send) => send.step === 1 && send.sentAt !== null);

  return (
    <>
      <div className="lead-tabs" role="tablist" aria-label="Lead detail tabs">
        {tabs.map((tab) => (
          <button key={tab} className={`lead-tab ${activeTab === tab ? "active" : ""}`} type="button" onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </div>
      <div className="lead-detail-body">
        {activeTab === "Overview" ? (
          <>
            <div className="detail-grid">
              <div className="detail-card">
                <div className="detail-card-title">Contact</div>
                <div className="detail-field"><span className="detail-field-label">Email</span><span className="detail-field-value">{lead.email}</span></div>
                <div className="detail-field"><span className="detail-field-label">Phone</span><span className="detail-field-value">{lead.phone ?? "--"}</span></div>
                <div className="detail-field"><span className="detail-field-label">Website</span><span className="detail-field-value link">{lead.websiteUrl ?? "--"}</span></div>
                <div className="detail-field"><span className="detail-field-label">LinkedIn</span><span className="detail-field-value link">{lead.linkedinUrl ?? "--"}</span></div>
              </div>
              <div className="detail-card">
                <div className="detail-card-title">Enrichment</div>
                {enrichment ? (
                  <>
                    <div className="detail-field"><span className="detail-field-label">CMS</span><span className="detail-field-value">{enrichment.cmsDetected ?? "--"}</span></div>
                    <div className="detail-field"><span className="detail-field-label">Tech source</span><span className="detail-field-value">{enrichment.techSource}</span></div>
                    <div className="detail-field"><span className="detail-field-label">Load time</span><span className="detail-field-value">{enrichment.loadMs ? `${enrichment.loadMs}ms` : "--"}</span></div>
                    <div className="detail-field"><span className="detail-field-label">SSL</span><span className="detail-field-value">{enrichment.hasSsl ? "Present" : "Missing"}</span></div>
                  </>
                ) : (
                  <div className="empty-state">No enrichment data yet.</div>
                )}
              </div>
            </div>
            <div className="detail-card">
              <div className="detail-card-title">Qualification</div>
              {qualification ? (
                <>
                  <p className="opener-text">{qualification.personalisedOpener ?? qualification.rationale}</p>
                  <div className="detail-field"><span className="detail-field-label">Top weakness</span><span className="detail-field-value">{qualification.topWeakness}</span></div>
                </>
              ) : (
                <div className="empty-state">No qualification data yet.</div>
              )}
            </div>
            <WebsitePreviewCard websitePreview={websitePreview} outreachSent={outreachSent} />
          </>
        ) : null}
        {activeTab === "Conversation" ? (
          <ConversationThread conversations={conversations} now={now} onDeleteNote={onDeleteNote} />
        ) : null}
        {activeTab === "Outreach" ? (
          outreachSends.length ? outreachSends.map((send) => (
            <div className="outreach-row" key={send.id}>
              <div className="outreach-step">Step {send.step}</div>
              <div>{send.templateRef ?? send.channel}</div>
              <div className="td-muted">{send.replied ? "Replied" : send.opened ? "Opened" : send.delivered ? "Delivered" : "Pending"}</div>
            </div>
          )) : <div className="empty-state">No outreach sends yet. Qualified leads will appear here after scheduling.</div>
        ) : null}
        {activeTab === "Payment" ? (
          payment ? (
            <>
              <div className="payment-status-banner">Payment status: {payment.status}</div>
              <div className="detail-card">
                <div className="detail-field"><span className="detail-field-label">Amount</span><span className="detail-field-value">${payment.amountAud} AUD</span></div>
                <div className="detail-field"><span className="detail-field-label">Stripe session</span><span className="detail-field-value">{payment.stripeSessionId}</span></div>
              </div>
            </>
          ) : <div className="empty-state">No payments recorded yet.</div>
        ) : null}
      </div>
    </>
  );
}
