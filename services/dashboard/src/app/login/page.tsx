import { Suspense } from "react";
import { LoginForm } from "@/components/LoginForm";

export default function LoginPage() {
  return (
    <main className="login-screen">
      <Suspense fallback={<div className="login-card login-card-skeleton" />}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
