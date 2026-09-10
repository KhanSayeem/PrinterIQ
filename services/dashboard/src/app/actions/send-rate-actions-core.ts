import type { InstantlySendingAccount } from "@/clients/instantly";
import { MISSING_SENDING_DOMAINS_MESSAGE } from "@/lib/sending-domains";
import {
  distributeDailyLimit,
  exceedsGoogleRampGuidance,
  MAX_REQUESTABLE_DAILY_TOTAL,
  nextRampStep,
  SENDING_VOLUME_RAMP,
} from "@/lib/sending-ramp";

export const SEND_RATE_PATH = "/sending";

export type SendRateSnapshot = {
  accounts: InstantlySendingAccount[];
  campaignDailyTotal: number;
  mailboxCount: number;
  excludedAccountCount: number;
  nextRampStep: number | null;
  rampComplete: boolean;
  ramp: number[];
};

export type MailboxChangeOutcome = {
  email: string;
  previousDailyLimit: number | null;
  requestedDailyLimit: number;
  changed: boolean;
  error?: string;
};

export type SendRateActionState = {
  ok: boolean;
  message: string;
  snapshot?: SendRateSnapshot;
  requiresConfirmation?: boolean;
  requestedDailyTotal?: number;
  currentDailyTotal?: number;
  effectiveDailyTotal?: number;
  outcomes?: MailboxChangeOutcome[];
};

export const initialSendRateActionState: SendRateActionState = {
  ok: false,
  message: "",
};

export type SendRateActionDeps = {
  instantly: {
    listSendingAccounts(): Promise<InstantlySendingAccount[]>;
    updateAccountDailyLimit(email: string, dailyLimit: number): Promise<void>;
  };
  /**
   * Mail domains that belong to PrinterIQ. ADR 005 records that the workspace
   * also holds accounts on other projects' domains, and that they must not be
   * counted as PrinterIQ capacity. Without an allowlist this control would read
   * and write another project's mailboxes, so it fails closed instead.
   */
  allowedDomains: string[];
  revalidatePath: (path: string) => void;
};

const MISSING_DOMAINS_MESSAGE = `${MISSING_SENDING_DOMAINS_MESSAGE} Nothing was read or changed.`;

/** Re-exported so existing importers keep one implementation between them. */
export { parseSendingDomains, resolveSendingDomains } from "@/lib/sending-domains";

function accountDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

function inScope(account: InstantlySendingAccount, allowedDomains: string[]): boolean {
  return allowedDomains.includes(accountDomain(account.email));
}

function limitOf(account: InstantlySendingAccount): number {
  return account.dailyLimit ?? 0;
}

