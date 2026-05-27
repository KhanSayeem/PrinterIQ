import { requireUser } from "@/auth/server";
import { AppShell } from "@/components/AppShell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <AppShell operatorEmail={user.email ?? "macauley@printeriq.com"}>
      {children}
    </AppShell>
  );
}
