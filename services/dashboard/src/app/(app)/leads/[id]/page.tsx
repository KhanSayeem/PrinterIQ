import { notFound } from "next/navigation";
import { getLeadDetail } from "@/db/queries";
import { LeadDetailView } from "@/components/LeadDetailView";

const tenantId = process.env.TENANT_ID ?? "10000000-0000-0000-0000-000000000001";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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
