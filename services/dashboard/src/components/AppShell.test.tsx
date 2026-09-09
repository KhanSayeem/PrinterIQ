import { fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

type MockLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  children: ReactNode;
};

vi.mock("next/navigation", () => ({
  usePathname: () => "/leads",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: function MockLink({ href, onClick, children, ...props }: MockLinkProps) {
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          onClick?.(event);
        }}
      >
        {children}
      </a>
    );
  },
}));

describe("AppShell mobile navigation", () => {
  it("opens and closes the mobile sidebar drawer from the topbar", () => {
    render(
      <AppShell operatorEmail="operator@example.com" operatorName="Operator Example">
        <div>Page content</div>
      </AppShell>,
    );

    const drawer = screen.getByLabelText("Mobile dashboard navigation");
    expect(drawer).not.toHaveClass("open");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    expect(drawer).toHaveClass("open");
    expect(screen.getByRole("button", { name: "Close navigation" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));

    expect(drawer).not.toHaveClass("open");
  });

  it("closes the mobile sidebar drawer from the backdrop", () => {
    render(
      <AppShell operatorEmail="operator@example.com" operatorName="Operator Example">
        <div>Page content</div>
      </AppShell>,
    );

    const drawer = screen.getByLabelText("Mobile dashboard navigation");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(drawer).toHaveClass("open");

    fireEvent.click(screen.getByRole("button", { name: "Close navigation backdrop" }));

    expect(drawer).not.toHaveClass("open");
  });

  it("closes the mobile sidebar drawer after selecting a nav link", () => {
    render(
      <AppShell operatorEmail="operator@example.com" operatorName="Operator Example">
        <div>Page content</div>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(screen.getByRole("link", { name: /Pipeline/ }));

    expect(screen.getByLabelText("Mobile dashboard navigation")).not.toHaveClass("open");
  });
});
