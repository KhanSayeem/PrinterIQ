import { PipelineFunnel } from "@/components/PipelineFunnel";
import { PipelineStagePanel } from "@/components/PipelineStagePanel";
import { getDashboardTenantId } from "@/auth/tenant";
import { getPipelineAnalytics } from "@/db/queries";

function getPipelineLoadErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown pipeline loading error";
}

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;

  try {
    const tenantId = getDashboardTenantId();
    if (!tenantId) {
      throw new Error("Dashboard tenant not configured");
    }

    const analytics = await getPipelineAnalytics({ tenantId, selectedStage: params.stage });

    return (
      <>
        <div className="page-header">
          <div className="page-title-wrap">
            <div className="page-title">Funnel</div>
            <div className="page-subtitle">Pipeline stage breakdown · all time</div>
          </div>
        </div>
        {analytics.total === 0 ? (
          <div className="empty-state">No pipeline data. Import leads first.</div>
        ) : (
          <div className="pipeline-workbench">
            <section className="pipeline-main">
              <PipelineFunnel
                stages={analytics.stages}
                conversions={analytics.conversions}
                selectedStage={analytics.selectedStage}
              />
            </section>
            <PipelineStagePanel detail={analytics.selectedStageDetail} />
          </div>
        )}
      </>
    );
  } catch (error) {
    const message = getPipelineLoadErrorMessage(error);
    console.error("Failed to load pipeline data", { message });

    return (
      <div className="error-state">
        Failed to load pipeline data. Check DATABASE_URL and Supabase connectivity.
        {process.env.NODE_ENV !== "production" ? <div className="error-detail">{message}</div> : null}
      </div>
    );
  }
}
