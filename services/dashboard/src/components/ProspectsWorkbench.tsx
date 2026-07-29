"use client";

import { Download, Play, RefreshCw } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ProspectRunSummary, type ProspectRunView } from "./ProspectRunSummary";

type ProspectRunActionState = {
  ok: boolean;
  message: string;
  discoveryRunId?: string;
};

type StartProspectRunAction = (
  previousState: ProspectRunActionState,
  formData: FormData,
) => Promise<ProspectRunActionState>;

type ProspectReviewActionState = {
  ok: boolean;
  message: string;
  prospectId?: string;
};

type RecordProspectReviewAction = (
  previousState: ProspectReviewActionState,
  formData: FormData,
) => Promise<ProspectReviewActionState>;

export type ProspectReviewMetrics = {
  sampleCount: number;
  routeASampleCount: number;
  routeBSampleCount: number;
  healthyRejectedSampleCount: number;
  reviewedCount: number;
  decisiveReviewCount: number;
  missingReviewCount: number;
  needsInvestigationCount: number;
  eligibilityPrecision: number | null;
  routePrecision: number | null;
  usableYield: number | null;
  routeableYield: number | null;
  routeAYield: number | null;
  routeBYield: number | null;
  unexpectedFailureRate: number | null;
  verifiedContactCount: number;
  routeAVerifiedEmailMatchRate: number | null;
  routeBVerifiedEmailMatchRate: number | null;
  providerUsagePresent: boolean;
  costReconciliationRequired: boolean;
};

export type ProspectEvidenceView = {
  id: string;
  businessName: string;
  route: string | null;
  status: string;
  validationSample?: boolean;
  validationCohort?: string | null;
  websiteOwnership: string | null;
  outcomeReason: string | null;
  sourceWebsiteUrl: string | null;
  normalizedDomain: string | null;
  matchedLocationCount: number;
  duplicateEvidence: unknown;
  ruleEvidence: unknown;
  totalScore?: number | null;
  categoryScores?: unknown;
  forcedRouteReason?: string | null;
  contactStatus?: string | null;
  contactPersonName?: string | null;
  contactPersonTitle?: string | null;
  contactEmail?: string | null;
  contactEmailStatus?: string | null;
  contactEvidence?: unknown;
  reviewDecision?: string | null;
  correctedRoute?: string | null;
  reviewNote?: string | null;
  reviewedAt?: Date | string | null;
};

const INITIAL_ACTION_STATE: ProspectRunActionState = { ok: false, message: "" };
const INITIAL_REVIEW_STATE: ProspectReviewActionState = { ok: false, message: "" };
const DASHBOARD_TIME_ZONE = "Australia/Brisbane";
const BLOCKING_RUN_STATUSES = new Set([
  "created",
  "submitted",
  "polling",
  "persisted",
  "processing",
  "review_ready",
]);

