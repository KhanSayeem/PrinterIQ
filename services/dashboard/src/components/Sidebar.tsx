"use client";

import { BarChart3, CreditCard, ListChecks, Pin, Search, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const items = [
  { href: "/prospects", label: "Prospects", icon: Search },
  { href: "/leads", label: "Leads", icon: Users },
  { href: "/pipeline", label: "Pipeline", icon: ListChecks },
  { href: "/revenue", label: "Revenue", icon: CreditCard },
];

export function Sidebar({
  mobileOpen = false,
  onMobileClose,
}: {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);

  return (
    <aside
      className={`sidebar ${expanded || pinned ? "expanded" : ""} ${pinned ? "pinned" : ""} ${mobileOpen ? "mobile-open open" : ""}`}
      aria-label="Mobile dashboard navigation"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      <div className="sidebar-top">
        <div className="logo-mark">PI</div>
        <div className="logo-name">PrinterIQ</div>
        <button
          type="button"
          className="mobile-sidebar-close"
          aria-label="Close navigation"
          onClick={onMobileClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`pin-btn ${pinned ? "active" : ""}`}
          title={pinned ? "Unpin sidebar" : "Pin sidebar"}
          onClick={() => setPinned((value) => !value)}
        >
          <Pin size={14} />
        </button>
      </div>
      <nav className="sidebar-nav" aria-label="Dashboard">
        <div className="nav-section-label">Operate</div>
        {items.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item ${active ? "active" : ""}`}
              title={item.label}
              onClick={onMobileClose}
            >
              <Icon size={16} />
              <span className="nav-label-text">{item.label}</span>
              {item.href === "/leads" ? <span className="nav-badge">5</span> : null}
            </Link>
          );
        })}
        <div className="nav-section-label">Signals</div>
        <div className="nav-item" title="Live data">
          <BarChart3 size={16} />
          <span className="nav-label-text">Live data</span>
        </div>
      </nav>
      <div className="sidebar-footer">
        <div className="user-row">
          <div className="user-avatar">M</div>
          <div className="user-info">
            <div className="user-name">Macauley</div>
            <div className="user-role">Operator</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
