from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal, Protocol, SupportsInt, cast
from uuid import UUID

QueueJobStatus = Literal["active", "completed", "failed", "dead"]
_ALLOWED_STATUS_PREDECESSORS: dict[str, tuple[str, ...]] = {
    "enriched": ("imported",),
    "qualified": ("enriched",),
    "contacted": ("qualified",),
    "replied": ("contacted",),
    "paid": ("replied",),
    "archived": ("enriched", "qualified", "contacted", "replied"),
}


class DatabaseConnection(Protocol):
    async def fetchval(self, query: str, *args: object) -> object:
        """Run a query and return the first scalar value."""

    async def fetchrow(self, query: str, *args: object) -> object:
        """Run a query and return the first row as a mapping."""

    async def execute(self, query: str, *args: object) -> object:
        """Run a query that does not return rows."""


@dataclass(frozen=True)
class QueueJobInsert:
    job_type: str
    tenant_id: UUID
    lead_id: UUID | None
    payload: Mapping[str, object]
    max_attempts: int
    attempt_count: int = 0


@dataclass(frozen=True)
class QueueJobLease:
    job_id: UUID
    acquired: bool


@dataclass(frozen=True)
class QueueJobUpdate:
    job_id: UUID
    tenant_id: UUID
    status: QueueJobStatus
    attempt_count: int
    error_message: str | None = None


class QueueJobStore:
    def __init__(self, connection: DatabaseConnection) -> None:
        self._connection = connection

    async def create_queue_job(self, insert: QueueJobInsert) -> QueueJobLease:
        return await create_queue_job(self._connection, insert)

    async def update_queue_job(self, update: QueueJobUpdate) -> None:
        await update_queue_job(self._connection, update)


@dataclass(frozen=True)
class LeadInsert:
    tenant_id: UUID
    first_name: str
    last_name: str
    email: str
    email_status: str
    phone: str
    business_name: str
    city: str
    state: str
    country: str
    website_url: str
    industry: str
    keywords: str
    technologies: str
    apollo_contact_id: str
    apollo_account_id: str
    source_file: str
    vertical: str
    status: str


class LeadStore:
    def __init__(self, connection: DatabaseConnection) -> None:
        self._connection = connection

    async def email_exists(self, *, tenant_id: UUID, email: str) -> bool:
        return await lead_email_exists(self._connection, tenant_id=tenant_id, email=email)

    async def insert_lead(self, lead: dict[str, object]) -> UUID:
        return await insert_lead(
            self._connection,
            LeadInsert(
                tenant_id=cast(UUID, lead["tenant_id"]),
                first_name=str(lead["first_name"]),
                last_name=str(lead["last_name"]),
                email=str(lead["email"]),
                email_status=str(lead["email_status"]),
                phone=str(lead["phone"]),
                business_name=str(lead["business_name"]),
                city=str(lead["city"]),
                state=str(lead["state"]),
                country=str(lead["country"]),
                website_url=str(lead["website_url"]),
                industry=str(lead["industry"]),
                keywords=str(lead["keywords"]),
                technologies=str(lead["technologies"]),
                apollo_contact_id=str(lead["apollo_contact_id"]),
                apollo_account_id=str(lead["apollo_account_id"]),
                source_file=str(lead["source_file"]),
                vertical=str(lead["vertical"]),
                status=str(lead["status"]),
            ),
        )


