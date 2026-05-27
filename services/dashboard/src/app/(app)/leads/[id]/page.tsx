import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeadDetail } from "@/db/queries";
import { LeadDetailTabs } from "@/components/LeadDetailTabs";
import { OperatorActionButtons } from "@/components/OperatorActionButtons";
import { LeadStatusBadge } from "@/components/LeadStatusBadge";

const tenantId = process.env.TENANT_ID ?? "10000000-0000-0000-0000-000000000001";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getLeadDetail({ tenantId, leadId: id });

  if (!detail) {
    notFound();
  }

  const name = [detail.lead.firstName, detail.lead.lastName].filter(Boolean).join(" ") || detail.lead.email;
  const score = detail.qualification?.score ?? null;

  return (
    <div className="lead-detail-screen">
      <div className="lead-detail-header">
        <div className="breadcrumb">
          <Link href="/leads">Leads</Link>
          <span>/</span>
          <span>{name}</span>
        </div>
        <div className="lead-detail-top">
          <div>
            <div className="lead-detail-name">{name}</div>
            <div className="lead-detail-company">
              {detail.lead.businessName ?? "Unknown business"} · {detail.lead.city ?? "Unknown city"}, {detail.lead.state ?? "--"} · {detail.lead.vertical ?? "tradies"}
            </div>
            <div className="lead-detail-badges">
              <LeadStatusBadge status={detail.lead.status} />
              <span className="lead-detail-score-pill">score {score ?? "--"} / 100</span>
            </div>
          </div>
          <OperatorActionButtons />
        </div>
        <LeadDetailTabs
          lead={detail.lead}
          enrichment={detail.enrichment}
          qualification={detail.qualification}
          conversations={detail.conversations}
          outreachSends={detail.outreachSends}
          payment={detail.payment}
        />
      </div>
    </div>
  );
}
