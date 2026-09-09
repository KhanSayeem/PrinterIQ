import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readSendRateMock } = vi.hoisted(() => ({ readSendRateMock: vi.fn() }));

vi.mock("@/app/actions/send-rate-actions", () => ({
  readSendRate: readSendRateMock,
  applySendRate: vi.fn(),
}));

import SendingPage from "./page";

describe("Sending page", () => {
  beforeEach(() => {
    readSendRateMock.mockReset();
  });

  it("renders the control when the current limits were read", async () => {
    readSendRateMock.mockResolvedValue({
      ok: true,
      message: "",
      snapshot: {
        accounts: [{ email: "murphy@presciaweb.com", dailyLimit: 30, status: 1 }],
        campaignDailyTotal: 30,
        mailboxCount: 1,
        excludedAccountCount: 0,
        nextRampStep: 45,
        rampComplete: false,
        ramp: [30, 45, 68, 101, 152, 155],
      },
    });

    render(await SendingPage());

    expect(screen.getByRole("button", { name: /apply to mailboxes/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Next ramp step")).toHaveTextContent("45");
  });

  it("shows the read failure and no control when Instantly could not be read", async () => {
    readSendRateMock.mockResolvedValue({
      ok: false,
      message: "Could not read the current daily limits from Instantly, so nothing was changed. 503",
    });

    render(await SendingPage());

    expect(screen.queryByRole("button", { name: /apply to mailboxes/i })).toBeNull();
    expect(screen.getByText(/no daily limit has been changed/i)).toBeInTheDocument();
    expect(screen.getByText(/503/)).toBeInTheDocument();
  });
});
