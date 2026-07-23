import { notFound } from "next/navigation";
import { getDashboardTenantId } from "@/auth/tenant";
import { getLeadDetail } from "@/db/queries";
import { LeadDetailView } from "@/components/LeadDetailView";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenantId = getDashboardTenantId();
  if (!tenantId) {
    return <div className="error-state">Failed to load lead. Dashboard tenant not configured.</div>;
  }

  const detail = await getLeadDetail({ tenantId, leadId: id });

  if (!detail) {
    notFound();
  }

  return (
    <div className="lead-detail-screen">
      <LeadDetailView
        tenantId={tenantId}
        lead={detail.lead}
        enrichment={detail.enrichment}
        qualification={detail.qualification}
        conversations={detail.conversations}
        outreachSends={detail.outreachSends}
        payment={detail.payment}
        websitePreview={detail.websitePreview}
      />
    </div>
  );
}
