import { operatorDisplayName } from "@/auth/operator-identity";
import { requireOperator } from "@/auth/server";
import { AppShell } from "@/components/AppShell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireOperator();

  return (
    <AppShell operatorEmail={user.email ?? ""} operatorName={operatorDisplayName(user)}>
      {children}
    </AppShell>
  );
}
