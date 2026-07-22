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

const INITIAL_ACTION_STATE: ProspectRunActionState = { ok: false, message: "" };
const ACTIVE_STATUSES = new Set(["created", "submitted", "polling", "processing"]);

export function ProspectsWorkbench({
  initialRun,
  startAction,
}: {
  initialRun: ProspectRunView | null;
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
        <ProspectRunSummary run={initialRun} />
      ) : (
        <div className="prospect-empty-state">
          <strong>No discovery runs yet</strong>
          <span>Start the fixed preset to begin collecting staged prospects.</span>
        </div>
      )}
    </div>
  );
}
