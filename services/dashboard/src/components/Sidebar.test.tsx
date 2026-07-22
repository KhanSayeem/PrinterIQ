import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/prospects" }));

describe("Sidebar", () => {
  it("links to the authenticated prospects area and marks it active", () => {
    render(<Sidebar />);

    expect(screen.getByRole("link", { name: /Prospects/i })).toHaveAttribute("href", "/prospects");
    expect(screen.getByRole("link", { name: /Prospects/i })).toHaveClass("active");
  });
});