class PipelineStore:
    def __init__(self, connection: DatabaseConnection) -> None:
        self._connection = connection

    async def get_lead(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        return await get_lead_by_id(self._connection, tenant_id=tenant_id, lead_id=lead_id)

    async def get_enrichment(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        return await get_enrichment_by_lead_id(
            self._connection, tenant_id=tenant_id, lead_id=lead_id
        )

    async def get_qualification(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        return await get_qualification_by_lead_id(
            self._connection, tenant_id=tenant_id, lead_id=lead_id
        )

    async def get_website_preview(
        self, *, tenant_id: UUID, lead_id: UUID
    ) -> dict[str, object] | None:
        return await get_website_preview_by_lead_id(
            self._connection, tenant_id=tenant_id, lead_id=lead_id
        )

    async def insert_enrichment(self, enrichment: dict[str, object]) -> UUID:
        return await insert_enrichment(
            self._connection,
            EnrichmentInsert(
                lead_id=cast(UUID, enrichment["lead_id"]),
                tenant_id=cast(UUID, enrichment["tenant_id"]),
                has_site=cast(bool | None, enrichment["has_site"]),
                is_reachable=cast(bool | None, enrichment["is_reachable"]),
                is_mobile_friendly=cast(bool | None, enrichment["is_mobile_friendly"]),
                has_ssl=cast(bool | None, enrichment["has_ssl"]),
                has_meta_title=cast(bool | None, enrichment["has_meta_title"]),
                has_meta_description=cast(bool | None, enrichment["has_meta_description"]),
                has_h1=cast(bool | None, enrichment["has_h1"]),
                load_ms=cast(int | None, enrichment["load_ms"]),
                lighthouse_mobile_score=cast(
                    int | None, enrichment["lighthouse_mobile_score"]
                ),
                cms_detected=cast(str | None, enrichment["cms_detected"]),
                tech_source=str(enrichment["tech_source"]),
                weaknesses=cast(list[str], enrichment["weaknesses"]),
                raw_audit=cast(dict[str, object], enrichment["raw_audit"] or {}),
            ),
        )

    async def insert_qualification(self, q: dict[str, object]) -> UUID:
        return await insert_qualification(
            self._connection,
            QualificationInsert(
                lead_id=cast(UUID, q["lead_id"]),
                tenant_id=cast(UUID, q["tenant_id"]),
                score=int(cast(SupportsInt, q["score"])),
                rationale=str(q["rationale"]),
                top_weakness=str(q["top_weakness"]),
                subject_line=cast(str | None, q["subject_line"]),
                personalised_opener=cast(str | None, q["personalised_opener"]),
                followup_1=cast(str | None, q["followup_1"]),
                followup_2=cast(str | None, q["followup_2"]),
                model_haiku=str(q["model_haiku"]),
                model_sonnet=cast(str | None, q["model_sonnet"]),
                cost_usd=cast(Decimal, q["cost_usd"]),
                prompt_version=str(q["prompt_version"]),
            ),
        )

    async def insert_website_preview(self, preview: dict[str, object]) -> UUID:
        return await insert_website_preview(
            self._connection,
            WebsitePreviewInsert(
                tenant_id=cast(UUID, preview["tenant_id"]),
                lead_id=cast(UUID, preview["lead_id"]),
                template_used=str(preview["template_used"]),
                preview_url=str(preview["preview_url"]),
                personalisation_data=cast(
                    dict[str, object], preview["personalisation_data"]
                ),
                prompt_version=str(preview["prompt_version"]),
                cost_usd=cast(Decimal, preview["cost_usd"]),
            ),
        )

    async def insert_outreach_send(self, send: dict[str, object]) -> UUID:
        return await insert_outreach_send(
            self._connection,
            OutreachSendInsert(
                tenant_id=cast(UUID, send["tenant_id"]),
                lead_id=cast(UUID, send["lead_id"]),
                instantly_campaign_id=str(send["instantly_campaign_id"]),
                instantly_lead_id=str(send["instantly_lead_id"]),
                channel=str(send["channel"]),
            ),
        )

    async def reserve_outreach_send(self, send: dict[str, object]) -> UUID:
        return await reserve_outreach_send(
            self._connection,
            tenant_id=cast(UUID, send["tenant_id"]),
            lead_id=cast(UUID, send["lead_id"]),
            instantly_campaign_id=str(send["instantly_campaign_id"]),
            channel=str(send["channel"]),
        )

    async def complete_outreach_send(self, send: dict[str, object]) -> UUID:
        return await complete_outreach_send(
            self._connection,
            OutreachSendInsert(
                tenant_id=cast(UUID, send["tenant_id"]),
                lead_id=cast(UUID, send["lead_id"]),
                instantly_campaign_id=str(send["instantly_campaign_id"]),
                instantly_lead_id=str(send["instantly_lead_id"]),
                channel=str(send["channel"]),
            ),
        )

    async def abandon_outreach_send_reservation(self, send: dict[str, object]) -> None:
        await abandon_outreach_send_reservation(
            self._connection,
            tenant_id=cast(UUID, send["tenant_id"]),
            lead_id=cast(UUID, send["lead_id"]),
            instantly_campaign_id=str(send["instantly_campaign_id"]),
            channel=str(send["channel"]),
        )

    async def get_outreach_send(
        self,
        *,
        tenant_id: UUID,
        lead_id: UUID,
        instantly_campaign_id: str,
        channel: str,
    ) -> dict[str, object] | None:
        return await get_outreach_send_by_lead_campaign_channel(
            self._connection,
            tenant_id=tenant_id,
            lead_id=lead_id,
            instantly_campaign_id=instantly_campaign_id,
            channel=channel,
        )

    async def update_lead_status(
        self, *, tenant_id: UUID, lead_id: UUID, status: str
    ) -> None:
        await update_lead_status(
            self._connection, tenant_id=tenant_id, lead_id=lead_id, status=status
        )

    async def mark_lead_contacted(self, *, tenant_id: UUID, lead_id: UUID) -> bool:
        return await mark_lead_contacted(self._connection, tenant_id=tenant_id, lead_id=lead_id)

    async def acquire_outreach_send_lock(
        self,
        *,
        tenant_id: UUID,
        lead_id: UUID,
        instantly_campaign_id: str,
        channel: str,
    ) -> bool:
        return await acquire_outreach_send_lock(
            self._connection,
            tenant_id=tenant_id,
            lead_id=lead_id,
            instantly_campaign_id=instantly_campaign_id,
            channel=channel,
        )

    async def release_outreach_send_lock(
        self,
        *,
        tenant_id: UUID,
        lead_id: UUID,
        instantly_campaign_id: str,
        channel: str,
    ) -> None:
        await release_outreach_send_lock(
            self._connection,
            tenant_id=tenant_id,
            lead_id=lead_id,
            instantly_campaign_id=instantly_campaign_id,
            channel=channel,
        )


async def lead_email_exists(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    email: str,
) -> bool:
    result = await connection.fetchval(
        """
        SELECT EXISTS (
          SELECT 1
          FROM leads
          WHERE tenant_id = $1
            AND LOWER(email) = LOWER($2)
            AND is_deleted = FALSE
        )
        """,
        tenant_id,
        email,
    )
    return bool(result)


async def insert_lead(connection: DatabaseConnection, lead: LeadInsert) -> UUID:
    raw_lead_id = await connection.fetchval(
        """
        INSERT INTO leads (
          tenant_id,
          first_name,
          last_name,
          email,
          email_status,
          phone,
          business_name,
          city,
          state,
          country,
          website_url,
          industry,
          keywords,
          technologies,
          apollo_contact_id,
          apollo_account_id,
          source_file,
          vertical,
          status
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19
        )
        RETURNING id
        """,
        lead.tenant_id,
        lead.first_name,
        lead.last_name,
        lead.email,
        lead.email_status,
        lead.phone,
        lead.business_name,
        lead.city,
        lead.state,
        lead.country,
        lead.website_url,
        lead.industry,
        lead.keywords,
        lead.technologies,
        lead.apollo_contact_id or None,
        lead.apollo_account_id or None,
        lead.source_file,
        lead.vertical,
        lead.status,
    )
    if isinstance(raw_lead_id, UUID):
        return raw_lead_id
    if isinstance(raw_lead_id, str):
        return UUID(raw_lead_id)
    raise TypeError(f"Expected lead UUID, got {type(raw_lead_id).__name__}")


@dataclass(frozen=True)
class EnrichmentInsert:
    lead_id: UUID
    tenant_id: UUID
    has_site: bool | None
    is_reachable: bool | None
    is_mobile_friendly: bool | None
    has_ssl: bool | None
    has_meta_title: bool | None
    has_meta_description: bool | None
    has_h1: bool | None
    load_ms: int | None
    lighthouse_mobile_score: int | None
    cms_detected: str | None
    tech_source: str
    weaknesses: list[str]
    raw_audit: dict[str, object]


async def get_lead_by_id(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    lead_id: UUID,
) -> dict[str, object]:
    result = await connection.fetchrow(
        """
        SELECT id, tenant_id, email, website_url, technologies, status,
               phone,
               first_name, last_name, business_name, city, state
        FROM leads
        WHERE tenant_id = $1
          AND id = $2
          AND is_deleted = FALSE
        """,
        tenant_id,
        lead_id,
    )
    if result is None:
        raise LookupError(f"Lead {lead_id} not found for tenant {tenant_id}")
    return dict(cast(Mapping[str, object], result))


async def insert_enrichment(
    connection: DatabaseConnection,
    enrichment: EnrichmentInsert,
) -> UUID:
    raw_id = await connection.fetchval(
        """
        INSERT INTO enrichments (
          lead_id, tenant_id,
          has_site, is_reachable,
          is_mobile_friendly, has_ssl,
          has_meta_title, has_meta_description, has_h1,
          load_ms, lighthouse_mobile_score, cms_detected,
          tech_source, weaknesses, raw_audit
        )
        SELECT
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14::jsonb, $15::jsonb
        FROM leads
        WHERE id = $1
          AND tenant_id = $2
          AND is_deleted = FALSE
        ON CONFLICT (lead_id) DO UPDATE
        SET tenant_id = EXCLUDED.tenant_id,
            has_site = EXCLUDED.has_site,
            is_reachable = EXCLUDED.is_reachable,
            is_mobile_friendly = EXCLUDED.is_mobile_friendly,
            has_ssl = EXCLUDED.has_ssl,
            has_meta_title = EXCLUDED.has_meta_title,
            has_meta_description = EXCLUDED.has_meta_description,
            has_h1 = EXCLUDED.has_h1,
            load_ms = EXCLUDED.load_ms,
            lighthouse_mobile_score = EXCLUDED.lighthouse_mobile_score,
            cms_detected = EXCLUDED.cms_detected,
            tech_source = EXCLUDED.tech_source,
            weaknesses = EXCLUDED.weaknesses,
            raw_audit = EXCLUDED.raw_audit,
            analysed_at = NOW()
        WHERE enrichments.tenant_id = EXCLUDED.tenant_id
        RETURNING id
        """,
        enrichment.lead_id,
        enrichment.tenant_id,
        enrichment.has_site,
        enrichment.is_reachable,
        enrichment.is_mobile_friendly,
        enrichment.has_ssl,
        enrichment.has_meta_title,
        enrichment.has_meta_description,
        enrichment.has_h1,
        enrichment.load_ms,
        enrichment.lighthouse_mobile_score,
        enrichment.cms_detected,
        enrichment.tech_source,
        json.dumps(enrichment.weaknesses),
        json.dumps(enrichment.raw_audit),
    )
    if isinstance(raw_id, UUID):
        return raw_id
    if isinstance(raw_id, str):
        return UUID(raw_id)
    raise TypeError(f"Expected enrichment UUID, got {type(raw_id).__name__}")


async def update_lead_status(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    lead_id: UUID,
    status: str,
) -> None:
    previous_statuses = _ALLOWED_STATUS_PREDECESSORS.get(status)
    if previous_statuses is None:
        raise ValueError(f"Unsupported lead status transition target: {status}")
    previous_status_literals = ", ".join(f"'{item}'" for item in previous_statuses)
    await connection.execute(
        f"""
        UPDATE leads
        SET status = $3
        WHERE tenant_id = $1
          AND id = $2
          AND status IN ({previous_status_literals})
        """,
        tenant_id,
        lead_id,
        status,
    )


@dataclass(frozen=True)
class QualificationInsert:
    lead_id: UUID
    tenant_id: UUID
    score: int
    rationale: str
    top_weakness: str
    subject_line: str | None
    personalised_opener: str | None
    followup_1: str | None
    followup_2: str | None
    model_haiku: str
    model_sonnet: str | None
    cost_usd: Decimal
    prompt_version: str


async def get_enrichment_by_lead_id(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    lead_id: UUID,
) -> dict[str, object]:
    result = await connection.fetchrow(
        """
        SELECT id, lead_id, tenant_id,
               has_site, is_reachable, is_mobile_friendly,
               has_ssl, has_meta_title, has_meta_description, has_h1,
               load_ms, lighthouse_mobile_score, cms_detected,
               tech_source, weaknesses, raw_audit
        FROM enrichments
        WHERE tenant_id = $1
          AND lead_id = $2
        """,
        tenant_id,
        lead_id,
    )
    if result is None:
        raise LookupError(f"Enrichment for lead {lead_id} not found for tenant {tenant_id}")
    return dict(cast(Mapping[str, object], result))


async def insert_qualification(
    connection: DatabaseConnection,
    q: QualificationInsert,
) -> UUID:
    raw_id = await connection.fetchval(
        """
        INSERT INTO qualifications (
          lead_id, tenant_id,
          score, rationale, top_weakness,
          subject_line, personalised_opener, followup_1, followup_2,
          model_haiku, model_sonnet,
          cost_usd, prompt_version
        )
        SELECT
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13
        FROM leads
        WHERE id = $1
          AND tenant_id = $2
          AND is_deleted = FALSE
        ON CONFLICT (lead_id) DO UPDATE
        SET tenant_id = EXCLUDED.tenant_id,
            score = EXCLUDED.score,
            rationale = EXCLUDED.rationale,
            top_weakness = EXCLUDED.top_weakness,
            subject_line = EXCLUDED.subject_line,
            personalised_opener = EXCLUDED.personalised_opener,
            followup_1 = EXCLUDED.followup_1,
            followup_2 = EXCLUDED.followup_2,
            model_haiku = EXCLUDED.model_haiku,
            model_sonnet = EXCLUDED.model_sonnet,
            cost_usd = EXCLUDED.cost_usd,
            prompt_version = EXCLUDED.prompt_version,
            qualified_at = NOW()
        WHERE qualifications.tenant_id = EXCLUDED.tenant_id
        RETURNING id
        """,
        q.lead_id,
        q.tenant_id,
        q.score,
        q.rationale,
        q.top_weakness,
        q.subject_line,
        q.personalised_opener,
        q.followup_1,
        q.followup_2,
        q.model_haiku,
        q.model_sonnet,
        q.cost_usd,
        q.prompt_version,
    )
    if isinstance(raw_id, UUID):
        return raw_id
    if isinstance(raw_id, str):
        return UUID(raw_id)
    raise TypeError(f"Expected qualification UUID, got {type(raw_id).__name__}")


async def get_qualification_by_lead_id(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    lead_id: UUID,
) -> dict[str, object]:
    result = await connection.fetchrow(
        """
        SELECT id, lead_id, tenant_id,
               score, rationale, top_weakness,
               subject_line, personalised_opener, followup_1, followup_2,
               model_haiku, model_sonnet, cost_usd, prompt_version,
               qualified_at
        FROM qualifications
        WHERE tenant_id = $1
          AND lead_id = $2
        """,
        tenant_id,
        lead_id,
    )
    if result is None:
        raise LookupError(f"Qualification for lead {lead_id} not found for tenant {tenant_id}")
    return dict(cast(Mapping[str, object], result))


@dataclass(frozen=True)
class WebsitePreviewInsert:
    tenant_id: UUID
    lead_id: UUID
    template_used: str
    preview_url: str
    personalisation_data: dict[str, object]
    prompt_version: str
    cost_usd: Decimal


async def insert_website_preview(
    connection: DatabaseConnection,
    preview: WebsitePreviewInsert,
) -> UUID:
    raw_id = await connection.fetchval(
        """
        INSERT INTO website_previews (
          tenant_id, lead_id, template_used, preview_url,
          personalisation_data, prompt_version, cost_usd
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
        RETURNING id
        """,
        preview.tenant_id,
        preview.lead_id,
        preview.template_used,
        preview.preview_url,
        json.dumps(preview.personalisation_data),
        preview.prompt_version,
        preview.cost_usd,
    )
    if isinstance(raw_id, UUID):
        return raw_id
    if isinstance(raw_id, str):
        return UUID(raw_id)
    raise TypeError(f"Expected website preview UUID, got {type(raw_id).__name__}")


async def get_website_preview_by_lead_id(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    lead_id: UUID,
) -> dict[str, object] | None:
    result = await connection.fetchrow(
        """
        SELECT id, tenant_id, lead_id, template_used, preview_url,
               personalisation_data, prompt_version, cost_usd, generated_at
        FROM website_previews
        WHERE tenant_id = $1
          AND lead_id = $2
        """,
        tenant_id,
        lead_id,
    )
    if result is None:
        return None
    return dict(cast(Mapping[str, object], result))


@dataclass(frozen=True)
class OutreachSendInsert:
    tenant_id: UUID
    lead_id: UUID
    instantly_campaign_id: str
    instantly_lead_id: str
    channel: str


async def insert_outreach_send(
    connection: DatabaseConnection,
    send: OutreachSendInsert,
) -> UUID:
    raw_id = await connection.fetchval(
        """
        WITH existing_send AS (
          SELECT id
          FROM outreach_sends
          WHERE tenant_id = $1
            AND lead_id = $2
            AND instantly_campaign_id = $4
            AND channel = $5
        ),
        inserted_send AS (
        INSERT INTO outreach_sends (
          tenant_id,
          lead_id,
          instantly_lead_id,
          instantly_campaign_id,
          channel,
          sent_at
        )
        SELECT $1, $2, $3, $4, $5, NOW()
        FROM leads
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'qualified'
          AND is_deleted = FALSE
          AND NOT EXISTS (SELECT 1 FROM existing_send)
        ON CONFLICT (tenant_id, lead_id, instantly_campaign_id, channel)
        DO UPDATE
        SET instantly_lead_id = outreach_sends.instantly_lead_id
        RETURNING id
        )
        SELECT id FROM inserted_send
        UNION ALL
        SELECT id FROM existing_send
        LIMIT 1
        """,
        send.tenant_id,
        send.lead_id,
        send.instantly_lead_id,
        send.instantly_campaign_id,
        send.channel,
    )
    if isinstance(raw_id, UUID):
        return raw_id
    if isinstance(raw_id, str):
        return UUID(raw_id)
    if raw_id is None:
        raise LookupError(f"Qualified lead {send.lead_id} not found for tenant {send.tenant_id}")
    raise TypeError(f"Expected outreach_sends UUID, got {type(raw_id).__name__}")


async def reserve_outreach_send(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    lead_id: UUID,
    instantly_campaign_id: str,
    channel: str,
) -> UUID:
    raw_id = await connection.fetchval(
        """
        WITH inserted_send AS (
        INSERT INTO outreach_sends (
          tenant_id,
          lead_id,
          instantly_campaign_id,
          channel
        )
        SELECT $1, $2, $3, $4
        FROM leads
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'qualified'
          AND is_deleted = FALSE
        ON CONFLICT (tenant_id, lead_id, instantly_campaign_id, channel)
        DO NOTHING
        RETURNING id
        )
        SELECT id FROM inserted_send
        UNION ALL
        SELECT id
        FROM outreach_sends
        WHERE tenant_id = $1
          AND lead_id = $2
          AND instantly_campaign_id = $3
          AND channel = $4
        LIMIT 1
        """,
        tenant_id,
        lead_id,
        instantly_campaign_id,
        channel,
    )
    if isinstance(raw_id, UUID):
        return raw_id
    if isinstance(raw_id, str):
        return UUID(raw_id)
    if raw_id is None:
        raise LookupError(f"Qualified lead {lead_id} not found for tenant {tenant_id}")
    raise TypeError(f"Expected outreach_sends UUID, got {type(raw_id).__name__}")


async def complete_outreach_send(
    connection: DatabaseConnection,
    send: OutreachSendInsert,
) -> UUID:
    raw_id = await connection.fetchval(
        """
        UPDATE outreach_sends
        SET instantly_lead_id = $3,
            sent_at = NOW(),
            updated_at = NOW()
        WHERE tenant_id = $1
          AND lead_id = $2
          AND instantly_campaign_id = $4
          AND channel = $5
        RETURNING id
        """,
        send.tenant_id,
        send.lead_id,
        send.instantly_lead_id,
        send.instantly_campaign_id,
        send.channel,
    )
    if isinstance(raw_id, UUID):
        return raw_id
    if isinstance(raw_id, str):
        return UUID(raw_id)
    if raw_id is None:
        raise LookupError(
            f"Reserved outreach send {send.lead_id}/{send.instantly_campaign_id} "
            f"not found for tenant {send.tenant_id}"
        )
    raise TypeError(f"Expected outreach_sends UUID, got {type(raw_id).__name__}")


async def abandon_outreach_send_reservation(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    lead_id: UUID,
    instantly_campaign_id: str,
    channel: str,
) -> None:
    await connection.execute(
        """
        DELETE FROM outreach_sends
        WHERE tenant_id = $1
          AND lead_id = $2
          AND instantly_campaign_id = $3
          AND channel = $4
          AND instantly_lead_id IS NULL
        """,
        tenant_id,
        lead_id,
        instantly_campaign_id,
        channel,
    )


async def get_outreach_send_by_lead_campaign_channel(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    lead_id: UUID,
    instantly_campaign_id: str,
    channel: str,
) -> dict[str, object] | None:
    result = await connection.fetchrow(
        """
        SELECT id, tenant_id, lead_id,
               instantly_lead_id, instantly_campaign_id,
               channel, sent_at
        FROM outreach_sends
        WHERE tenant_id = $1
          AND lead_id = $2
          AND instantly_campaign_id = $3
          AND channel = $4
        """,
        tenant_id,
        lead_id,
        instantly_campaign_id,
        channel,
    )
    if result is None:
        return None
    return dict(cast(Mapping[str, object], result))


async def mark_lead_contacted(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    lead_id: UUID,
) -> bool:
    result = await connection.execute(
        """
        UPDATE leads
        SET status = 'contacted'
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'qualified'
        """,
        tenant_id,
        lead_id,
    )
    return str(result).upper() == "UPDATE 1"


async def acquire_outreach_send_lock(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    lead_id: UUID,
    instantly_campaign_id: str,
    channel: str,
) -> bool:
    raw_result = await connection.fetchval(
        """
        SELECT pg_try_advisory_lock(hashtextextended($1::text, 0))
        """,
        _outreach_send_lock_key(
            tenant_id=tenant_id,
            lead_id=lead_id,
            instantly_campaign_id=instantly_campaign_id,
            channel=channel,
        ),
    )
    return bool(raw_result)


async def release_outreach_send_lock(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    lead_id: UUID,
    instantly_campaign_id: str,
    channel: str,
) -> None:
    await connection.fetchval(
        """
        SELECT pg_advisory_unlock(hashtextextended($1::text, 0))
        """,
        _outreach_send_lock_key(
            tenant_id=tenant_id,
            lead_id=lead_id,
            instantly_campaign_id=instantly_campaign_id,
            channel=channel,
        ),
    )


def _outreach_send_lock_key(
    *,
    tenant_id: UUID,
    lead_id: UUID,
    instantly_campaign_id: str,
    channel: str,
) -> str:
    return f"outreach_send:{tenant_id}:{lead_id}:{instantly_campaign_id}:{channel}"


async def create_queue_job(connection: DatabaseConnection, insert: QueueJobInsert) -> QueueJobLease:
    if insert.lead_id is None:
        existing = await _create_queue_job_without_lead(connection, insert)
    else:
        existing = await _create_queue_job_for_lead(connection, insert)
    return _coerce_queue_job_lease(existing)


async def _create_queue_job_for_lead(
    connection: DatabaseConnection,
    insert: QueueJobInsert,
) -> object:
    return await connection.fetchrow(
        """
        WITH inserted_job AS (
        INSERT INTO queue_jobs (
          tenant_id,
          lead_id,
          job_type,
          status,
          attempt_count,
          max_attempts,
          payload,
          started_at
        )
        SELECT $1, $2, $3, 'active', $4, $5, $6::jsonb, NOW()
        FROM leads
        WHERE leads.id = $2
          AND leads.tenant_id = $1
          AND leads.is_deleted = FALSE
        ON CONFLICT (tenant_id, lead_id, job_type)
        WHERE lead_id IS NOT NULL
          AND status IN ('pending', 'active', 'failed')
        DO UPDATE
        SET status = EXCLUDED.status,
            attempt_count = EXCLUDED.attempt_count,
            max_attempts = EXCLUDED.max_attempts,
            payload = EXCLUDED.payload,
            started_at = NOW(),
            error_message = NULL,
            completed_at = NULL
        WHERE queue_jobs.status = 'failed'
        RETURNING id, TRUE AS acquired
        ),
        existing_job AS (
        SELECT id, FALSE AS acquired
        FROM queue_jobs
        WHERE tenant_id = $1
          AND lead_id = $2
          AND job_type = $3
          AND status IN ('pending', 'active', 'failed')
          AND NOT EXISTS (SELECT 1 FROM inserted_job)
        LIMIT 1
        )
        SELECT id, acquired FROM inserted_job
        UNION ALL
        SELECT id, acquired FROM existing_job
        LIMIT 1
        """,
        insert.tenant_id,
        insert.lead_id,
        insert.job_type,
        insert.attempt_count,
        insert.max_attempts,
        json.dumps(dict(insert.payload)),
    )


async def _create_queue_job_without_lead(
    connection: DatabaseConnection,
    insert: QueueJobInsert,
) -> object:
    return await connection.fetchrow(
        """
        WITH inserted_job AS (
        INSERT INTO queue_jobs (
          tenant_id,
          lead_id,
          job_type,
          status,
          attempt_count,
          max_attempts,
          payload,
          started_at
        )
        VALUES ($1, NULL, $2, 'active', $3, $4, $5::jsonb, NOW())
        ON CONFLICT (tenant_id, job_type)
        WHERE lead_id IS NULL
          AND status IN ('pending', 'active', 'failed')
        DO UPDATE
        SET status = EXCLUDED.status,
            attempt_count = EXCLUDED.attempt_count,
            max_attempts = EXCLUDED.max_attempts,
            payload = EXCLUDED.payload,
            started_at = NOW(),
            error_message = NULL,
            completed_at = NULL
        WHERE queue_jobs.status = 'failed'
        RETURNING id, TRUE AS acquired
        ),
        existing_job AS (
        SELECT id, FALSE AS acquired
        FROM queue_jobs
        WHERE tenant_id = $1
          AND lead_id IS NULL
          AND job_type = $2
          AND status IN ('pending', 'active', 'failed')
          AND NOT EXISTS (SELECT 1 FROM inserted_job)
        LIMIT 1
        )
        SELECT id, acquired FROM inserted_job
        UNION ALL
        SELECT id, acquired FROM existing_job
        LIMIT 1
        """,
        insert.tenant_id,
        insert.job_type,
        insert.attempt_count,
        insert.max_attempts,
        json.dumps(dict(insert.payload)),
    )


def _coerce_queue_job_lease(raw_row: object) -> QueueJobLease:
    if raw_row is None:
        raise LookupError("Queue job could not be created or leased")
    row = cast(Mapping[str, object], raw_row)
    raw_id = row["id"]
    if isinstance(raw_id, UUID):
        job_id = raw_id
    elif isinstance(raw_id, str):
        job_id = UUID(raw_id)
    else:
        raise TypeError(f"Expected queue job UUID, got {type(raw_id).__name__}")
    return QueueJobLease(job_id=job_id, acquired=bool(row["acquired"]))


async def update_queue_job(connection: DatabaseConnection, update: QueueJobUpdate) -> None:
    completed_fragment = ", completed_at = NOW()" if update.status in {"completed", "dead"} else ""
    await connection.execute(
        f"""
        UPDATE queue_jobs
        SET status = $3,
            attempt_count = $4,
            error_message = $5
            {completed_fragment}
        WHERE id = $1
          AND tenant_id = $2
        """,
        update.job_id,
        update.tenant_id,
        update.status,
        update.attempt_count,
        update.error_message,
    )
