import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LeadStatusBadge } from "./LeadStatusBadge";

describe("LeadStatusBadge", () => {
  it("maps statuses to reference badge classes", () => {
    render(<LeadStatusBadge status="qualified" />);

    expect(screen.getByText("qualified")).toHaveClass("badge", "s-qualified");
  });
});
