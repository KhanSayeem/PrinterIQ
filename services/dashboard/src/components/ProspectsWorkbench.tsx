"use client";

import { Play, RefreshCw } from "lucide-react";
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

export type ProspectEvidenceView = {
  id: string;
  businessName: string;
  route: string | null;
  status: string;
  websiteOwnership: string | null;
  outcomeReason: string | null;
  sourceWebsiteUrl: string | null;
  normalizedDomain: string | null;
  ruleEvidence: unknown;
};

const INITIAL_ACTION_STATE: ProspectRunActionState = { ok: false, message: "" };
const ACTIVE_STATUSES = new Set(["created", "submitted", "polling", "processing"]);

export function ProspectsWorkbench({
  initialRun,
  initialProspects = [],
  startAction,
}: {
  initialRun: ProspectRunView | null;
  initialProspects?: ProspectEvidenceView[];
  startAction: StartProspectRunAction;
}) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<ProspectRunActionState>(INITIAL_ACTION_STATE);
  const [isPending, startTransition] = useTransition();
  const isActive = initialRun ? ACTIVE_STATUSES.has(initialRun.status) : false;

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
          <ProspectRunSummary run={initialRun} />
          <ProspectEvidenceList prospects={initialProspects} />
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

function ProspectEvidenceList({ prospects }: { prospects: ProspectEvidenceView[] }) {
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
              <dt>Evidence</dt>
              <dd>{evidenceSummary(prospect.ruleEvidence)}</dd>
            </div>
          </dl>
        </article>
      ))}
    </section>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
