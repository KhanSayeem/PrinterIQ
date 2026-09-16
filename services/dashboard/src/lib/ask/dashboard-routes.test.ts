import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ASK_DASHBOARD_ROUTES,
  askLeadPath,
  describeDashboardRoutes,
} from "./dashboard-routes";

/**
 * The real pages, read off disk.
 *
 * This is the point of the test: a page added or renamed without being listed
 * in dashboard-routes.ts fails here, rather than the panel telling the operator
 * about a screen that does not exist, or missing one that does.
 */
function pagesOnDisk(): string[] {
  const appDir = join(process.cwd(), "src", "app", "(app)");
  const paths: string[] = ["/"];

  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const childDir = join(dir, entry.name);
      /** A dynamic segment such as [id] is listed as <leadId> in the route map. */
      const segment = entry.name.startsWith("[") ? "<leadId>" : entry.name;
      const routePath = `${prefix}/${segment}`;

      if (existsSync(join(childDir, "page.tsx"))) {
        paths.push(routePath);
      }

      walk(childDir, routePath);
    }
  };

  walk(appDir, "");
  return paths.sort();
}

describe("ASK_DASHBOARD_ROUTES", () => {
  it("lists every page the dashboard actually has, and no page it does not", () => {
    const listed = ASK_DASHBOARD_ROUTES.map((route) => route.path).sort();

    expect(listed).toEqual(pagesOnDisk());
  });

  it("describes every route in the operator's words, not the code's", () => {
    for (const route of ASK_DASHBOARD_ROUTES) {
      expect(route.describes.length, route.path).toBeGreaterThan(20);
      expect(route.describes, route.path).not.toMatch(/page\.tsx|component|useState/);
    }
  });

  it("points a lead at its own record, which is where the thread lives", () => {
    expect(askLeadPath("abc-123")).toBe("/leads/abc-123");
  });

  it("renders the routes as lines the prompt can carry", () => {
    const text = describeDashboardRoutes();

    expect(text).toContain("/replies is");
    expect(text).toContain("/leads/<leadId> is");
    expect(text.split("\n").length).toBe(ASK_DASHBOARD_ROUTES.length);
  });
});
