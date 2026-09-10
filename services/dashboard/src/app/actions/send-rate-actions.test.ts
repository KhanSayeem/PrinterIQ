import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireOperatorMock, revalidatePathMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("@/auth/server", () => ({ requireOperator: requireOperatorMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import {
  createSendRateActions,
  initialSendRateActionState,
  parseSendingDomains,
  type SendRateActionDeps,
} from "./send-rate-actions-core";

function accountsFixture() {
  return [
    { email: "a@presciaweb.com", dailyLimit: 4, status: 1 },
    { email: "b@presciaweb.com", dailyLimit: 4, status: 1 },
    { email: "c@presciaweb.com", dailyLimit: 4, status: 1 },
    { email: "d@presciaweb.com", dailyLimit: 4, status: 1 },
    { email: "e@presciaweb.com", dailyLimit: 4, status: 1 },
    { email: "f@presciaweb.com", dailyLimit: 4, status: 1 },
    { email: "g@presciaweb.com", dailyLimit: 3, status: 1 },
    { email: "h@presciaweb.com", dailyLimit: 3, status: 1 },
  ];
}

function createDeps(overrides: Partial<SendRateActionDeps> = {}): SendRateActionDeps {
  return {
    instantly: {
      listSendingAccounts: vi.fn().mockResolvedValue(accountsFixture()),
      updateAccountDailyLimit: vi.fn().mockResolvedValue(undefined),
    },
    allowedDomains: ["presciaweb.com"],
    revalidatePath: vi.fn(),
    ...overrides,
  };
}

function applyForm(values: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }
  return formData;
}

describe("parseSendingDomains", () => {
  it("splits, trims and lowercases a comma separated allowlist", () => {
    expect(parseSendingDomains(" PresciaWeb.com , second.com ")).toEqual([
      "presciaweb.com",
      "second.com",
    ]);
  });

  it("returns an empty allowlist when the variable is unset or blank", () => {
    expect(parseSendingDomains(undefined)).toEqual([]);
    expect(parseSendingDomains("   ")).toEqual([]);
  });
});

describe("send rate read", () => {
  it("reports each mailbox limit, the campaign total and the next ramp step", async () => {
    const deps = createDeps();

    const result = await createSendRateActions(deps).read();

    expect(result.ok).toBe(true);
    expect(result.snapshot).toEqual({
      accounts: [
        { email: "a@presciaweb.com", dailyLimit: 4, status: 1 },
        { email: "b@presciaweb.com", dailyLimit: 4, status: 1 },
        { email: "c@presciaweb.com", dailyLimit: 4, status: 1 },
        { email: "d@presciaweb.com", dailyLimit: 4, status: 1 },
        { email: "e@presciaweb.com", dailyLimit: 4, status: 1 },
        { email: "f@presciaweb.com", dailyLimit: 4, status: 1 },
        { email: "g@presciaweb.com", dailyLimit: 3, status: 1 },
        { email: "h@presciaweb.com", dailyLimit: 3, status: 1 },
      ],
      campaignDailyTotal: 30,
      mailboxCount: 8,
      excludedAccountCount: 0,
      nextRampStep: 45,
      rampComplete: false,
      ramp: [30, 45, 68, 101, 152, 155],
    });
  });

  it("counts a mailbox with no daily limit set as zero rather than dropping it", async () => {
    const deps = createDeps({
      instantly: {
        listSendingAccounts: vi.fn().mockResolvedValue([
          { email: "a@presciaweb.com", dailyLimit: 30, status: 1 },
          { email: "b@presciaweb.com", dailyLimit: null, status: 1 },
        ]),
        updateAccountDailyLimit: vi.fn(),
      },
    });

    const result = await createSendRateActions(deps).read();

    expect(result.snapshot?.mailboxCount).toBe(2);
    expect(result.snapshot?.campaignDailyTotal).toBe(30);
  });

  it("excludes mailboxes outside the configured PrinterIQ sending domains", async () => {
    const deps = createDeps({
      instantly: {
        listSendingAccounts: vi.fn().mockResolvedValue([
          { email: "a@presciaweb.com", dailyLimit: 30, status: 1 },
          { email: "x@adsiqdigital.com", dailyLimit: 200, status: 1 },
          { email: "y@buildpredictiqdigital.com", dailyLimit: 200, status: 1 },
        ]),
        updateAccountDailyLimit: vi.fn(),
      },
    });

    const result = await createSendRateActions(deps).read();

    expect(result.snapshot?.mailboxCount).toBe(1);
    expect(result.snapshot?.campaignDailyTotal).toBe(30);
    expect(result.snapshot?.excludedAccountCount).toBe(2);
  });

  it("reports the ramp as complete once the estate is at the destination", async () => {
    const deps = createDeps({
      instantly: {
        listSendingAccounts: vi
          .fn()
          .mockResolvedValue([{ email: "a@presciaweb.com", dailyLimit: 155, status: 1 }]),
        updateAccountDailyLimit: vi.fn(),
      },
    });

    const result = await createSendRateActions(deps).read();

    expect(result.snapshot?.nextRampStep).toBeNull();
    expect(result.snapshot?.rampComplete).toBe(true);
  });

  it("reports a read failure honestly instead of an empty estate", async () => {
    const deps = createDeps({
      instantly: {
        listSendingAccounts: vi
          .fn()
          .mockRejectedValue(new Error("Instantly API GET /api/v2/accounts failed with 503")),
        updateAccountDailyLimit: vi.fn(),
      },
    });

    const result = await createSendRateActions(deps).read();

    expect(result.ok).toBe(false);
    expect(result.snapshot).toBeUndefined();
    expect(result.message).toContain("Could not read the current daily limits from Instantly");
    expect(result.message).toContain("503");
  });

  it("refuses to read when no sending domain allowlist is configured", async () => {
    const deps = createDeps({ allowedDomains: [] });

    const result = await createSendRateActions(deps).read();

    expect(result.ok).toBe(false);
    expect(result.message).toContain("INSTANTLY_SENDING_DOMAINS");
    expect(deps.instantly.listSendingAccounts).not.toHaveBeenCalled();
  });
});

describe("send rate apply", () => {
  beforeEach(() => {
    revalidatePathMock.mockReset();
    requireOperatorMock.mockReset().mockResolvedValue({ id: "operator-1" });
  });

  it("splits the requested campaign total across every in-scope mailbox", async () => {
    const deps = createDeps();

    const result = await createSendRateActions(deps).apply(applyForm({ dailyTotal: "45" }));

    expect(result.ok).toBe(true);
    expect(deps.instantly.updateAccountDailyLimit).toHaveBeenCalledTimes(8);
    expect(deps.instantly.updateAccountDailyLimit).toHaveBeenCalledWith("a@presciaweb.com", 6);
    expect(deps.instantly.updateAccountDailyLimit).toHaveBeenCalledWith("h@presciaweb.com", 5);
    expect(result.outcomes?.map((outcome) => outcome.requestedDailyLimit)).toEqual([
      6, 6, 6, 6, 6, 5, 5, 5,
    ]);
    expect(result.effectiveDailyTotal).toBe(45);
    expect(result.message).toContain("8 of 8");
    expect(deps.revalidatePath).toHaveBeenCalledWith("/sending");
  });

  it("records the previous limit for every mailbox it changed", async () => {
    const deps = createDeps();

    const result = await createSendRateActions(deps).apply(applyForm({ dailyTotal: "45" }));

    expect(result.outcomes?.[0]).toEqual({
      email: "a@presciaweb.com",
      previousDailyLimit: 4,
      requestedDailyLimit: 6,
      changed: true,
    });
  });

  it("reports a partial failure as a failure and names the mailbox that did not change", async () => {
    const updateAccountDailyLimit = vi.fn().mockImplementation(async (email: string) => {
      if (email === "c@presciaweb.com") {
        throw new Error("Instantly API PATCH /api/v2/accounts/{email} failed with 422");
      }
    });
    const deps = createDeps({
      instantly: {
        listSendingAccounts: vi.fn().mockResolvedValue(accountsFixture()),
        updateAccountDailyLimit,
      },
    });

    const result = await createSendRateActions(deps).apply(applyForm({ dailyTotal: "45" }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain("7 of 8");
    expect(result.message).toContain("1 failed");
    const failed = result.outcomes?.filter((outcome) => !outcome.changed) ?? [];
    expect(failed).toHaveLength(1);
    expect(failed[0]!.email).toBe("c@presciaweb.com");
    expect(failed[0]!.error).toContain("422");
    expect(failed[0]!.previousDailyLimit).toBe(4);
    expect(result.effectiveDailyTotal).toBe(43);
    expect(result.message).toContain("43");
  });

  it("reports a total API failure as no change at all", async () => {
    const deps = createDeps({
      instantly: {
        listSendingAccounts: vi.fn().mockResolvedValue(accountsFixture()),
        updateAccountDailyLimit: vi
          .fn()
          .mockRejectedValue(new Error("Instantly API PATCH /api/v2/accounts/{email} failed with 500")),
      },
    });

    const result = await createSendRateActions(deps).apply(applyForm({ dailyTotal: "45" }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain("No mailbox was changed");
    expect(result.outcomes?.every((outcome) => outcome.changed === false)).toBe(true);
    expect(result.effectiveDailyTotal).toBe(30);
  });

  it("changes nothing when the limits cannot be read first", async () => {
    const updateAccountDailyLimit = vi.fn();
    const deps = createDeps({
      instantly: {
        listSendingAccounts: vi.fn().mockRejectedValue(new Error("network down")),
        updateAccountDailyLimit,
      },
    });

    const result = await createSendRateActions(deps).apply(applyForm({ dailyTotal: "45" }));

    expect(result.ok).toBe(false);
    expect(updateAccountDailyLimit).not.toHaveBeenCalled();
    expect(result.message).toContain("Could not read the current daily limits from Instantly");
  });

  it("warns and changes nothing when the increase is more than a doubling", async () => {
    const deps = createDeps();

    const result = await createSendRateActions(deps).apply(applyForm({ dailyTotal: "61" }));

    expect(result.ok).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(deps.instantly.updateAccountDailyLimit).not.toHaveBeenCalled();
    expect(result.message).toContain("25% to 100%");
    expect(result.currentDailyTotal).toBe(30);
    expect(result.requestedDailyTotal).toBe(61);
  });

  it("applies without a warning at exactly a doubling", async () => {
    const deps = createDeps();

    const result = await createSendRateActions(deps).apply(applyForm({ dailyTotal: "60" }));

    expect(result.ok).toBe(true);
    expect(result.requiresConfirmation).toBeUndefined();
    expect(deps.instantly.updateAccountDailyLimit).toHaveBeenCalledTimes(8);
  });

  it("applies without a warning just below a doubling", async () => {
    const deps = createDeps();

    const result = await createSendRateActions(deps).apply(applyForm({ dailyTotal: "59" }));

    expect(result.ok).toBe(true);
    expect(result.requiresConfirmation).toBeUndefined();
  });

  it("applies an over doubling increase only once the operator confirms it explicitly", async () => {
    const deps = createDeps();

    const result = await createSendRateActions(deps).apply(
      applyForm({ dailyTotal: "61", confirmOverDoubling: "yes" }),
    );

    expect(result.ok).toBe(true);
    expect(deps.instantly.updateAccountDailyLimit).toHaveBeenCalledTimes(8);
    expect(result.effectiveDailyTotal).toBe(61);
  });

  it("ignores a confirmation for a total the operator did not see warned", async () => {
    const deps = createDeps();

    const result = await createSendRateActions(deps).apply(
      applyForm({ dailyTotal: "61", confirmOverDoubling: "no" }),
    );

    expect(result.requiresConfirmation).toBe(true);
    expect(deps.instantly.updateAccountDailyLimit).not.toHaveBeenCalled();
  });

  it("rejects a total that is not a positive whole number", async () => {
    const deps = createDeps();
    const actions = createSendRateActions(deps);

    for (const dailyTotal of ["", "0", "-5", "12.5", "abc"]) {
      const result = await actions.apply(applyForm({ dailyTotal }));
      expect(result.ok).toBe(false);
      expect(result.message).toContain("whole number");
    }
    expect(deps.instantly.updateAccountDailyLimit).not.toHaveBeenCalled();
  });

  it("rejects a total above the sanity cap", async () => {
    const deps = createDeps();

    const result = await createSendRateActions(deps).apply(applyForm({ dailyTotal: "1001" }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain("1000");
    expect(deps.instantly.updateAccountDailyLimit).not.toHaveBeenCalled();
  });

  it("refuses to apply when there is no mailbox in the configured sending domains", async () => {
    const deps = createDeps({
      instantly: {
        listSendingAccounts: vi
          .fn()
          .mockResolvedValue([{ email: "x@adsiqdigital.com", dailyLimit: 20, status: 1 }]),
        updateAccountDailyLimit: vi.fn(),
      },
    });

    const result = await createSendRateActions(deps).apply(applyForm({ dailyTotal: "45" }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain("No Instantly mailbox");
    expect(deps.instantly.updateAccountDailyLimit).not.toHaveBeenCalled();
  });

  it("never touches a mailbox outside the configured sending domains", async () => {
    const updateAccountDailyLimit = vi.fn().mockResolvedValue(undefined);
    const deps = createDeps({
      instantly: {
        listSendingAccounts: vi.fn().mockResolvedValue([
          { email: "a@presciaweb.com", dailyLimit: 30, status: 1 },
          { email: "x@adsiqdigital.com", dailyLimit: 200, status: 1 },
        ]),
        updateAccountDailyLimit,
      },
    });

    await createSendRateActions(deps).apply(applyForm({ dailyTotal: "45" }));

    expect(updateAccountDailyLimit).toHaveBeenCalledTimes(1);
    expect(updateAccountDailyLimit).toHaveBeenCalledWith("a@presciaweb.com", 45);
  });
});

describe("send rate server action wrappers", () => {
  beforeEach(() => {
    revalidatePathMock.mockReset();
    requireOperatorMock.mockReset().mockResolvedValue({ id: "operator-1" });
    delete process.env.INSTANTLY_SENDING_DOMAINS;
    // The fallback name has to go too, or "not configured" is not the state
    // under test. See src/lib/sending-domains.ts.
    delete process.env.DELIVERABILITY_SENDING_DOMAINS;
  });

  it("requires an authenticated operator before reading limits", async () => {
    requireOperatorMock.mockRejectedValue(new Error("Not authenticated"));
    const { readSendRate } = await import("./send-rate-actions");

    await expect(readSendRate()).rejects.toThrow("Not authenticated");
  });

  it("requires an authenticated operator before applying a limit", async () => {
    requireOperatorMock.mockRejectedValue(new Error("Not authenticated"));
    const { applySendRate } = await import("./send-rate-actions");

    await expect(applySendRate(initialSendRateActionState, applyForm({ dailyTotal: "45" }))).rejects.toThrow(
      "Not authenticated",
    );
  });

  it("fails closed when the sending domain allowlist is not configured on the server", async () => {
    const { readSendRate } = await import("./send-rate-actions");

    const result = await readSendRate();

    expect(result.ok).toBe(false);
    expect(result.message).toContain("INSTANTLY_SENDING_DOMAINS");
  });
});
