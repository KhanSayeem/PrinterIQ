"use client";

import { AlertTriangle, Gauge, TrendingUp } from "lucide-react";
import { useState, useTransition } from "react";
import { applySendRate as defaultApplySendRate } from "@/app/actions/send-rate-actions";
import {
  initialSendRateActionState,
  type SendRateActionState,
  type SendRateSnapshot,
} from "@/app/actions/send-rate-actions-core";
import { MetricCardShell } from "./MetricCardShell";

type ApplySendRate = (
  previousState: SendRateActionState,
  formData: FormData,
) => Promise<SendRateActionState>;

const THROWN_ACTION_MESSAGE =
  "The send rate request did not complete, so no daily limit was changed that this dashboard can confirm. Check Instantly connectivity and the current limits below before retrying.";

function formatLimit(limit: number | null) {
  return limit === null ? "not set" : String(limit);
}

export function SendRateControl({
  snapshot,
  applySendRate = defaultApplySendRate,
}: {
  snapshot: SendRateSnapshot;
  applySendRate?: ApplySendRate;
}) {
  const [dailyTotal, setDailyTotal] = useState("");
  const [result, setResult] = useState<SendRateActionState | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(confirmOverDoubling: boolean, requestedTotal: string) {
    const formData = new FormData();
    formData.set("dailyTotal", requestedTotal);
    formData.set("confirmOverDoubling", confirmOverDoubling ? "yes" : "no");

    startTransition(async () => {
      try {
        setResult(await applySendRate(initialSendRateActionState, formData));
      } catch {
        setResult({ ok: false, message: THROWN_ACTION_MESSAGE });
      }
    });
  }

  const nextStepLabel = snapshot.rampComplete
    ? "ramp complete"
    : String(snapshot.nextRampStep ?? "unknown");

  return (
    <div className="send-rate-content">
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-label">Campaign daily total</div>
          <div className="metric-value" aria-label="Campaign daily total">
            {snapshot.campaignDailyTotal}
          </div>
          <div className="metric-delta">sum of the mailbox daily limits below</div>
        </div>
        {/* The mailboxes themselves, with their health, live on the
            deliverability page. */}
        <MetricCardShell className="metric-card" href="/deliverability">
          <div className="metric-label">Mailboxes in scope</div>
          <div className="metric-value" aria-label="Mailboxes in scope">
            {snapshot.mailboxCount}
          </div>
          <div className="metric-delta">
            {snapshot.excludedAccountCount === 0
              ? "every Instantly account is a PrinterIQ mailbox"
              : `${snapshot.excludedAccountCount} Instantly account${snapshot.excludedAccountCount === 1 ? "" : "s"} outside the PrinterIQ sending domains, left untouched`}
          </div>
        </MetricCardShell>
        <div className="metric-card">
          <div className="metric-label">Next ramp step</div>
          <div className="metric-value" aria-label="Next ramp step">
            {nextStepLabel}
          </div>
          <div className="metric-delta">ADR 005: {snapshot.ramp.join(" · ")}</div>
        </div>
      </div>

      <div className="ai-card send-rate-card">
        <div className="ai-card-title">Set the daily limit</div>
        <div className="ai-card-sub">
          The requested campaign total is split across the mailboxes in scope and written to each
          one as its Instantly daily limit. This does not change the campaign level daily limit in
          Instantly, which can still cap sending lower.
        </div>

        <form
          className="send-rate-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit(false, dailyTotal);
          }}
        >
          <label className="form-label" htmlFor="send-rate-total">
            New campaign daily total
          </label>
          <div className="send-rate-input-row">
            <input
              id="send-rate-total"
              name="dailyTotal"
              className="form-input send-rate-input"
              type="number"
              min={1}
              inputMode="numeric"
              value={dailyTotal}
              onChange={(event) => setDailyTotal(event.target.value)}
            />
            <button
              className="btn btn-ghost"
              type="button"
              disabled={isPending || snapshot.nextRampStep === null}
              onClick={() => setDailyTotal(String(snapshot.nextRampStep ?? ""))}
            >
              <TrendingUp size={14} />
              Use next ramp step
            </button>
            <button className="btn btn-primary" type="submit" disabled={isPending}>
              <Gauge size={14} />
              Apply to mailboxes
            </button>
          </div>
        </form>

        {result?.requiresConfirmation ? (
          <div className="send-rate-warning" role="alert">
            <div className="send-rate-warning-head">
              <AlertTriangle size={15} aria-hidden="true" />
              Increase is more than a doubling
            </div>
            <p className="send-rate-warning-copy">{result.message}</p>
            <button
              className="btn btn-primary"
              type="button"
              disabled={isPending}
              onClick={() => submit(true, String(result.requestedDailyTotal ?? dailyTotal))}
            >
              Confirm and apply anyway
            </button>
          </div>
        ) : null}

        {result && !result.requiresConfirmation && result.message ? (
          <div className={result.ok ? "import-status success" : "import-status error"}>
            {result.message}
          </div>
        ) : null}

        {result?.outcomes?.length ? (
          <table className="send-rate-outcomes" aria-label="Applied daily limit results">
            <thead>
              <tr>
                <th scope="col">Mailbox</th>
                <th scope="col">Was</th>
                <th scope="col">Requested</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {result.outcomes.map((outcome) => (
                <tr key={outcome.email}>
                  <td className="td-name">{outcome.email}</td>
                  <td className="td-muted">{formatLimit(outcome.previousDailyLimit)}</td>
                  <td className="td-muted">{outcome.requestedDailyLimit}</td>
                  <td>
                    {outcome.changed ? (
                      <span className="badge s-paid">changed</span>
                    ) : (
                      <>
                        <span className="badge s-archived">not changed</span>
                        <span className="send-rate-outcome-error">{outcome.error}</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <div className="ai-card send-rate-card">
        <div className="ai-card-title">Mailbox daily limits</div>
        <div className="ai-card-sub">Read from Instantly when this page loaded</div>
        {snapshot.accounts.length === 0 ? (
          <div className="empty-inline">No PrinterIQ mailbox found in Instantly.</div>
        ) : (
          <table className="send-rate-accounts" aria-label="Mailbox daily limits read from Instantly">
            <thead>
              <tr>
                <th scope="col">Mailbox</th>
                <th scope="col">Daily limit</th>
                <th scope="col">Account status</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.accounts.map((account) => (
                <tr key={account.email}>
                  <td className="td-name">{account.email}</td>
                  <td className="td-muted">{formatLimit(account.dailyLimit)}</td>
                  <td className="td-muted">{account.status === 1 ? "active" : `code ${account.status ?? "unknown"}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
