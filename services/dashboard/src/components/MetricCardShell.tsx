import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A KPI card that navigates when there is somewhere useful to go.
 *
 * The clickable form is a real link, not a div with an onClick handler, so the
 * keyboard reaches it by tabbing and Enter activates it for free. A card with
 * no honest destination stays a plain div rather than inventing one.
 */
export function MetricCardShell({
  className,
  href,
  role,
  ariaLabel,
  children,
}: {
  className: string;
  href?: string;
  role?: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  if (!href) {
    return (
      <div className={className} role={role} aria-label={ariaLabel}>
        {children}
      </div>
    );
  }

  return (
    <Link className={`${className} is-clickable`} href={href} aria-label={ariaLabel}>
      {children}
    </Link>
  );
}
