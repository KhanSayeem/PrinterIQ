from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, Protocol, cast
from uuid import UUID

QueueJobStatus = Literal["active", "completed", "failed", "dead"]


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
class QueueJobUpdate:
    job_id: UUID
    status: QueueJobStatus
    attempt_count: int
    error_message: str | None = None


class QueueJobStore:
    def __init__(self, connection: DatabaseConnection) -> None:
        self._connection = connection

    async def create_queue_job(self, insert: QueueJobInsert) -> UUID:
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
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14::jsonb, $15::jsonb
        )
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
    await connection.execute(
        """
        UPDATE leads
        SET status = $3
        WHERE tenant_id = $1
          AND id = $2
        """,
        tenant_id,
        lead_id,
        status,
    )


async def create_queue_job(connection: DatabaseConnection, insert: QueueJobInsert) -> UUID:
    raw_job_id = await connection.fetchval(
        """
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
        VALUES ($1, $2, $3, 'active', $4, $5, $6::jsonb, NOW())
        RETURNING id
        """,
        insert.tenant_id,
        insert.lead_id,
        insert.job_type,
        insert.attempt_count,
        insert.max_attempts,
        dict(insert.payload),
    )
    if isinstance(raw_job_id, UUID):
        return raw_job_id
    if isinstance(raw_job_id, str):
        return UUID(raw_job_id)
    raise TypeError(f"Expected queue job UUID, got {type(raw_job_id).__name__}")


async def update_queue_job(connection: DatabaseConnection, update: QueueJobUpdate) -> None:
    completed_fragment = ", completed_at = NOW()" if update.status in {"completed", "dead"} else ""
    await connection.execute(
        f"""
        UPDATE queue_jobs
        SET status = $2,
            attempt_count = $3,
            error_message = $4
            {completed_fragment}
        WHERE id = $1
        """,
        update.job_id,
        update.status,
        update.attempt_count,
        update.error_message,
    )
