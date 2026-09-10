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

function externalHref(value: string) {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** The first moment this lead was handed to Instantly, or null if it never was.
 *
 * `outreach_sends.sent_at` is stamped when the pipeline hands the lead over,
 * not when an email is sent and not when one is delivered, so nothing derived
 * from it may claim a delivery. `outreach_sends.step` is not tested here on
 * purpose: nothing ever writes it, so every row carries the schema default of
 * 1 and filtering on it would only look like a filter.
 */
function earliestHandoff(sends: Outreach[]): Date | null {
  const handoffs = sends
    .map((send) => send.sentAt)
    .filter((sentAt): sentAt is Date => sentAt instanceof Date);

  if (!handoffs.length) return null;
  return handoffs.reduce((earliest, sentAt) => (sentAt < earliest ? sentAt : earliest));
}

/** `enrichments.has_ssl` is nullable and a null is not a missing certificate.
 *
 * The auditor writes null when there is no site to load, when the site could
 * not be reached, or when the audit could not run at all
 * (services/pipeline/src/clients/playwright_audit.py, workers/enrich.py).
 * Rendering that as "Missing" asserted a security defect about sites nobody
 * ever loaded, so the unknown case says so and names the reason.
 */
function describeSsl(hasSsl: boolean | null) {
  if (hasSsl === true) return "Present";
  if (hasSsl === false) return "Missing";
  return "Unknown (site not reached)";
}

/** A measured 0ms is a measurement. Only a null is an absence of one. */
function describeLoadMs(loadMs: number | null) {
  return loadMs === null ? "--" : `${loadMs}ms`;
}

function describeHandoff(sentAt: Date | null) {
  if (!sentAt) return "Not handed to Instantly yet";
  return `Handed to Instantly ${new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Australia/Sydney",
  }).format(sentAt)}`;
}

function renderExternalUrl(value: string | null) {
  if (!value?.trim()) {
    return <span className="detail-field-value">--</span>;
  }

  return (
    <a className="detail-field-value link" href={externalHref(value)} target="_blank" rel="noreferrer">
      {value}
    </a>
  );
}

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
  const handedToInstantlyAt = earliestHandoff(outreachSends);

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
                <div className="detail-field"><span className="detail-field-label">Website</span>{renderExternalUrl(lead.websiteUrl)}</div>
                <div className="detail-field"><span className="detail-field-label">LinkedIn</span>{renderExternalUrl(lead.linkedinUrl)}</div>
              </div>
              <div className="detail-card">
                <div className="detail-card-title">Enrichment</div>
                {enrichment ? (
                  <>
                    <div className="detail-field"><span className="detail-field-label">CMS</span><span className="detail-field-value">{enrichment.cmsDetected ?? "--"}</span></div>
                    <div className="detail-field"><span className="detail-field-label">Tech source</span><span className="detail-field-value">{enrichment.techSource}</span></div>
                    <div className="detail-field"><span className="detail-field-label">Load time</span><span className="detail-field-value">{describeLoadMs(enrichment.loadMs)}</span></div>
                    <div className="detail-field"><span className="detail-field-label">SSL</span><span className="detail-field-value">{describeSsl(enrichment.hasSsl)}</span></div>
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
            <WebsitePreviewCard websitePreview={websitePreview} handedToInstantlyAt={handedToInstantlyAt} />
          </>
        ) : null}
        {activeTab === "Conversation" ? (
          <ConversationThread conversations={conversations} now={now} onDeleteNote={onDeleteNote} />
        ) : null}
        {activeTab === "Outreach" ? (
          outreachSends.length ? (
            <>
              {outreachSends.map((send) => (
                <div className="outreach-row" key={send.id}>
                  <div className="outreach-step">{describeHandoff(send.sentAt)}</div>
                  <div>{send.templateRef ?? "No template recorded"}</div>
                  <div className="td-muted">{send.channel}</div>
                </div>
              ))}
              {/* No step number and no send status, because neither is written.
                  `step` is the schema default of 1 on every row, `template_ref`
                  is null on every row, and nothing ever writes `delivered`,
                  `opened` or `replied`, so the old status column read "Pending"
                  for leads Instantly had already emailed. */}
              <div className="empty-state">
                One row per handoff to Instantly. Instantly sends the opener and every follow-up on its own
                schedule and writes no row here, so delivery and open status live in Instantly. Replies appear
                in the Conversation tab.
              </div>
            </>
          ) : <div className="empty-state">No outreach sends yet. Qualified leads will appear here after scheduling.</div>
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
