import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShadowModeBanner } from "./ShadowModeBanner";

describe("ShadowModeBanner", () => {
  it("states the persistent no-outreach boundary", () => {
    render(<ShadowModeBanner />);

    expect(screen.getByText("Shadow mode")).toBeInTheDocument();
    expect(screen.getByText(/cannot create leads, previews, or outreach/i)).toBeInTheDocument();
  });
});
