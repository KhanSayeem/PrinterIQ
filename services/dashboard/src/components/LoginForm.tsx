"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/auth/client";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setIsSubmitting(false);

    if (signInError) {
      setError("Invalid email or password.");
      return;
    }

    router.push(searchParams.get("redirectedFrom") || "/leads");
  }

  return (
    <form className="login-card" onSubmit={handleSubmit}>
      <div className="login-logo-row">
        <div className="logo-mark">PI</div>
        <span className="login-brand">PrinterIQ</span>
      </div>
      <h1 className="login-heading">Operator sign in</h1>
      <p className="login-sub">Access the private lead dashboard.</p>

      <label className="form-label" htmlFor="email">
        Email
      </label>
      <input
        id="email"
        className="form-input"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />

      <label className="form-label" htmlFor="password">
        Password
      </label>
      <input
        id="password"
        className="form-input"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
      />

      {error ? <p className="form-error">{error}</p> : null}

      <button className="login-submit" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Signing in..." : "Sign in"}
      </button>
      <p className="login-note">Authorised operators only.</p>
    </form>
  );
}
