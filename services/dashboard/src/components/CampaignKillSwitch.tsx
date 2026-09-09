"use client";

import { useState, useTransition } from "react";
import { OctagonX, Play, X } from "lucide-react";
import { resumeSending, stopSending } from "@/app/actions/campaign-actions";
import {
  initialCampaignActionState,
  RESUME_CONFIRMATION_PHRASE,
  STOP_CONFIRMATION_PHRASE,
  type CampaignActionState,
  type CampaignSendingState,
} from "@/app/actions/campaign-actions-core";

type CampaignAction = (
  previousState: CampaignActionState,
  formData: FormData,
) => Promise<CampaignActionState>;

export type CampaignKillSwitchActions = {
  stopSending: CampaignAction;
  resumeSending: CampaignAction;
};

const defaultActions: CampaignKillSwitchActions = {
  stopSending,
  resumeSending,
};

const SUMMARY_COPY = {
  live: {
    headline: "Sending is LIVE",
    note: "Instantly reports at least one campaign sending right now.",
    tone: "live",
  },
  paused: {
    headline: "Sending is PAUSED",
    note: "Instantly reports every configured campaign paused.",
    tone: "paused",
  },
  unknown: {
    headline: "Sending state UNKNOWN",
    note: "Instantly did not answer for at least one campaign. Do not assume sending has stopped.",
    tone: "unknown",
  },
  unconfigured: {
    headline: "NO CAMPAIGN CONFIGURED",
    note: "This dashboard has no Instantly campaign id, so this control cannot pause anything. Set INSTANTLY_CAMPAIGN_ID.",
    tone: "unknown",
  },
} as const;

const STOP_FAILURE_MESSAGE =
  "Stop request failed before Instantly confirmed anything. Assume sending is still live and check Instantly directly.";
const RESUME_FAILURE_MESSAGE =
  "Resume request failed before Instantly confirmed anything. Sending was not resumed.";

export function CampaignKillSwitch({
  state,
  actions = defaultActions,
}: {
  state: CampaignSendingState;
  actions?: CampaignKillSwitchActions;
}) {
  const [openConfirm, setOpenConfirm] = useState<"stop" | "resume" | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [result, setResult] = useState<CampaignActionState | null>(null);
  const [isPending, startTransition] = useTransition();

  const summary = SUMMARY_COPY[state.summary];

  function openPanel(panel: "stop" | "resume") {
    setConfirmText("");
    setOpenConfirm((current) => (current === panel ? null : panel));
  }

  function closePanel() {
    setConfirmText("");
    setOpenConfirm(null);
  }

  function run(action: CampaignAction, formData: FormData, failureMessage: string) {
    startTransition(async () => {
      try {
        const actionResult = await action(initialCampaignActionState, formData);
        setResult(actionResult);
      } catch {
        setResult({ ok: false, message: failureMessage, outcomes: [] });
      }
      closePanel();
    });
  }

  const stopReady = confirmText.trim().toUpperCase() === STOP_CONFIRMATION_PHRASE;
  const resumeReady = confirmText.trim().toUpperCase() === RESUME_CONFIRMATION_PHRASE;

  return (
    <section className="kill-switch" aria-label="Campaign emergency stop">
      <div className={`kill-switch-state kill-switch-state-${summary.tone}`}>
        <div role="status" aria-label="Current sending state">
          <div className="kill-switch-headline">{summary.headline}</div>
          <div className="kill-switch-note">{summary.note}</div>
        </div>
      </div>

      {state.rows.length > 0 ? (
        <ul className="kill-switch-campaigns" aria-label="Campaign states">
          {state.rows.map((row) => (
            <li key={row.campaignId} className="kill-switch-campaign">
              <div className="kill-switch-campaign-main">
                <div className="kill-switch-campaign-label">{row.label}</div>
                <div className="kill-switch-campaign-id">{row.campaignId}</div>
              </div>
              <span className={`kill-switch-status kill-switch-status-${row.status.live === true ? "live" : row.status.live === false ? "paused" : "unknown"}`}>
                {row.status.label}
              </span>
              {row.error ? <div className="kill-switch-campaign-error">{row.error}</div> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="kill-switch-controls" role="group" aria-label="Sending controls">
        <button
          type="button"
          className="btn kill-switch-stop-btn"
          disabled={isPending}
          onClick={() => openPanel("stop")}
        >
          <OctagonX size={14} aria-hidden="true" />
          Stop all sending
        </button>
        <button
          type="button"
          className="btn"
          disabled={isPending}
          onClick={() => openPanel("resume")}
        >
          <Play size={14} aria-hidden="true" />
          Resume sending
        </button>
      </div>

      {openConfirm === "stop" ? (
        <form
          className="kill-switch-confirm"
          action={(formData) => run(actions.stopSending, formData, STOP_FAILURE_MESSAGE)}
        >
          <div className="kill-switch-confirm-header">
            <label className="form-label" htmlFor="kill-switch-stop-confirmation">
              Type {STOP_CONFIRMATION_PHRASE} to confirm
            </label>
            <button
              type="button"
              className="dp-icon-btn"
              aria-label="Cancel stop"
              onClick={closePanel}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <p className="kill-switch-confirm-copy">
            This pauses every configured Instantly campaign for this tenant. In-flight sends already
            handed to Instantly may still land.
          </p>
          <input
            id="kill-switch-stop-confirmation"
            name="confirmation"
            className="form-input"
            autoComplete="off"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
          />
          <button type="submit" className="btn kill-switch-stop-btn" disabled={isPending || !stopReady}>
            Confirm stop
          </button>
        </form>
      ) : null}

      {openConfirm === "resume" ? (
        <form
          className="kill-switch-confirm"
          action={(formData) => run(actions.resumeSending, formData, RESUME_FAILURE_MESSAGE)}
        >
          <div className="kill-switch-confirm-header">
            <label className="form-label" htmlFor="kill-switch-resume-confirmation">
              Type {RESUME_CONFIRMATION_PHRASE} to confirm
            </label>
            <button
              type="button"
              className="dp-icon-btn"
              aria-label="Cancel resume"
              onClick={closePanel}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <p className="kill-switch-confirm-copy">
            This restarts sending for every configured Instantly campaign. Check the copy and the
            bounce rate first.
          </p>
          <input
            id="kill-switch-resume-confirmation"
            name="confirmation"
            className="form-input"
            autoComplete="off"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={isPending || !resumeReady}>
            Confirm resume
          </button>
        </form>
      ) : null}

      {result ? (
        <div className={`kill-switch-result ${result.ok ? "is-ok" : "is-failed"}`} role="alert">
          <div className="kill-switch-result-message">{result.message}</div>
          {result.outcomes.length > 0 ? (
            <ul className="kill-switch-outcomes">
              {result.outcomes.map((outcome) => (
                <li
                  key={outcome.campaignId}
                  className={outcome.ok ? "kill-switch-outcome" : "kill-switch-outcome is-failed"}
                >
                  <span className="kill-switch-outcome-label">{outcome.label}</span>
                  <span className="kill-switch-outcome-detail">{outcome.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
