import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUserMock, redirectMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  redirectMock: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [],
    set: vi.fn(),
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: getUserMock },
  }),
}));

vi.mock("./env", () => ({
  getSupabaseBrowserEnv: () => ({
    url: "https://supabase.example",
    anonKey: "anon-key",
  }),
}));

import { requireOperator } from "./server";

describe("server auth guards", () => {
  beforeEach(() => {
    vi.stubEnv("DASHBOARD_OPERATOR_EMAILS", "operator@presciaiq.com");
    getUserMock.mockReset();
    redirectMock.mockClear();
  });

  it("returns the user when they are allowlisted", async () => {
    const user = { id: "user-1", email: "operator@presciaiq.com" };
    getUserMock.mockResolvedValue({ data: { user } });

    await expect(requireOperator()).resolves.toBe(user);
  });

  it("redirects authenticated non-operators before dashboard data loads", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-2", email: "intruder@example.com" } } });

    await expect(requireOperator()).rejects.toThrow("redirect:/login");
    expect(redirectMock).toHaveBeenCalledWith("/login");
  });
});
