import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeliverabilityPanel } from "./DeliverabilityPanel";
import { buildDeliverabilityReport, type MailboxSends } from "@/lib/deliverability";
import type { InstantlyAccount, InstantlyDailyAccountAnalytics } from "@/clients/instantly";

const TODAY = "2026-09-09";

function account(overrides: Partial<InstantlyAccount> = {}): InstantlyAccount {
  return {
    email: "murphy@presciaweb.com",
    timestamp_created: "2026-06-17T00:00:00.000Z",
    warmup_status: 1,
    status: 1,
    daily_limit: 20,
    stat_warmup_score: 100,
    setup_pending: false,
    ...overrides,
  };
}

function day(
  date: string,
  sent: number,
  bounced: number,
  email = "murphy@presciaweb.com",
): InstantlyDailyAccountAnalytics {
  return { date, email_account: email, sent, bounced };
}

function counts(entries: Record<string, number>) {
  return new Map(Object.entries(entries).map(([email, sent]) => [email.toLowerCase(), sent]));
}

/**
 * Per email send counts as /deliverability loads them. Left out, today reads a
 * real zero for every account and there are no completed days for the ramp.
 */
function sends(
  accounts: InstantlyAccount[],
  options: {
    sentToday?: Record<string, number>;
    completedDays?: ReadonlyArray<readonly [string, Record<string, number>]>;
  } = {},
): MailboxSends {
  const sentToday =
    options.sentToday ?? Object.fromEntries(accounts.map((item) => [item.email, 0]));
  return {
    today: { available: true, value: counts(sentToday) },
    completedDays: {
      available: true,
      value: (options.completedDays ?? []).map(([date, byMailbox]) => ({
        date,
        byMailbox: counts(byMailbox),
      })),
    },
  };
}

function renderReport(
  accounts: InstantlyAccount[],
  analytics: InstantlyDailyAccountAnalytics[] | null,
  options: Parameters<typeof sends>[1] = {},
) {
  return render(
    <DeliverabilityPanel
      report={buildDeliverabilityReport({ accounts, analytics, sends: sends(accounts, options) })}
    />,
  );
}

describe("DeliverabilityPanel per mailbox", () => {
  it("shows the mailbox, its domain, warmup, limit usage, bounce rate and score", () => {
    renderReport([account()], [day(TODAY, 15, 0), day("2026-09-08", 85, 1)], {
      sentToday: { "murphy@presciaweb.com": 15 },
    });

    const card = screen.getByRole("group", { name: "murphy@presciaweb.com" });
    expect(within(card).getByText("presciaweb.com")).toBeInTheDocument();
    expect(within(card).getByText("Warmup active")).toBeInTheDocument();
    expect(within(card).getByText("Active")).toBeInTheDocument();
    expect(within(card).getByText("20")).toBeInTheDocument();
    expect(within(card).getByText("15")).toBeInTheDocument();
    expect(within(card).getByText("75.0%")).toBeInTheDocument();
    expect(within(card).getByText("1.0%")).toBeInTheDocument();
    expect(within(card).getByText("100")).toBeInTheDocument();
  });

  it("marks a paused account as paused", () => {
    renderReport([account({ status: 2 })], [day("2026-09-08", 100, 0)]);

    const card = screen.getByRole("group", { name: "murphy@presciaweb.com" });
    expect(within(card).getByText("Paused")).toBeInTheDocument();
  });

  it("flags a warmup that is switched off", () => {
    renderReport([account({ warmup_status: 0 })], [day("2026-09-08", 100, 0)]);

    const card = screen.getByRole("group", { name: "murphy@presciaweb.com" });
    expect(within(card).getByText("Warmup off")).toBeInTheDocument();
    expect(within(card).getByText("Warmup is not running")).toBeInTheDocument();
  });
});

