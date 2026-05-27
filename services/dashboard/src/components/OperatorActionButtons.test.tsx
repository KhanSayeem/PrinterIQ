import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OperatorActionButtons } from "./OperatorActionButtons";

describe("OperatorActionButtons", () => {
  it("renders all D3 actions as disabled muted ghost buttons", () => {
    render(<OperatorActionButtons />);

    for (const name of ["Add note", "Override reply", "Pause lead"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveClass("btn-ghost", "btn-muted");
      expect(button).toHaveAttribute("title", "Available in a future update");
    }
  });
});
