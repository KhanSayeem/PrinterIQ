"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/auth/client";

export function HeaderActions({ operatorEmail }: { operatorEmail: string }) {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="topbar-actions">
      <span className="topbar-user">{operatorEmail}</span>
      <button className="btn btn-ghost topbar-signout" type="button" onClick={handleSignOut}>
        <LogOut size={14} />
        Sign out
      </button>
    </div>
  );
}