export function ProspectsWorkbench({
  initialRun,
  initialProspects = [],
  reviewMetrics,
  startAction,
  reviewAction,
}: {
  initialRun: ProspectRunView | null;
  initialProspects?: ProspectEvidenceView[];
  reviewMetrics?: ProspectReviewMetrics | null;
  startAction: StartProspectRunAction;
  reviewAction?: RecordProspectReviewAction;
}) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<ProspectRunActionState>(INITIAL_ACTION_STATE);
  const [isPending, startTransition] = useTransition();
  const isActive = initialRun ? BLOCKING_RUN_STATUSES.has(initialRun.status) : false;

  function refreshStatus() {
    setFeedback(INITIAL_ACTION_STATE);
    try {
      router.refresh();
    } catch {
      setFeedback({ ok: false, message: "Could not refresh run status. Try again." });
    }
  }

  function startRun() {
    startTransition(async () => {
      try {
        const result = await startAction(INITIAL_ACTION_STATE, new FormData());
        setFeedback(result);
        if (result.ok) {
          try {
            router.refresh();
          } catch {
            setFeedback({ ok: false, message: "Run started, but its status could not be refreshed." });
          }
        }
      } catch {
        setFeedback({ ok: false, message: "Could not start discovery. Check the worker and database connection." });
      }
    });
  }

  return (
    <div className="prospects-workbench">
      <section className="prospect-preset" aria-labelledby="preset-heading">
        <div>
          <span className="prospect-eyebrow">Fixed pilot preset</span>
          <h2 id="preset-heading">Greater Brisbane plumbing</h2>
          <p>Brisbane, Logan, Ipswich, Moreton Bay, and Redlands</p>
          <span className="prospect-cap">500 businesses maximum</span>
        </div>
        <div className="prospect-run-actions">
          {isActive ? <span className="prospect-active-note">A discovery run is active.</span> : null}
          {!isActive ? (
            <button className="btn btn-primary" type="button" disabled={isPending} onClick={startRun}>
              <Play size={14} aria-hidden="true" />
              {isPending ? "Starting..." : "Start discovery run"}
            </button>
          ) : null}
          <button className="btn btn-ghost" type="button" disabled={isPending} onClick={refreshStatus}>
            <RefreshCw size={14} aria-hidden="true" />
            Refresh run status
          </button>
        </div>
      </section>

      {feedback.message ? (
        <div className={feedback.ok ? "prospect-action-feedback success" : "prospect-action-feedback error"} role={feedback.ok ? "status" : "alert"}>
          {feedback.message}
        </div>
      ) : null}

      {initialRun ? (
        <>
          <ProspectRunSummary run={initialRun} reviewMetrics={reviewMetrics ?? null} />
          <ReviewGateSummary run={initialRun} metrics={reviewMetrics ?? null} />
          <ProspectEvidenceList
            run={initialRun}
            prospects={initialProspects}
            reviewAction={reviewAction}
          />
        </>
      ) : (
        <div className="prospect-empty-state">
          <strong>No discovery runs yet</strong>
          <span>Start the fixed preset to begin collecting staged prospects.</span>
        </div>
      )}
    </div>
  );
}

function ReviewGateSummary({
  run,
  metrics,
}: {
  run: ProspectRunView;
  metrics: ProspectReviewMetrics | null;
}) {
  if (!metrics) {
    return (
      <section className="prospect-run-summary" aria-label="Review gates">
        <div className="prospect-section-heading">
          <div>
            <h2>Review gates</h2>
            <p>Shadow review only. Manual validation metrics are pending.</p>
          </div>
        </div>
        <div className="prospect-run-notice">Review metrics are not available yet.</div>
      </section>
    );
  }
  const gates = [
    ["Eligibility precision", metrics.eligibilityPrecision, 0.9, "minimum"],
    ["Route precision", metrics.routePrecision, 0.85, "minimum"],
    ["Usable yield", metrics.usableYield, 0.7, "minimum"],
    ["Routeable yield", metrics.routeableYield, 0.2, "minimum"],
    ["Verified contacts", metrics.verifiedContactCount, 30, "count"],
    ["Unexpected failures", metrics.unexpectedFailureRate, 0.05, "maximum"],
  ] as const;
  const blockers = [
    metrics.missingReviewCount > 0 ? `${metrics.missingReviewCount} sample records still need review` : null,
    metrics.needsInvestigationCount > 0 ? `${metrics.needsInvestigationCount} records need investigation` : null,
    !metrics.providerUsagePresent ? "Apollo provider usage is missing" : null,
    metrics.costReconciliationRequired ? "Cost reconciliation required" : null,
    run.failureCode === "insufficient_sample" ? "Sample is insufficient for a passing result" : null,
  ].filter(Boolean);

  return (
    <section className="prospect-run-summary" aria-label="Review gates">
      <div className="prospect-section-heading">
        <div>
          <h2>Review gates</h2>
          <p>Shadow review only. Export reviewed evidence for offline validation.</p>
        </div>
        <a className="btn btn-ghost" href={`/api/prospects/export?runId=${run.id}`}>
          <Download size={14} aria-hidden="true" />
          Export CSV
        </a>
      </div>
      <div className="prospect-count-grid">
        <div className="prospect-count">
          <span>Sample</span>
          <strong>{metrics.sampleCount}</strong>
        </div>
        <div className="prospect-count">
          <span>Route A sample</span>
          <strong>{metrics.routeASampleCount}</strong>
        </div>
        <div className="prospect-count">
          <span>Route B sample</span>
          <strong>{metrics.routeBSampleCount}</strong>
        </div>
        <div className="prospect-count">
          <span>Healthy/rejected sample</span>
          <strong>{metrics.healthyRejectedSampleCount}</strong>
        </div>
      </div>
      <dl className="prospect-run-meta">
        {gates.map(([label, value, threshold, mode]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{gateLabel(value, threshold, mode)}</dd>
          </div>
        ))}
      </dl>
      {blockers.length > 0 ? (
        <div className="prospect-run-notice">{blockers.join("; ")}</div>
      ) : (
        <div className="prospect-action-feedback success">All review gates currently pass.</div>
      )}
    </section>
  );
}

