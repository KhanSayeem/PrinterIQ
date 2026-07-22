import { startProspectRun } from "@/app/actions/prospect-run-actions";
import { getDashboardTenantId } from "@/auth/tenant";
import { ProspectsWorkbench } from "@/components/ProspectsWorkbench";
import { ShadowModeBanner } from "@/components/ShadowModeBanner";
import { failStaleActiveDiscoveryRunsForTenant, getLatestDiscoveryRun } from "@/db/queries";

export default async function ProspectsPage() {
  const tenantId = getDashboardTenantId();
  if (!tenantId) {
    throw new Error("Dashboard tenant not configured");
  }

  await failStaleActiveDiscoveryRunsForTenant({ tenantId });
  const latestRun = await getLatestDiscoveryRun({ tenantId });

  return (
    <>
      <div className="page-header prospects-page-header">
        <div className="page-title-wrap">
          <div className="page-title">Prospects</div>
          <div className="page-subtitle">Outscraper discovery run status</div>
        </div>
      </div>
      <ShadowModeBanner />
      <ProspectsWorkbench initialRun={latestRun} startAction={startProspectRun} />
    </>
  );
}