function sumLimits(accounts: InstantlySendingAccount[]): number {
  return accounts.reduce((total, account) => total + limitOf(account), 0);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readFailureMessage(error: unknown): string {
  return `Could not read the current daily limits from Instantly, so nothing was changed. ${errorText(error)}`;
}

function buildSnapshot(
  accounts: InstantlySendingAccount[],
  allowedDomains: string[],
): SendRateSnapshot {
  const scoped = accounts.filter((account) => inScope(account, allowedDomains));
  const campaignDailyTotal = sumLimits(scoped);

  return {
    accounts: scoped,
    campaignDailyTotal,
    mailboxCount: scoped.length,
    excludedAccountCount: accounts.length - scoped.length,
    nextRampStep: nextRampStep(campaignDailyTotal),
    rampComplete: nextRampStep(campaignDailyTotal) === null,
    ramp: [...SENDING_VOLUME_RAMP],
  };
}

function readRequestedTotal(formData: FormData): { total: number } | { error: string } {
  const raw = formData.get("dailyTotal");
  const text = typeof raw === "string" ? raw.trim() : "";
  const parsed = Number(text);

  if (text === "" || !Number.isInteger(parsed) || parsed < 1) {
    return { error: "Enter the new campaign daily total as a whole number of 1 or more." };
  }
  if (parsed > MAX_REQUESTABLE_DAILY_TOTAL) {
    return {
      error: `${parsed} is above the ${MAX_REQUESTABLE_DAILY_TOTAL} per day cap for this control. Check the number before retrying.`,
    };
  }
  return { total: parsed };
}

function overDoublingMessage(currentDailyTotal: number, requestedDailyTotal: number): string {
  return (
    `${requestedDailyTotal} per day is more than double the current ${currentDailyTotal} per day. ` +
    "Google's guidance for senders increasing volume describes a common daily increase of 25% to 100% " +
    "(https://support.google.com/mail/answer/15256272), so this step is outside that guidance. " +
    `ADR 005 ramps to ${SENDING_VOLUME_RAMP[SENDING_VOLUME_RAMP.length - 1]} in documented steps. ` +
    "Nothing has been changed. Confirm to apply it anyway."
  );
}

function applyReport(
  outcomes: MailboxChangeOutcome[],
  requestedDailyTotal: number,
  currentDailyTotal: number,
): SendRateActionState {
  const changed = outcomes.filter((outcome) => outcome.changed);
  const failed = outcomes.filter((outcome) => !outcome.changed);
  // The honest total is what the estate actually adds up to now: the new limit
  // where the call succeeded, the untouched previous limit where it did not.
  const effectiveDailyTotal = outcomes.reduce(
    (total, outcome) =>
      total + (outcome.changed ? outcome.requestedDailyLimit : (outcome.previousDailyLimit ?? 0)),
    0,
  );

  if (failed.length === 0) {
    return {
      ok: true,
      message: `Daily limit applied to ${changed.length} of ${outcomes.length} mailboxes. Campaign daily total is now ${effectiveDailyTotal}.`,
      requestedDailyTotal,
      currentDailyTotal,
      effectiveDailyTotal,
      outcomes,
    };
  }

  if (changed.length === 0) {
    return {
      ok: false,
      message: `No mailbox was changed. All ${outcomes.length} Instantly updates failed. Campaign daily total is unchanged at ${effectiveDailyTotal}.`,
      requestedDailyTotal,
      currentDailyTotal,
      effectiveDailyTotal,
      outcomes,
    };
  }

  return {
    ok: false,
    message: `Applied to ${changed.length} of ${outcomes.length} mailboxes. ${failed.length} failed and kept the previous limit. Campaign daily total is now ${effectiveDailyTotal}, not the ${requestedDailyTotal} requested.`,
    requestedDailyTotal,
    currentDailyTotal,
    effectiveDailyTotal,
    outcomes,
  };
}

export function createSendRateActions(deps: SendRateActionDeps) {
  async function loadSnapshot(): Promise<
    { ok: true; snapshot: SendRateSnapshot } | { ok: false; message: string }
  > {
    if (deps.allowedDomains.length === 0) {
      return { ok: false, message: MISSING_DOMAINS_MESSAGE };
    }

    let accounts: InstantlySendingAccount[];
    try {
      accounts = await deps.instantly.listSendingAccounts();
    } catch (error) {
      return { ok: false, message: readFailureMessage(error) };
    }

    return { ok: true, snapshot: buildSnapshot(accounts, deps.allowedDomains) };
  }

  return {
    async read(): Promise<SendRateActionState> {
      const loaded = await loadSnapshot();
      if (!loaded.ok) {
        return { ok: false, message: loaded.message };
      }
      return { ok: true, message: "", snapshot: loaded.snapshot };
    },

    async apply(formData: FormData): Promise<SendRateActionState> {
      const requested = readRequestedTotal(formData);
      if ("error" in requested) {
        return { ok: false, message: requested.error };
      }

      const loaded = await loadSnapshot();
      if (!loaded.ok) {
        return { ok: false, message: loaded.message };
      }

      const { snapshot } = loaded;
      if (snapshot.mailboxCount === 0) {
        return {
          ok: false,
          message: `No Instantly mailbox is on the configured PrinterIQ sending domains (${deps.allowedDomains.join(", ")}), so there is nothing to change.`,
          snapshot,
        };
      }

      const currentDailyTotal = snapshot.campaignDailyTotal;
      const confirmed = formData.get("confirmOverDoubling") === "yes";

      if (!confirmed && exceedsGoogleRampGuidance(currentDailyTotal, requested.total)) {
        return {
          ok: false,
          message: overDoublingMessage(currentDailyTotal, requested.total),
          requiresConfirmation: true,
          requestedDailyTotal: requested.total,
          currentDailyTotal,
          snapshot,
        };
      }

      const targets = [...snapshot.accounts].sort((left, right) =>
        left.email.localeCompare(right.email),
      );
      const shares = distributeDailyLimit(requested.total, targets.length);
      const outcomes: MailboxChangeOutcome[] = [];

      for (const [index, account] of targets.entries()) {
        const requestedDailyLimit = shares[index]!;
        try {
          await deps.instantly.updateAccountDailyLimit(account.email, requestedDailyLimit);
          outcomes.push({
            email: account.email,
            previousDailyLimit: account.dailyLimit,
            requestedDailyLimit,
            changed: true,
          });
        } catch (error) {
          outcomes.push({
            email: account.email,
            previousDailyLimit: account.dailyLimit,
            requestedDailyLimit,
            changed: false,
            error: errorText(error),
          });
        }
      }

      const report = applyReport(outcomes, requested.total, currentDailyTotal);
      deps.revalidatePath(SEND_RATE_PATH);
      return report;
    },
  };
}
