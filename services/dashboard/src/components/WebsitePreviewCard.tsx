"use client";

import { Check, Lock, Mail, Monitor, Smartphone } from "lucide-react";
import { useState } from "react";

export type WebsitePreviewDetail = {
  templateUsed: string;
  previewUrl: string;
  personalisationData: Record<string, unknown>;
  promptVersion: string;
  costUsd: string;
  generatedAt: Date | string;
};

type DeviceMode = "desktop" | "mobile";

const templates = [
  { key: "plumbing", label: "Plumbing", detail: "Tradie Pro - Plumbing" },
  { key: "electrical", label: "Electrical", detail: "Tradie Pro - Electrical" },
  { key: "hvac", label: "HVAC / Air", detail: "Tradie Pro - HVAC / Air" },
  { key: "concreting", label: "Concreting", detail: "Tradie Pro - Concreting" },
  { key: "landscaping", label: "Landscaping", detail: "Tradie Pro - Landscaping" },
  { key: "general", label: "General", detail: "Tradie Pro - General" },
] as const;

export function WebsitePreviewCard({
  websitePreview,
  outreachSent,
}: {
  websitePreview: WebsitePreviewDetail | null;
  outreachSent: boolean;
}) {
  const [device, setDevice] = useState<DeviceMode>("desktop");

  if (!websitePreview) {
    return (
      <section className="detail-card website-preview-card" aria-label="Website preview">
        <div className="detail-card-title">Website prototype</div>
        <div className="website-preview-pending">
          <div>
            <div className="preview-pending-label">Preview generating...</div>
            <div className="preview-pending-copy">Waiting for the preview worker to publish this lead's prototype.</div>
          </div>
          <div className="preview-skeleton-stack" aria-hidden="true">
            <span className="skeleton-block preview-skeleton-wide" />
            <span className="skeleton-block preview-skeleton-mid" />
            <span className="skeleton-block preview-skeleton-short" />
          </div>
        </div>
      </section>
    );
  }

  const template = findTemplate(websitePreview.templateUsed);
  const match = buildIndustryMatch(websitePreview.personalisationData);
  const fields = buildPersonalisationFields(websitePreview.personalisationData);
  const weakness = textValue(
    websitePreview.personalisationData.specific_weakness ??
      websitePreview.personalisationData.specificWeakness ??
      websitePreview.personalisationData.top_weakness ??
      websitePreview.personalisationData.topWeakness,
    "Not recorded",
  ) ?? "Not recorded";

  return (
    <section className="detail-card website-preview-card" aria-label="Website preview">
      <div className="website-preview-heading">
        <div>
          <div className="detail-card-title">Website prototype</div>
          <div className="website-preview-sub">Industry-matched template sent with outreach · Generated {formatDate(websitePreview.generatedAt)}</div>
        </div>
        <a className="preview-open-link" href={websitePreview.previewUrl} target="_blank" rel="noreferrer">
          Open full preview
        </a>
      </div>

      <div className="proto-tmpl-tabs" aria-label="Trade template tabs">
        {templates.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`proto-tmpl-tab ${item.key === template.key ? "active" : ""}`}
            aria-pressed={item.key === template.key}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="proto-preview-wrap">
        <div className="proto-preview-bar">
          <div className="proto-browser-dots" aria-hidden="true">
            <div className="proto-dot proto-dot-r" />
            <div className="proto-dot proto-dot-y" />
            <div className="proto-dot proto-dot-g" />
          </div>
          <div className="proto-url-bar">
            <Lock aria-hidden="true" />
            <span>{websitePreview.previewUrl}</span>
          </div>
          <div className="proto-device-toggle" aria-label="Preview viewport">
            <button
              type="button"
              className={`device-btn ${device === "desktop" ? "active" : ""}`}
              aria-label="Desktop view"
              title="Desktop view"
              onClick={() => setDevice("desktop")}
            >
              <Monitor aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`device-btn ${device === "mobile" ? "active" : ""}`}
              aria-label="Mobile view"
              title="Mobile view"
              onClick={() => setDevice("mobile")}
            >
              <Smartphone aria-hidden="true" />
            </button>
          </div>
        </div>

        {device === "desktop" ? (
          <div className="proto-viewport desktop-view">
            <iframe title="Website preview desktop" src={websitePreview.previewUrl} loading="lazy" />
          </div>
        ) : (
          <div className="proto-viewport mobile-view">
            <div className="proto-phone-shell">
              <iframe title="Website preview mobile" src={websitePreview.previewUrl} loading="lazy" />
            </div>
          </div>
        )}
      </div>

      <div className="proto-detail-grid">
        <PreviewDetail label="Template" value={template.detail} />
        <PreviewDetail label="Matched to" value={match} />
        <PreviewDetail label="Personalisation" value={fields} />
        <PreviewDetail label="Weakness addressed" value={weakness} emphasis />
        <PreviewDetail label="Prompt version" value={websitePreview.promptVersion} />
        <PreviewDetail label="AI cost" value={`$${websitePreview.costUsd}`} />
      </div>

      <div className="proto-send-row">
        <div className="proto-send-row-icon">
          <Mail aria-hidden="true" />
        </div>
        <div className="proto-send-row-text">
          <div className="proto-send-row-label">Prototype link included in Step 1 opener</div>
          <div className="proto-send-row-sub">{outreachSent ? "Sent with outreach" : "Not sent yet"}</div>
        </div>
        {outreachSent ? (
          <div className="proto-sent-badge">
            <Check aria-hidden="true" />
            Delivered
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PreviewDetail({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="proto-detail-item">
      <div className="proto-detail-label">{label}</div>
      <div className={`proto-detail-value ${emphasis ? "warning" : ""}`}>{value}</div>
    </div>
  );
}

function findTemplate(templateUsed: string) {
  const normalized = templateUsed.toLowerCase();
  return templates.find((template) => normalized.includes(template.key)) ?? templates[templates.length - 1];
}

function buildIndustryMatch(data: Record<string, unknown>) {
  const industry = textValue(data.industry ?? data.trade_type ?? data.tradeType, "Tradies") ?? "Tradies";
  const state = textValue(data.state, null);
  return state ? `${industry} · ${state}` : industry;
}

function buildPersonalisationFields(data: Record<string, unknown>) {
  const labels = Object.keys(data)
    .filter((key) => data[key] !== null && data[key] !== undefined && data[key] !== "")
    .map(labelFromKey);

  if (!labels.length) return "No fields recorded";
  return [capitalize(labels[0]), ...labels.slice(1)].join(", ");
}

function labelFromKey(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function textValue(value: unknown, fallback: string | null) {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function formatDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "date unavailable";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}