describe("DeliverabilityPanel threshold breaches", () => {
  it("makes a bounce rate above 3% visually obvious rather than a number in a table", () => {
    renderReport([account()], [day("2026-09-08", 1000, 31)]);

    const card = screen.getByRole("group", { name: "murphy@presciaweb.com" });
    expect(card).toHaveClass("deliv-card-critical");
    expect(within(card).getByText("Bounce rate above 3%")).toBeInTheDocument();
    expect(within(card).getByText("3.1%")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Stop sending and investigate");
  });

  it("does not flag a bounce rate exactly on the 3% line", () => {
    renderReport([account()], [day("2026-09-08", 1000, 30)]);

    const card = screen.getByRole("group", { name: "murphy@presciaweb.com" });
    expect(card).not.toHaveClass("deliv-card-critical");
    expect(screen.queryByText("Bounce rate above 3%")).not.toBeInTheDocument();
  });

  it("does not flag a bounce rate just below the 3% line", () => {
    renderReport([account()], [day("2026-09-08", 1000, 29)]);

    expect(screen.getByRole("group", { name: "murphy@presciaweb.com" })).not.toHaveClass(
      "deliv-card-critical",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Safe to keep sending");
  });

  it("flags a day over day increase above Google's published 100% band", () => {
    renderReport([account()], [day("2026-09-07", 40, 0), day("2026-09-08", 81, 0)], {
      completedDays: [
        ["2026-09-07", { "murphy@presciaweb.com": 40 }],
        ["2026-09-08", { "murphy@presciaweb.com": 81 }],
      ],
    });

    const card = screen.getByRole("group", { name: "murphy@presciaweb.com" });
    expect(card).toHaveClass("deliv-card-warning");
    expect(within(card).getByText("Ramping faster than Google's band")).toBeInTheDocument();
  });

  it("does not flag a day over day increase of exactly 100%", () => {
    renderReport([account()], [day("2026-09-07", 40, 0), day("2026-09-08", 80, 0)], {
      completedDays: [
        ["2026-09-07", { "murphy@presciaweb.com": 40 }],
        ["2026-09-08", { "murphy@presciaweb.com": 80 }],
      ],
    });

    expect(screen.getByRole("group", { name: "murphy@presciaweb.com" })).not.toHaveClass(
      "deliv-card-warning",
    );
  });

  it("cites the published guidance the thresholds come from", () => {
    renderReport([account()], [day("2026-09-08", 100, 0)]);

    expect(screen.getByText(/0\.1%/)).toBeInTheDocument();
    expect(screen.getByText(/0\.3%/)).toBeInTheDocument();
    expect(screen.getByText(/25% to 100%/)).toBeInTheDocument();
  });
});

describe("DeliverabilityPanel unavailable metrics", () => {
  it("shows a missing daily limit and warmup score as not available, never as zero", () => {
    renderReport(
      [account({ daily_limit: null, stat_warmup_score: null })],
      [day(TODAY, 5, 0), day("2026-09-08", 100, 2)],
      { sentToday: { "murphy@presciaweb.com": 5 } },
    );

    const card = screen.getByRole("group", { name: "murphy@presciaweb.com" });
    expect(within(card).getAllByText("Not available").length).toBeGreaterThanOrEqual(3);
    expect(within(card).queryByText("0")).not.toBeInTheDocument();
    expect(within(card).queryByText("0.0%")).not.toBeInTheDocument();
  });

  it("shows the bounce rate as not available rather than 0% when nothing has been sent", () => {
    renderReport([account()], [day("2026-09-08", 0, 0)]);

    const card = screen.getByRole("group", { name: "murphy@presciaweb.com" });
    const bounceRow = within(card).getByRole("group", { name: /Bounce rate/ });
    expect(within(bounceRow).getByText("Not available")).toBeInTheDocument();
    expect(within(bounceRow).queryByText("0.0%")).not.toBeInTheDocument();
  });

  it("says the verdict is unknown rather than healthy when analytics did not load", () => {
    renderReport([account()], null);

    expect(screen.getByRole("status")).toHaveTextContent("Not enough data to judge");
    expect(screen.getByRole("status")).not.toHaveTextContent("Safe to keep sending");
  });

  it("reports the spam complaint rate as unavailable because Instantly does not expose one", () => {
    renderReport([account()], [day("2026-09-08", 100, 0)]);

    const spam = screen.getByRole("group", { name: /Spam complaint rate/ });
    expect(within(spam).getByText("Not available")).toBeInTheDocument();
    expect(within(spam).getAllByText(/Google Postmaster Tools/).length).toBeGreaterThan(0);
  });
});

describe("DeliverabilityPanel estate cards", () => {
  function estateCard(label: string) {
    const heading = [...document.querySelectorAll(".metric-label")].find(
      (node) => node.textContent === label,
    );
    return (heading?.closest(".metric-card") ?? null) as HTMLElement | null;
  }

  it("sends the estate daily limit to the page where the limit is set", () => {
    renderReport([account()], [day(TODAY, 15, 0)]);

    const card = estateCard("Estate daily limit");
    expect(card).toHaveAttribute("href", "/sending");
    expect(card).toHaveClass("is-clickable");
  });

  it("puts the estate daily limit card in the tab order as a real link", () => {
    renderReport([account()], [day(TODAY, 15, 0)]);

    const card = estateCard("Estate daily limit");
    expect(card?.tagName).toBe("A");
    expect(card).not.toHaveAttribute("tabindex", "-1");
    card?.focus();
    expect(document.activeElement).toBe(card);
  });

  it("leaves the cards whose breakdown is already on this page unlinked", () => {
    renderReport([account()], [day(TODAY, 15, 0)]);

    expect(estateCard("Sent today")).not.toHaveAttribute("href");
    expect(estateCard("Sent today")?.tagName).toBe("DIV");
    expect(estateCard("Spam complaint rate")).not.toHaveAttribute("href");
    expect(estateCard("Spam complaint rate")?.tagName).toBe("DIV");
  });
});

describe("DeliverabilityPanel empty state", () => {
  it("says no sending accounts were returned instead of rendering a healthy estate", () => {
    renderReport([], []);

    expect(screen.getByText("Instantly returned no sending accounts.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /@/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Not enough data to judge");
  });
});

describe("DeliverabilityPanel notice", () => {
  it("surfaces a loading problem passed in by the page", () => {
    render(
      <DeliverabilityPanel
        report={buildDeliverabilityReport({
          accounts: [account()],
          analytics: null,
          sends: sends([account()]),
        })}
        notice="Daily analytics could not be loaded from Instantly."
      />,
    );

    expect(screen.getByText("Daily analytics could not be loaded from Instantly.")).toBeInTheDocument();
  });
});
