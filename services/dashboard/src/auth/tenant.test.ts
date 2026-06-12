import { afterEach, describe, expect, it, vi } from "vitest";
import { getDashboardTenantId } from "./tenant";

describe("dashboard tenant config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the configured tenant UUID after trimming whitespace", () => {
    vi.stubEnv("TENANT_ID", " 11111111-1111-4111-8111-111111111111 ");

    expect(getDashboardTenantId()).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("returns the local default tenant only outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TENANT_ID", "");

    expect(getDashboardTenantId()).toBe("10000000-0000-0000-0000-000000000001");
  });

  it("fails closed when the configured tenant id is malformed", () => {
    vi.stubEnv("TENANT_ID", "not-a-uuid");

    expect(getDashboardTenantId()).toBeNull();
  });
});
