import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginForm } from "./LoginForm";

const push = vi.fn();
const signInWithPassword = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/auth/client", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      signInWithPassword,
    },
  }),
}));

describe("LoginForm", () => {
  it("signs in with email and password then redirects to /leads", async () => {
    signInWithPassword.mockResolvedValue({ error: null });

    render(<LoginForm />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "operator@printeriq.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(signInWithPassword).toHaveBeenCalledWith({
        email: "operator@printeriq.com",
        password: "correct-password",
      });
      expect(push).toHaveBeenCalledWith("/leads");
    });
  });
});