function ProspectEvidenceList({
  run,
  prospects,
  reviewAction,
}: {
  run: ProspectRunView;
  prospects: ProspectEvidenceView[];
  reviewAction?: RecordProspectReviewAction;
}) {
  if (prospects.length === 0) {
    return (
      <section className="prospect-evidence-list" aria-label="Prospect evidence">
        <div className="prospect-empty-state">
          <strong>No prospect evidence yet</strong>
          <span>Route evidence appears after persisted records are normalized.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="prospect-evidence-list" aria-label="Prospect evidence">
      {prospects.map((prospect) => (
        <article className="prospect-evidence-row" key={prospect.id}>
          <div>
            <h3>{prospect.businessName}</h3>
            <div className="prospect-evidence-meta">
              <span>{prospect.route ? `Route ${prospect.route}` : statusLabel(prospect.status)}</span>
              <span>{ownershipLabel(prospect.websiteOwnership)}</span>
              {prospect.outcomeReason ? <code>{prospect.outcomeReason}</code> : null}
            </div>
          </div>
          <dl>
            <div>
              <dt>Website</dt>
              <dd>{prospect.sourceWebsiteUrl ?? "No URL"}</dd>
            </div>
            <div>
              <dt>Final URL</dt>
              <dd>{finalUrl(prospect.ruleEvidence) ?? prospect.sourceWebsiteUrl ?? "No URL"}</dd>
            </div>
            <div>
              <dt>Domain</dt>
              <dd>{prospect.normalizedDomain ?? "None"}</dd>
            </div>
            <div>
              <dt>Ownership reason</dt>
              <dd>{websiteReason(prospect.ruleEvidence) ?? prospect.outcomeReason ?? "No reason"}</dd>
            </div>
            <div>
              <dt>Website score</dt>
              <dd>{scoreSummary(prospect)}</dd>
            </div>
            <div>
              <dt>Score categories</dt>
              <dd>{categoryScoreSummary(prospect.categoryScores ?? scoringEvidence(prospect.ruleEvidence).category_scores)}</dd>
            </div>
            <div>
              <dt>Rule results</dt>
              <dd>{ruleResultSummary(prospect.ruleEvidence)}</dd>
            </div>
            <div>
              <dt>Forced route</dt>
              <dd>{prospect.forcedRouteReason ?? forcedReason(prospect.ruleEvidence) ?? "None"}</dd>
            </div>
            <div>
              <dt>Contact</dt>
              <dd>{contactSummary(prospect)}</dd>
            </div>
            <div>
              <dt>Contact evidence</dt>
              <dd>{contactEvidenceSummary(prospect.contactEvidence)}</dd>
            </div>
            <div>
              <dt>Validation sample</dt>
              <dd>{prospect.validationSample ? `Selected - ${cohortLabel(prospect.validationCohort)}` : "Not selected"}</dd>
            </div>
            <div>
              <dt>Manual review</dt>
              <dd>{manualReviewSummary(prospect)}</dd>
            </div>
            <div>
              <dt>Matched locations</dt>
              <dd>{matchedLocationCount(prospect)}</dd>
            </div>
            <div>
              <dt>Duplicate evidence</dt>
              <dd>{duplicateEvidenceSummary(prospect)}</dd>
            </div>
            <div>
              <dt>Evidence</dt>
              <dd>{evidenceSummary(prospect.ruleEvidence)}</dd>
            </div>
          </dl>
          {prospect.validationSample && reviewAction ? (
            <ManualReviewForm
              runId={run.id}
              prospect={prospect}
              reviewAction={reviewAction}
            />
          ) : null}
        </article>
      ))}
    </section>
  );
}

function ManualReviewForm({
  runId,
  prospect,
  reviewAction,
}: {
  runId: string;
  prospect: ProspectEvidenceView;
  reviewAction: RecordProspectReviewAction;
}) {
  const [feedback, setFeedback] = useState<ProspectReviewActionState>(INITIAL_REVIEW_STATE);
  const [isPending, startTransition] = useTransition();

  function submit(formData: FormData) {
    formData.set("idempotencyKey", browserUuid());
    startTransition(async () => {
      try {
        const result = await reviewAction(INITIAL_REVIEW_STATE, formData);
        setFeedback(result);
      } catch (error) {
        setFeedback({
          ok: false,
          message: error instanceof Error ? error.message : "Review could not be recorded.",
        });
      }
    });
  }

  return (
    <form className="prospect-review-form" action={submit}>
      <input type="hidden" name="discoveryRunId" value={runId} />
      <input type="hidden" name="prospectId" value={prospect.id} />
      <input type="hidden" name="idempotencyKey" value="" />
      <label>
        Decision
        <select name="decision" defaultValue="">
          <option value="" disabled>Select decision</option>
          <option value="correct">Correct</option>
          <option value="wrong_route">Wrong route</option>
          <option value="ineligible">Ineligible</option>
          <option value="needs_investigation">Needs investigation</option>
        </select>
      </label>
      <label>
        Corrected route
        <select name="correctedRoute" defaultValue="">
          <option value="">Only for wrong route</option>
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="manual_review">Manual review</option>
          <option value="healthy">Healthy</option>
        </select>
      </label>
      <label>
        Note
        <textarea name="note" maxLength={1000} />
      </label>
      <button className="btn btn-primary" type="submit" disabled={isPending}>
        {isPending ? "Recording..." : "Record review"}
      </button>
      {feedback.message ? (
        <span className={feedback.ok ? "prospect-action-feedback success" : "prospect-action-feedback error"} role={feedback.ok ? "status" : "alert"}>
          {feedback.message}
        </span>
      ) : null}
    </form>
  );
}

function ownershipLabel(value: string | null) {
  const labels: Record<string, string> = {
    none: "No website",
    social: "Social profile",
    directory: "Directory listing",
    marketplace: "Marketplace listing",
    placeholder: "Placeholder site",
    inaccessible: "Inaccessible site",
    owned: "Owned website",
  };
  return value ? labels[value] ?? value : "Unclassified";
}

function statusLabel(value: string) {
  return value.replace(/_/g, " ");
}

function evidenceSummary(value: unknown) {
  if (!isRecord(value)) return "No assessment evidence";
  const website = isRecord(value.website) ? value.website : {};
  const finalUrl = typeof website.final_url === "string" ? website.final_url : null;
  const ownership = typeof website.ownership === "string" ? website.ownership : null;
  return [ownership ? ownershipLabel(ownership) : null, finalUrl].filter(Boolean).join(" - ");
}

function finalUrl(value: unknown) {
  if (!isRecord(value)) return null;
  const website = isRecord(value.website) ? value.website : {};
  return typeof website.final_url === "string" ? website.final_url : null;
}

function websiteReason(value: unknown) {
  if (!isRecord(value)) return null;
  const website = isRecord(value.website) ? value.website : {};
  return typeof website.reason === "string" ? website.reason : null;
}

function scoreSummary(prospect: ProspectEvidenceView) {
  const score = typeof prospect.totalScore === "number"
    ? prospect.totalScore
    : scoringEvidence(prospect.ruleEvidence).total_score;
  return typeof score === "number" ? `${score}/100` : "Not scored";
}

function categoryScoreSummary(value: unknown) {
  if (!isRecord(value)) return "None";
  const labels: Record<string, string> = {
    technical_mobile: "Technical/mobile",
    conversion_path: "Conversion",
    local_relevance: "Local",
    trust_credibility: "Trust",
    service_completeness: "Services",
  };
  const parts = Object.entries(labels)
    .map(([key, label]) => {
      const score = value[key];
      return typeof score === "number" ? `${label}: ${score}` : null;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : "None";
}

function forcedReason(value: unknown) {
  const reason = scoringEvidence(value).forced_route_reason;
  return typeof reason === "string" && reason ? reason : null;
}

function contactSummary(prospect: ProspectEvidenceView) {
  if (!prospect.contactStatus) return "Not resolved";
  const status = prospect.contactStatus.replace(/_/g, " ");
  if (prospect.contactStatus === "verified") {
    return [
      "Verified",
      prospect.contactPersonName,
      prospect.contactPersonTitle,
      prospect.contactEmail,
    ].filter(Boolean).join(" - ");
  }
  if (prospect.contactStatus === "suppressed") {
    return `Suppressed${prospect.contactEmail ? ` - ${prospect.contactEmail}` : ""}`;
  }
  if (prospect.contactStatus === "failed") {
    const evidence = isRecord(prospect.contactEvidence) ? prospect.contactEvidence : {};
    const code = typeof evidence.failure_code === "string" ? evidence.failure_code : null;
    return code ? `Failed - ${code}` : "Failed";
  }
  return status;
}

function contactEvidenceSummary(value: unknown) {
  if (!isRecord(value)) return "No contact evidence";
  const parts = [
    typeof value.strategy === "string" ? value.strategy : null,
    typeof value.organization_match === "string" ? `Org: ${value.organization_match}` : null,
    typeof value.person_seniority === "string" ? `Seniority: ${value.person_seniority}` : null,
    typeof value.failure_code === "string" ? `Failure: ${value.failure_code}` : null,
    typeof value.suppression === "string" ? `Suppression: ${value.suppression}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : "No contact evidence";
}

function manualReviewSummary(prospect: ProspectEvidenceView) {
  if (!prospect.reviewDecision) return "Not reviewed";
  const parts = [
    prospect.reviewDecision.replace(/_/g, " "),
    prospect.correctedRoute ? `corrected to ${prospect.correctedRoute}` : null,
    prospect.reviewedAt ? `reviewed ${formatDate(prospect.reviewedAt)}` : null,
  ].filter(Boolean);
  return parts.join(" - ");
}

function cohortLabel(value: string | null | undefined) {
  if (value === "healthy_rejected") return "healthy/rejected";
  return value ?? "unknown cohort";
}

function gateLabel(
  value: number | null,
  threshold: number,
  mode: "minimum" | "maximum" | "count",
) {
  if (value === null) return "Incomplete";
  const passes = mode === "maximum" ? value < threshold : value >= threshold;
  const formatted = mode === "count" ? String(value) : formatPercent(value);
  return `${formatted} ${passes ? "passes" : "fails"} ${mode === "maximum" ? "<" : ">="} ${
    mode === "count" ? threshold : formatPercent(threshold)
  }`;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? "unknown time"
    : date.toLocaleString("en-AU", { timeZone: DASHBOARD_TIME_ZONE });
}

function browserUuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (token) => {
    const value = Math.floor(Math.random() * 16);
    const nibble = token === "x" ? value : (value & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

function ruleResultSummary(value: unknown) {
  const rules = scoringEvidence(value).rules;
  if (!isRecord(rules)) return "None";
  const parts = Object.values(rules).flatMap((category) => {
    if (!isRecord(category)) return [];
    return Object.entries(category).flatMap(([key, rule]) => {
      if (!isRecord(rule)) return [];
      const points = typeof rule.points === "number" ? rule.points : 0;
      const available = typeof rule.available === "number" ? rule.available : 0;
      return `${key}: ${points}/${available}`;
    });
  });
  return parts.length > 0 ? parts.join("; ") : "None";
}

function scoringEvidence(value: unknown) {
  if (!isRecord(value)) return {};
  return isRecord(value.scoring) ? value.scoring : {};
}

function matchedLocationCount(prospect: ProspectEvidenceView) {
  const eligibility = eligibilityEvidence(prospect.ruleEvidence);
  const count = typeof eligibility.matched_location_count === "number"
    ? eligibility.matched_location_count
    : prospect.matchedLocationCount;
  return String(count);
}

function duplicateEvidenceSummary(prospect: ProspectEvidenceView) {
  const eligibility = eligibilityEvidence(prospect.ruleEvidence);
  const evidence = isRecord(eligibility.duplicate_evidence)
    ? eligibility.duplicate_evidence
    : prospect.duplicateEvidence;
  if (!isRecord(evidence)) return "None";
  const parts = Object.entries(evidence)
    .map(([key, value]) => {
      const values = Array.isArray(value) ? value.map(String).filter(Boolean) : [];
      return values.length > 0 ? `${key}: ${values.join(", ")}` : null;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : "None";
}

function eligibilityEvidence(value: unknown) {
  if (!isRecord(value)) return {};
  return isRecord(value.eligibility) ? value.eligibility : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
