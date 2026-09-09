import { readSendRate } from "@/app/actions/send-rate-actions";
import { SendRateControl } from "@/components/SendRateControl";

export default async function SendingPage() {
  const state = await readSendRate();

  return (
    <>
      <div className="page-header">
        <div className="page-title-wrap">
          <div className="page-title">Sending</div>
          <div className="page-subtitle">
            Per-mailbox daily limits and the ADR 005 volume ramp
          </div>
        </div>
      </div>
      {state.ok && state.snapshot ? (
        <div className="send-rate-screen">
          <SendRateControl snapshot={state.snapshot} />
        </div>
      ) : (
        <div className="error-state">
          Send rate is unavailable, and no daily limit has been changed. {state.message}
        </div>
      )}
    </>
  );
}
