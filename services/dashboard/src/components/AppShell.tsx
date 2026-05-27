import { Sidebar } from "./Sidebar";
import { HeaderActions } from "./HeaderActions";

export function AppShell({
  children,
  operatorEmail,
}: {
  children: React.ReactNode;
  operatorEmail: string;
}) {
  return (
    <>
      <Sidebar />
      <main className="main">
        <header className="topbar">
          <div className="topbar-spacer" />
          <HeaderActions operatorEmail={operatorEmail} />
        </header>
        <div className="content">{children}</div>
      </main>
    </>
  );
}
