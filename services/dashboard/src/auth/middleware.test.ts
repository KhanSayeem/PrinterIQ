import { describe, expect, it } from "vitest";
import { getAuthRedirect, isPublicRoute } from "./middleware";

describe("dashboard auth middleware rules", () => {
  it("allows /login without a session", () => {
    expect(isPublicRoute("/login")).toBe(true);
    expect(getAuthRedirect(new URL("http://localhost:3000/login"), null)).toBeNull();
  });

  it("redirects unauthenticated /leads requests to /login", () => {
    const redirect = getAuthRedirect(new URL("http://localhost:3000/leads"), null);

    expect(redirect?.pathname).toBe("/login");
    expect(redirect?.searchParams.get("redirectedFrom")).toBe("/leads");
  });

  it("redirects unauthenticated /prospects requests to /login", () => {
    const redirect = getAuthRedirect(new URL("http://localhost:3000/prospects"), null);

    expect(redirect?.pathname).toBe("/login");
    expect(redirect?.searchParams.get("redirectedFrom")).toBe("/prospects");
  });

  it("allows API route handlers to return their own unauthenticated response", () => {
    expect(getAuthRedirect(new URL("http://localhost:3000/api/leads"), null)).toBeNull();
    expect(getAuthRedirect(new URL("http://localhost:3000/api/import-csv"), null)).toBeNull();
  });

  it("does not broadly exempt unknown API routes from auth redirects", () => {
    const redirect = getAuthRedirect(new URL("http://localhost:3000/api/other"), null);

    expect(redirect?.pathname).toBe("/login");
    expect(redirect?.searchParams.get("redirectedFrom")).toBe("/api/other");
  });
});
