import { loadCampaignSendingState } from "@/app/actions/campaign-actions";
import { CampaignKillSwitch } from "@/components/CampaignKillSwitch";
import type { CampaignSendingState } from "@/app/actions/campaign-actions-core";

export const dynamic = "force-dynamic";

function loadErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown campaign state error";
}

export default async function SendingPage() {
  let state: CampaignSendingState;

  try {
    state = await loadCampaignSendingState();
  } catch (error) {
    const message = loadErrorMessage(error);
    console.error("Failed to read Instantly campaign state", { message });

    return (
      <div className="error-state">
        Could not read the Instantly campaign state, so this page cannot tell you whether sending is
        live. Check INSTANTLY_API_KEY and Instantly connectivity, and pause from the Instantly UI if
        you need to stop sending now.
        {process.env.NODE_ENV !== "production" ? <div className="error-detail">{message}</div> : null}
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <div className="page-title-wrap">
          <div className="page-title">Sending</div>
          <div className="page-subtitle">
            Emergency stop for the live Instantly campaigns, read straight from Instantly
          </div>
        </div>
      </div>
      <div className="sending-screen">
        <CampaignKillSwitch state={state} />
      </div>
    </>
  );
}
