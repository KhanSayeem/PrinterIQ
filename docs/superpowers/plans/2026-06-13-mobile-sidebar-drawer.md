# Mobile Sidebar Drawer Implementation Plan

> **For agentic workers:** Use executing-plans or dispatching-parallel-agents to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mobile navigation access to the dashboard so small screens can open the existing sidebar navigation from the topbar.

**Architecture:** Keep the existing desktop hover/pin sidebar unchanged. Add controlled mobile drawer state in `AppShell`, pass it into `Sidebar`, and render a mobile-only menu button plus backdrop. Reuse the existing nav links and close the drawer after a mobile nav selection.

**Tech Stack:** Next.js App Router, React client components, lucide-react icons, CSS media queries, Vitest + Testing Library.

---

### Task 1: Cover Mobile Drawer Behavior

**Files:**
- Create: `services/dashboard/src/components/AppShell.test.tsx`
- Modify: `services/dashboard/src/components/Sidebar.tsx`
- Modify: `services/dashboard/src/components/AppShell.tsx`
- Modify: `services/dashboard/src/app/globals.css`

- [x] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/leads",
}));

describe("AppShell mobile navigation", () => {
  it("opens and closes the mobile sidebar drawer from the topbar", () => {
    render(<AppShell operatorEmail="operator@example.com"><div>Page content</div></AppShell>);

    const drawer = screen.getByLabelText("Mobile dashboard navigation");
    expect(drawer).not.toHaveClass("open");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    expect(drawer).toHaveClass("open");
    expect(screen.getByRole("button", { name: "Close navigation" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));

    expect(drawer).not.toHaveClass("open");
  });

  it("closes the mobile sidebar drawer after selecting a nav link", () => {
    render(<AppShell operatorEmail="operator@example.com"><div>Page content</div></AppShell>);

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(screen.getByRole("link", { name: /Pipeline/ }));

    expect(screen.getByLabelText("Mobile dashboard navigation")).not.toHaveClass("open");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- AppShell.test.tsx`
Expected: FAIL because `AppShell.test.tsx` does not exist and the mobile drawer controls are not implemented.

- [x] **Step 3: Write minimal implementation**

Add a mobile menu button to `AppShell`, make `Sidebar` accept `mobileOpen` and `onMobileClose`, render a close button/backdrop for mobile, and make nav links call `onMobileClose`.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- AppShell.test.tsx`
Expected: PASS.

- [x] **Step 5: Verify full dashboard**

Run:
- `npm test`
- `npm run lint`
- `npm run build`

Expected: all pass.

- [x] **Step 6: Browser verify**

Run a production-mode local server and verify:
- mobile `/leads` has an `Open navigation` button in the topbar
- tapping it opens the drawer with Leads, Pipeline, Revenue, and Live data
- close button and backdrop close the drawer
- tapping Pipeline navigates/closes cleanly
- desktop sidebar still renders normally
