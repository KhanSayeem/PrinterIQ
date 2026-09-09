import { loadCampaignSendingState } from "@/app/actions/campaign-actions";
import type { CampaignSendingState } from "@/app/actions/campaign-actions-core";
import { readSendRate } from "@/app/actions/send-rate-actions";
import { CampaignKillSwitch } from "@/components/CampaignKillSwitch";
import { SendRateControl } from "@/components/SendRateControl";

export const dynamic = "force-dynamic";

function loadErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown campaign state error";
}

/**
 * Everything that changes how much mail leaves, on one page.
 *
 * The stop control comes first and the ramp second, deliberately. An operator
 * arriving here during a bad send is looking for the brake, and making them
 * scroll past a form of daily limits to find it would cost the seconds this
 * page exists to save.
 *
 * The two halves fail independently. Instantly being unreadable for campaign
 * state says nothing about whether the accounts endpoint answers, so one
 * failing renders its own error and the other still works. Collapsing them
 * into a single "sending is unavailable" would hide a working brake behind a
 * broken ramp.
 */
export default async function SendingPage() {
  let campaignState: CampaignSendingState | null = null;
  let campaignError: string | null = null;

  try {
    campaignState = await loadCampaignSendingState();
  } catch (error) {
    campaignError = loadErrorMessage(error);
    console.error("Failed to read Instantly campaign state", { message: campaignError });
  }

  const rateState = await readSendRate();

  return (
    <>
      <div className="page-header">
        <div className="page-title-wrap">
          <div className="page-title">Sending</div>
          <div className="page-subtitle">
            Emergency stop and the ADR 005 volume ramp, both read straight from Instantly
          </div>
        </div>
      </div>

      <div className="sending-screen">
        {campaignState ? (
          <CampaignKillSwitch state={campaignState} />
        ) : (
          <div className="error-state">
            Could not read the Instantly campaign state, so this page cannot tell you whether
            sending is live. Check INSTANTLY_API_KEY and Instantly connectivity, and pause from the
            Instantly UI if you need to stop sending now.
            {process.env.NODE_ENV !== "production" && campaignError ? (
              <div className="error-detail">{campaignError}</div>
            ) : null}
          </div>
        )}
      </div>

      <div className="send-rate-screen">
        {rateState.ok && rateState.snapshot ? (
          <SendRateControl snapshot={rateState.snapshot} />
        ) : (
          <div className="error-state">
            Send rate is unavailable, and no daily limit has been changed. {rateState.message}
          </div>
        )}
      </div>
    </>
  );
}
