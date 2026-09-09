import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/leads" }));

describe("Sidebar", () => {
  it("links to the authenticated leads area and marks it active", () => {
    render(<Sidebar operatorName="Daniel Marsi" />);

    expect(screen.getByRole("link", { name: /Leads/i })).toHaveAttribute("href", "/leads");
    expect(screen.getByRole("link", { name: /Leads/i })).toHaveClass("active");
  });

  it("shows the signed-in operator rather than a fixed name", () => {
    render(<Sidebar operatorName="Daniel Marsi" />);

    expect(screen.getByText("Daniel Marsi")).toBeInTheDocument();
    expect(screen.getByText("DM")).toBeInTheDocument();
    expect(screen.queryByText("Macauley")).not.toBeInTheDocument();
  });

  it("links to the reply inbox", () => {
    render(<Sidebar operatorName="Daniel Marsi" />);

    expect(screen.getByRole("link", { name: /Replies/i })).toHaveAttribute("href", "/replies");
    expect(screen.getByRole("link", { name: /Replies/i })).not.toHaveClass("active");
  });

  it("links to the deliverability health area", () => {
    render(<Sidebar operatorName="Daniel Marsi" />);

    expect(screen.getByRole("link", { name: /Deliverability/i })).toHaveAttribute(
      "href",
      "/deliverability",
    );
  });

  it("does not link to the retired prospects area", () => {
    render(<Sidebar operatorName="Daniel Marsi" />);

    expect(screen.queryByRole("link", { name: /Prospects/i })).not.toBeInTheDocument();
  });

  it("links to the sending controls so the kill switch is one click away", () => {
    render(<Sidebar operatorName="Daniel Marsi" />);

    expect(screen.getByRole("link", { name: /Sending/i })).toHaveAttribute("href", "/sending");
  });
});
