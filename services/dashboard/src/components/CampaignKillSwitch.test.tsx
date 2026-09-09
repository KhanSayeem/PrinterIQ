import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CampaignActionState, CampaignSendingState } from "@/app/actions/campaign-actions-core";
import { CampaignKillSwitch } from "./CampaignKillSwitch";

const liveState: CampaignSendingState = {
  summary: "live",
  rows: [
    {
      campaignId: "campaign-preview",
      label: "Website preview campaign",
      status: { code: 1, label: "active", live: true },
      error: null,
    },
    {
      campaignId: "campaign-no-website",
      label: "No website campaign",
      status: { code: 2, label: "paused", live: false },
      error: null,
    },
  ],
};

const pausedState: CampaignSendingState = {
  summary: "paused",
  rows: [
    {
      campaignId: "campaign-preview",
      label: "Website preview campaign",
      status: { code: 2, label: "paused", live: false },
      error: null,
    },
  ],
};

function renderSwitch(
  overrides: {
    state?: CampaignSendingState;
    stopSending?: (previous: CampaignActionState, formData: FormData) => Promise<CampaignActionState>;
    resumeSending?: (previous: CampaignActionState, formData: FormData) => Promise<CampaignActionState>;
  } = {},
) {
  const actions = {
    stopSending:
      overrides.stopSending ??
      vi.fn(async (): Promise<CampaignActionState> => ({
        ok: true,
        message: "Paused 2 of 2 campaigns. Instantly confirms sending is stopped.",
        outcomes: [],
      })),
    resumeSending:
      overrides.resumeSending ??
      vi.fn(async (): Promise<CampaignActionState> => ({
        ok: true,
        message: "Resumed 1 of 1 campaign. Instantly confirms sending is live.",
        outcomes: [],
      })),
  };

  render(<CampaignKillSwitch state={overrides.state ?? liveState} actions={actions} />);

  return actions;
}

describe("CampaignKillSwitch state display", () => {
  it("shows that sending is live when any campaign is active", () => {
    renderSwitch();

    expect(screen.getByRole("status", { name: "Current sending state" })).toHaveTextContent(
      "Sending is LIVE",
    );
    expect(screen.getByText("Website preview campaign")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("paused")).toBeInTheDocument();
  });

  it("shows that sending is paused when every campaign is confirmed paused", () => {
    renderSwitch({ state: pausedState });

    expect(screen.getByRole("status", { name: "Current sending state" })).toHaveTextContent(
      "Sending is PAUSED",
    );
  });

  it("says the state is unknown rather than implying it is safe", () => {
    renderSwitch({
      state: {
        summary: "unknown",
        rows: [
          {
            campaignId: "campaign-preview",
            label: "Website preview campaign",
            status: { code: null, label: "unknown", live: null },
            error: "Instantly API GET /api/v2/campaigns/campaign-preview failed with 500",
          },
        ],
      },
    });

    expect(screen.getByRole("status", { name: "Current sending state" })).toHaveTextContent(
      "Sending state UNKNOWN",
    );
    expect(screen.getByText(/failed with 500/)).toBeInTheDocument();
  });

  it("says plainly when no campaign is configured", () => {
    renderSwitch({ state: { summary: "unconfigured", rows: [] } });

    expect(screen.getByRole("status", { name: "Current sending state" })).toHaveTextContent(
      "NO CAMPAIGN CONFIGURED",
    );
  });
});

