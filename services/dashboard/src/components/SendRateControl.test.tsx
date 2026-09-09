import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SendRateSnapshot } from "@/app/actions/send-rate-actions-core";
import { SendRateControl } from "./SendRateControl";

vi.mock("@/app/actions/send-rate-actions", () => ({
  applySendRate: vi.fn(),
}));

const snapshot: SendRateSnapshot = {
  accounts: [
    { email: "murphy@presciaweb.com", dailyLimit: 4, status: 1 },
    { email: "dana@presciaweb.com", dailyLimit: 3, status: 1 },
  ],
  campaignDailyTotal: 7,
  mailboxCount: 2,
  excludedAccountCount: 1,
  nextRampStep: 30,
  rampComplete: false,
  ramp: [30, 45, 68, 101, 152, 155],
};

function renderControl(applySendRate = vi.fn()) {
  render(<SendRateControl snapshot={snapshot} applySendRate={applySendRate} />);
  return applySendRate;
}

describe("SendRateControl", () => {
  it("shows the campaign total, each mailbox limit and the next ramp step", () => {
    renderControl();

    expect(screen.getByLabelText("Campaign daily total")).toHaveTextContent("7");
    expect(screen.getByLabelText("Next ramp step")).toHaveTextContent("30");
    expect(screen.getByText("murphy@presciaweb.com")).toBeInTheDocument();
    expect(screen.getByText("dana@presciaweb.com")).toBeInTheDocument();
    expect(screen.getByText(/1 Instantly account outside/i)).toBeInTheDocument();
  });

  it("prefills the next ramp step when the operator asks for it", () => {
    renderControl();

    fireEvent.click(screen.getByRole("button", { name: /use next ramp step/i }));

    expect(screen.getByLabelText<HTMLInputElement>(/new campaign daily total/i).value).toBe("30");
  });

  it("asks for explicit confirmation before applying an over doubling increase", async () => {
    const applySendRate = vi.fn().mockResolvedValue({
      ok: false,
      requiresConfirmation: true,
      requestedDailyTotal: 30,
      currentDailyTotal: 7,
      message:
        "30 per day is more than double the current 7. Google describes a common daily increase of 25% to 100%.",
    });
    renderControl(applySendRate);

    fireEvent.change(screen.getByLabelText(/new campaign daily total/i), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^apply to mailboxes$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /confirm and apply anyway/i })).toBeEnabled();
    });
    expect(applySendRate.mock.calls[0]![1].get("confirmOverDoubling")).toBe("no");

    fireEvent.click(screen.getByRole("button", { name: /confirm and apply anyway/i }));

    await waitFor(() => {
      expect(applySendRate).toHaveBeenCalledTimes(2);
    });
    expect(applySendRate.mock.calls[1]![1].get("confirmOverDoubling")).toBe("yes");
  });

  it("reports per mailbox failures instead of a bare success message", async () => {
    const applySendRate = vi.fn().mockResolvedValue({
      ok: false,
      message: "Applied to 1 of 2 mailboxes. 1 failed.",
      effectiveDailyTotal: 19,
      outcomes: [
        {
          email: "murphy@presciaweb.com",
          previousDailyLimit: 4,
          requestedDailyLimit: 15,
          changed: true,
        },
        {
          email: "dana@presciaweb.com",
          previousDailyLimit: 3,
          requestedDailyLimit: 15,
          changed: false,
          error: "Instantly API PATCH /api/v2/accounts/{email} failed with 422",
        },
      ],
    });
    renderControl(applySendRate);

    fireEvent.change(screen.getByLabelText(/new campaign daily total/i), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^apply to mailboxes$/i }));

    await waitFor(() => {
      expect(screen.getByText("Applied to 1 of 2 mailboxes. 1 failed.")).toBeInTheDocument();
    });
    const results = within(screen.getByRole("table", { name: /applied daily limit results/i }));
    expect(results.getByRole("row", { name: /dana@presciaweb.com/ })).toHaveTextContent("422");
    expect(results.getByRole("row", { name: /dana@presciaweb.com/ })).toHaveTextContent(
      /not changed/i,
    );
    expect(results.getByRole("row", { name: /murphy@presciaweb.com/ })).toHaveTextContent(
      /changed/i,
    );
  });

  it("surfaces a thrown action error rather than silently reporting nothing", async () => {
    const applySendRate = vi.fn().mockRejectedValue(new Error("boom"));
    renderControl(applySendRate);

    fireEvent.change(screen.getByLabelText(/new campaign daily total/i), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^apply to mailboxes$/i }));

    await waitFor(() => {
      expect(screen.getByText(/no daily limit was changed/i)).toBeInTheDocument();
    });
  });
});
