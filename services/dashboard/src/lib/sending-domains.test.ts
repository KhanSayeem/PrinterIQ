import { describe, expect, it } from "vitest";
import {
  parseSendingDomains,
  resolveSendingDomains,
  SENDING_DOMAINS_ENV_VAR,
  SENDING_DOMAINS_FALLBACK_ENV_VAR,
} from "./sending-domains";

describe("parseSendingDomains", () => {
  it("trims, lowercases and drops blank entries", () => {
    expect(parseSendingDomains(" PresciaWeb.com , second.com ,, ")).toEqual([
      "presciaweb.com",
      "second.com",
    ]);
  });

  it("treats an unset or blank value as no allowlist", () => {
    expect(parseSendingDomains(undefined)).toEqual([]);
    expect(parseSendingDomains(null)).toEqual([]);
    expect(parseSendingDomains("   ")).toEqual([]);
  });
});

describe("resolveSendingDomains", () => {
  it("names one variable for the whole estate", () => {
    expect(SENDING_DOMAINS_ENV_VAR).toBe("INSTANTLY_SENDING_DOMAINS");
    expect(SENDING_DOMAINS_FALLBACK_ENV_VAR).toBe("DELIVERABILITY_SENDING_DOMAINS");
  });

  it("prefers INSTANTLY_SENDING_DOMAINS when both are set", () => {
    expect(
      resolveSendingDomains({
        INSTANTLY_SENDING_DOMAINS: "canonical.com",
        DELIVERABILITY_SENDING_DOMAINS: "fallback.com",
      }),
    ).toEqual(["canonical.com"]);
  });

  it("falls back to DELIVERABILITY_SENDING_DOMAINS so an estate set only there still scopes", () => {
    expect(
      resolveSendingDomains({ DELIVERABILITY_SENDING_DOMAINS: "fallback.com" }),
    ).toEqual(["fallback.com"]);
  });

  it("falls back when the canonical variable is present but blank", () => {
    expect(
      resolveSendingDomains({
        INSTANTLY_SENDING_DOMAINS: "  ",
        DELIVERABILITY_SENDING_DOMAINS: "fallback.com",
      }),
    ).toEqual(["fallback.com"]);
  });

  it("returns nothing when neither is set, so callers fail closed", () => {
    expect(resolveSendingDomains({})).toEqual([]);
  });
});