describe("CampaignKillSwitch confirmation gate", () => {
  it("does not call the stop action on the first click", () => {
    const actions = renderSwitch();

    fireEvent.click(screen.getByRole("button", { name: "Stop all sending" }));

    expect(actions.stopSending).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Type STOP to confirm")).toBeInTheDocument();
  });

  it("keeps the confirm button disabled until the phrase is typed exactly", () => {
    renderSwitch();

    fireEvent.click(screen.getByRole("button", { name: "Stop all sending" }));
    expect(screen.getByRole("button", { name: "Confirm stop" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Type STOP to confirm"), { target: { value: "sto" } });
    expect(screen.getByRole("button", { name: "Confirm stop" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Type STOP to confirm"), { target: { value: "STOP" } });
    expect(screen.getByRole("button", { name: "Confirm stop" })).toBeEnabled();
  });

  it("cancels without calling the stop action", () => {
    const actions = renderSwitch();

    fireEvent.click(screen.getByRole("button", { name: "Stop all sending" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel stop" }));

    expect(actions.stopSending).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Type STOP to confirm")).not.toBeInTheDocument();
  });

  it("sends the typed confirmation with the stop request", async () => {
    const actions = renderSwitch();

    fireEvent.click(screen.getByRole("button", { name: "Stop all sending" }));
    fireEvent.change(screen.getByLabelText("Type STOP to confirm"), { target: { value: "STOP" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm stop" }));

    await waitFor(() => expect(actions.stopSending).toHaveBeenCalled());
    const submitted = vi.mocked(actions.stopSending).mock.calls[0]![1];
    expect(submitted.get("confirmation")).toBe("STOP");
    expect(
      await screen.findByText("Paused 2 of 2 campaigns. Instantly confirms sending is stopped."),
    ).toBeInTheDocument();
  });
});

describe("CampaignKillSwitch reporting", () => {
  it("shows a partial failure as a failure, with the per campaign reason", async () => {
    const stopSending = vi.fn(async (): Promise<CampaignActionState> => ({
      ok: false,
      message: "Paused 1 of 2 campaigns. 1 failed and may still be sending.",
      outcomes: [
        {
          campaignId: "campaign-preview",
          label: "Website preview campaign",
          ok: true,
          status: { code: 2, label: "paused", live: false },
          detail: "Instantly confirms this campaign is paused.",
        },
        {
          campaignId: "campaign-no-website",
          label: "No website campaign",
          ok: false,
          status: { code: null, label: "unknown", live: null },
          detail: "Instantly rejected the call: failed with 500",
        },
      ],
    }));
    renderSwitch({ stopSending });

    fireEvent.click(screen.getByRole("button", { name: "Stop all sending" }));
    fireEvent.change(screen.getByLabelText("Type STOP to confirm"), { target: { value: "STOP" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm stop" }));

    const result = await screen.findByRole("alert");
    expect(result).toHaveTextContent("Paused 1 of 2 campaigns. 1 failed and may still be sending.");
    expect(result).toHaveTextContent("Instantly rejected the call: failed with 500");
    expect(result).toHaveTextContent("Instantly confirms this campaign is paused.");
  });

  it("never reports success when the stop action throws", async () => {
    const stopSending = vi.fn(async (): Promise<CampaignActionState> => {
      throw new Error("fetch failed");
    });
    renderSwitch({ stopSending });

    fireEvent.click(screen.getByRole("button", { name: "Stop all sending" }));
    fireEvent.change(screen.getByLabelText("Type STOP to confirm"), { target: { value: "STOP" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm stop" }));

    const result = await screen.findByRole("alert");
    expect(result).toHaveTextContent(
      "Stop request failed before Instantly confirmed anything. Assume sending is still live and check Instantly directly.",
    );
    expect(result).not.toHaveTextContent("stopped");
  });
});

describe("CampaignKillSwitch resume", () => {
  it("requires its own typed confirmation", async () => {
    const actions = renderSwitch({ state: pausedState });

    fireEvent.click(screen.getByRole("button", { name: "Resume sending" }));
    expect(actions.resumeSending).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm resume" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Type RESUME to confirm"), { target: { value: "RESUME" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm resume" }));

    await waitFor(() => expect(actions.resumeSending).toHaveBeenCalled());
    const submitted = vi.mocked(actions.resumeSending).mock.calls[0]![1];
    expect(submitted.get("confirmation")).toBe("RESUME");
    expect(
      await screen.findByText("Resumed 1 of 1 campaign. Instantly confirms sending is live."),
    ).toBeInTheDocument();
  });

  it("never reports success when the resume action throws", async () => {
    const resumeSending = vi.fn(async (): Promise<CampaignActionState> => {
      throw new Error("fetch failed");
    });
    renderSwitch({ state: pausedState, resumeSending });

    fireEvent.click(screen.getByRole("button", { name: "Resume sending" }));
    fireEvent.change(screen.getByLabelText("Type RESUME to confirm"), { target: { value: "RESUME" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm resume" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Resume request failed before Instantly confirmed anything. Sending was not resumed.",
    );
  });
});
