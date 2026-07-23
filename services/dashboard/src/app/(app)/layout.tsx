import { requireOperator } from "@/auth/server";
import { AppShell } from "@/components/AppShell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireOperator();

  return (
    <AppShell operatorEmail={user.email ?? "macauley@presciaiq.com"}>
      {children}
    </AppShell>
  );
}
