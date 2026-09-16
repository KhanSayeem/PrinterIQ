"use client";

import { Menu } from "lucide-react";
import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { AskPanel } from "./AskPanel";
import { HeaderActions } from "./HeaderActions";

export function AppShell({
  children,
  operatorEmail,
  operatorName,
}: {
  children: React.ReactNode;
  operatorEmail: string;
  operatorName: string;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <>
      <Sidebar
        operatorName={operatorName}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />
      {mobileNavOpen ? (
        <button
          type="button"
          className="mobile-sidebar-backdrop"
          aria-label="Close navigation backdrop"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}
      <main className="main">
        <header className="topbar">
          <button
            type="button"
            className="mobile-nav-toggle"
            aria-label="Open navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu size={18} aria-hidden="true" />
          </button>
          <div className="topbar-spacer" />
          {/* On every page, because a question does not wait for the right page. */}
          <AskPanel />
          <HeaderActions operatorEmail={operatorEmail} />
        </header>
        <div className="content">{children}</div>
      </main>
    </>
  );
}
