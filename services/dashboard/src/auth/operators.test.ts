import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedOperator } from "./operators";

describe("operator allowlist", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows users whose email is in DASHBOARD_OPERATOR_EMAILS", () => {
    vi.stubEnv("DASHBOARD_OPERATOR_EMAILS", "macauley@presciaiq.com, ops@example.com");

    expect(isAuthorizedOperator({ email: "Macauley@PresciaIQ.com" })).toBe(true);
  });

  it("fails closed when the allowlist is missing or the email is absent", () => {
    vi.stubEnv("DASHBOARD_OPERATOR_EMAILS", "");

    expect(isAuthorizedOperator({ email: "macauley@presciaiq.com" })).toBe(false);
    expect(isAuthorizedOperator({ email: null })).toBe(false);
  });
});
