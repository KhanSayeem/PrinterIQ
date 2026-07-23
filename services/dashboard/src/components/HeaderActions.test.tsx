import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HeaderActions } from "./HeaderActions";

const push = vi.fn();
const refresh = vi.fn();
const signOut = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("@/auth/client", () => ({
  createSupabaseBrowserClient: () => ({
    auth: { signOut },
  }),
}));

describe("HeaderActions", () => {
  it("shows operator email and sign out button", async () => {
    signOut.mockResolvedValue({ error: null });

    render(<HeaderActions operatorEmail="macauley@printeriq.com" />);

    expect(screen.getByText("macauley@printeriq.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /import csv/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    await waitFor(() => {
      expect(signOut).toHaveBeenCalled();
      expect(push).toHaveBeenCalledWith("/login");
    });
  });
});
