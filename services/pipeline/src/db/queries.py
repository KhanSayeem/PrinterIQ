from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Literal, Protocol, SupportsInt, cast
from uuid import UUID

from prospects.sampling import ValidationSampleMember

QueueJobStatus = Literal["active", "completed", "failed", "dead"]
DiscoveryRunStatus = Literal[
    "created",
    "submitted",
    "polling",
    "persisted",
    "processing",
    "review_ready",
    "completed",
    "failed",
]
SourceProspectStatus = Literal["discovered", "failed"]
_ALLOWED_STATUS_PREDECESSORS: dict[str, tuple[str, ...]] = {
    "enriched": ("imported",),
    "qualified": ("enriched",),
    "contacted": ("qualified",),
    "replied": ("contacted",),
    "paid": ("replied",),
    "archived": ("enriched", "qualified", "contacted", "replied"),
}
_RUN_PREDECESSORS: dict[DiscoveryRunStatus, tuple[str, ...]] = {
    "submitted": ("created",),
    "polling": ("submitted", "polling"),
    "persisted": ("submitted", "polling"),
    "processing": ("persisted",),
    "review_ready": ("processing",),
    "completed": ("review_ready",),
    "failed": ("created", "submitted", "polling", "persisted", "processing"),
}


class DatabaseConnection(Protocol):
    async def fetch(self, query: str, *args: object) -> list[object]:
        """Run a query and return all rows."""

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
    recover_stale_active: bool = False


@dataclass(frozen=True)
class QueueJobLease:
    job_id: UUID
    acquired: bool
    lease_started_at: datetime


@dataclass(frozen=True)
class QueueJobUpdate:
    job_id: UUID
    tenant_id: UUID
    status: QueueJobStatus
    attempt_count: int
    lease_started_at: datetime
    error_message: str | None = None


@dataclass(frozen=True)
class QueueProgress:
    """Whether the pipeline worker is finishing work, not merely holding it.

    `last_completion_at` is the only column here that proves progress.
    `started_at` is rewritten every time a job is leased or retried, and the
    `active` count leaks: the live database currently holds 25 rows in `active`
    against 5 genuinely running jobs, because a process that dies holding a
    lease never closes its row. The three leaked rows dated 2026-08-25 are the
    August deadlock, still sitting there. Both are carried for diagnosis and
    neither may be used as the progress signal.
    """

    last_completion_at: datetime | None
    last_start_at: datetime | None
    active_job_count: int
    oldest_active_started_at: datetime | None


class QueueJobStore:
    def __init__(self, connection: DatabaseConnection) -> None:
        self._connection = connection

    async def create_queue_job(self, insert: QueueJobInsert) -> QueueJobLease:
        return await create_queue_job(self._connection, insert)

    async def update_queue_job(self, update: QueueJobUpdate) -> None:
        await update_queue_job(self._connection, update)

    async def fetch_queue_progress(self, *, tenant_id: UUID) -> QueueProgress:
        return await fetch_queue_progress(self._connection, tenant_id=tenant_id)


@dataclass(frozen=True)
class SourceProspectUpsert:
    tenant_id: UUID
    discovery_run_id: UUID
    source_business_id: str
    business_name: str
    source_payload: Mapping[str, object]
    primary_category: str | None = None
    additional_categories: tuple[str, ...] = ()
    phone: str | None = None
    full_address: str | None = None
    locality: str | None = None
    state: str | None = None
    postcode: str | None = None
    latitude: Decimal | None = None
    longitude: Decimal | None = None
    business_status: str | None = None
    rating: Decimal | None = None
    review_count: int | None = None
    google_profile_url: str | None = None
    source_website_url: str | None = None
    status: SourceProspectStatus = "discovered"
    outcome_reason: str | None = None
    normalized_name: str | None = None
    source_payload_expires_at: datetime | None = None
    source: Literal["outscraper"] = "outscraper"


class ProspectStore:
    def __init__(self, connection: DatabaseConnection) -> None:
        self._connection = connection

    async def get_discovery_run(
        self, tenant_id: UUID, discovery_run_id: UUID
    ) -> dict[str, object] | None:
        return await get_discovery_run(
            self._connection,
            tenant_id=tenant_id,
            discovery_run_id=discovery_run_id,
        )

    async def transition_discovery_run(
        self,
        tenant_id: UUID,
        discovery_run_id: UUID,
        to_status: DiscoveryRunStatus,
        *,
        source_request_id: str | None = None,
        provider_usage: Mapping[str, object] | None = None,
        failure_code: str | None = None,
        failure_detail: str | None = None,
        discovered_count: int | None = None,
    ) -> dict[str, object] | None:
        return await transition_discovery_run(
            self._connection,
            tenant_id=tenant_id,
            discovery_run_id=discovery_run_id,
            to_status=to_status,
            source_request_id=source_request_id,
            provider_usage=provider_usage,
            failure_code=failure_code,
            failure_detail=failure_detail,
            discovered_count=discovered_count,
        )

    async def upsert_source_prospect(
        self, prospect: SourceProspectUpsert
    ) -> dict[str, object]:
        return await upsert_source_prospect(self._connection, prospect)

    async def list_discovered_prospects(
        self, *, tenant_id: UUID, discovery_run_id: UUID
    ) -> list[dict[str, object]]:
        return await list_discovered_prospects(
            self._connection,
            tenant_id=tenant_id,
            discovery_run_id=discovery_run_id,
        )

    async def list_prospects_for_shadow_review(
        self, *, tenant_id: UUID, discovery_run_id: UUID
    ) -> list[dict[str, object]]:
        return await list_prospects_for_shadow_review(
            self._connection,
            tenant_id=tenant_id,
            discovery_run_id=discovery_run_id,
        )

    async def apply_validation_sample(
        self,
        *,
        tenant_id: UUID,
        discovery_run_id: UUID,
        members: tuple[ValidationSampleMember, ...],
    ) -> dict[str, object]:
        return await apply_validation_sample(
            self._connection,
            tenant_id=tenant_id,
            discovery_run_id=discovery_run_id,
            members=members,
        )

    async def apply_prospect_normalization(self, **values: object) -> dict[str, object]:
        return await apply_prospect_normalization(self._connection, **values)

    async def apply_prospect_normalization_with_assessment(
        self, **values: object
    ) -> dict[str, object]:
        return await apply_prospect_normalization_with_assessment(
            self._connection, **values
        )

    async def upsert_prospect_assessment(self, **values: object) -> dict[str, object]:
        return await upsert_prospect_assessment(self._connection, **values)

    async def apply_prospect_assessment_result(self, **values: object) -> dict[str, object]:
        return await apply_prospect_assessment_result(self._connection, **values)

    async def get_existing_prospect_contact(
        self,
        *,
        tenant_id: UUID,
        prospect_id: UUID,
        provider: str,
        input_fingerprint: str,
    ) -> dict[str, object] | None:
        return await get_existing_prospect_contact(
            self._connection,
            tenant_id=tenant_id,
            prospect_id=prospect_id,
            provider=provider,
            input_fingerprint=input_fingerprint,
        )

    async def is_email_suppressed(self, *, tenant_id: UUID, email: str) -> bool:
        return await is_email_suppressed(self._connection, tenant_id=tenant_id, email=email)

    async def apply_prospect_contact_result(self, **values: object) -> dict[str, object]:
        return await apply_prospect_contact_result(self._connection, **values)

    async def refresh_discovery_run_aggregates(
        self, tenant_id: UUID, discovery_run_id: UUID
    ) -> dict[str, object]:
        return await refresh_discovery_run_aggregates(
            self._connection,
            tenant_id=tenant_id,
            discovery_run_id=discovery_run_id,
        )

    async def purge_expired_prospect_data(
        self,
        *,
        tenant_id: UUID,
        now: datetime,
        raw_payload_retention_days: int,
        snapshot_retention_days: int,
    ) -> dict[str, object]:
        return await purge_expired_prospect_data(
            self._connection,
            tenant_id=tenant_id,
            now=now,
            raw_payload_retention_days=raw_payload_retention_days,
            snapshot_retention_days=snapshot_retention_days,
        )


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
                has_actionable_weakness=cast(bool | None, q["has_actionable_weakness"]),
                subject_line=cast(str | None, q["subject_line"]),
                personalised_opener=cast(str | None, q["personalised_opener"]),
                followup_1=cast(str | None, q["followup_1"]),
                followup_2=cast(str | None, q["followup_2"]),
                weakness_sentence=cast(str | None, q["weakness_sentence"]),
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
                preview_slug=str(preview["preview_slug"]),
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


async def get_discovery_run(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    discovery_run_id: UUID,
) -> dict[str, object] | None:
    result = await connection.fetchrow(
        """
        SELECT id, tenant_id, source, source_request_id, query_spec, status,
               shadow_mode, discovered_count, usable_count, route_a_count,
               route_b_count, verified_contact_count, provider_usage,
               failure_code, failure_detail, submitted_at, results_received_at,
               review_ready_at, created_at, updated_at
        FROM discovery_runs
        WHERE tenant_id = $1
          AND id = $2
        """,
        tenant_id,
        discovery_run_id,
    )
    if result is None:
        return None
    return dict(cast(Mapping[str, object], result))


async def transition_discovery_run(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    discovery_run_id: UUID,
    to_status: DiscoveryRunStatus,
    source_request_id: str | None = None,
    provider_usage: Mapping[str, object] | None = None,
    failure_code: str | None = None,
    failure_detail: str | None = None,
    discovered_count: int | None = None,
) -> dict[str, object] | None:
    predecessors = _RUN_PREDECESSORS.get(to_status)
    if predecessors is None:
        raise ValueError(f"Unsupported discovery run transition: {to_status}")

    result = await connection.fetchrow(
        """
        UPDATE discovery_runs
        SET status = $3,
            source_request_id = COALESCE($5, source_request_id),
            provider_usage = COALESCE($6::jsonb, provider_usage),
            failure_code = COALESCE($7, failure_code),
            failure_detail = COALESCE($8, failure_detail),
            discovered_count = COALESCE($9, discovered_count),
            submitted_at = CASE
              WHEN $3 = 'submitted' THEN COALESCE(submitted_at, NOW())
              ELSE submitted_at
            END,
            results_received_at = CASE
              WHEN $3 = 'persisted' THEN COALESCE(results_received_at, NOW())
              ELSE results_received_at
            END,
            review_ready_at = CASE
              WHEN $3 = 'review_ready' THEN COALESCE(review_ready_at, NOW())
              ELSE review_ready_at
            END,
            updated_at = NOW()
        WHERE tenant_id = $1
          AND id = $2
          AND status = ANY($4::text[])
        RETURNING id, tenant_id, source, source_request_id, query_spec, status,
                  shadow_mode, discovered_count, usable_count, route_a_count,
                  route_b_count, verified_contact_count, provider_usage,
                  failure_code, failure_detail, submitted_at, results_received_at,
                  review_ready_at, created_at, updated_at
        """,
        tenant_id,
        discovery_run_id,
        to_status,
        predecessors,
        source_request_id,
        None if provider_usage is None else json.dumps(dict(provider_usage)),
        failure_code,
        failure_detail,
        discovered_count,
    )
    if result is None:
        return None
    return dict(cast(Mapping[str, object], result))


async def upsert_source_prospect(
    connection: DatabaseConnection,
    prospect: SourceProspectUpsert,
) -> dict[str, object]:
    result = await connection.fetchrow(
        """
        INSERT INTO business_prospects (
          tenant_id, discovery_run_id, source, source_business_id,
          business_name, primary_category, additional_categories, phone,
          full_address, locality, state, postcode, latitude, longitude,
          business_status, rating, review_count, google_profile_url,
          source_website_url, source_payload, source_payload_expires_at,
          status, outcome_reason, normalized_name
        )
        SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18, $19, $20::jsonb,
               COALESCE($21, NOW() + INTERVAL '30 days'), $22, $23, $24
        FROM discovery_runs
        WHERE tenant_id = $1
          AND id = $2
        ON CONFLICT (tenant_id, discovery_run_id, source, source_business_id)
        DO UPDATE SET
          business_name = EXCLUDED.business_name,
          primary_category = EXCLUDED.primary_category,
          additional_categories = EXCLUDED.additional_categories,
          phone = EXCLUDED.phone,
          full_address = EXCLUDED.full_address,
          locality = EXCLUDED.locality,
          state = EXCLUDED.state,
          postcode = EXCLUDED.postcode,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          business_status = EXCLUDED.business_status,
          rating = EXCLUDED.rating,
          review_count = EXCLUDED.review_count,
          google_profile_url = EXCLUDED.google_profile_url,
          source_website_url = EXCLUDED.source_website_url,
          source_payload = EXCLUDED.source_payload,
          updated_at = NOW()
        RETURNING id, tenant_id, discovery_run_id, source, source_business_id,
                  business_name, primary_category, additional_categories, phone,
                  full_address, locality, state, postcode, latitude, longitude,
                  business_status, rating, review_count, google_profile_url,
                  source_website_url, status, outcome_reason, source_payload,
                  source_payload_expires_at, created_at, updated_at
        """,
        prospect.tenant_id,
        prospect.discovery_run_id,
        getattr(prospect, "source", "outscraper"),
        prospect.source_business_id,
        prospect.business_name,
        getattr(prospect, "primary_category", None),
        json.dumps(list(getattr(prospect, "additional_categories", ()))),
        getattr(prospect, "phone", None),
        getattr(prospect, "full_address", None),
        getattr(prospect, "locality", None),
        getattr(prospect, "state", None),
        getattr(prospect, "postcode", None),
        getattr(prospect, "latitude", None),
        getattr(prospect, "longitude", None),
        getattr(prospect, "business_status", None),
        getattr(prospect, "rating", None),
        getattr(prospect, "review_count", None),
        getattr(prospect, "google_profile_url", None),
        getattr(prospect, "source_website_url", None),
        json.dumps(dict(prospect.source_payload)),
        getattr(prospect, "source_payload_expires_at", None),
        prospect.status,
        prospect.outcome_reason,
        getattr(prospect, "normalized_name", None) or prospect.business_name,
    )
    if result is None:
        raise LookupError(
            f"Discovery run {prospect.discovery_run_id} not found for tenant "
            f"{prospect.tenant_id}"
        )
    return dict(cast(Mapping[str, object], result))


async def list_discovered_prospects(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    discovery_run_id: UUID,
) -> list[dict[str, object]]:
    rows = await connection.fetch(
        """
        SELECT id, tenant_id, discovery_run_id, source, source_business_id,
               business_name, normalized_name, primary_category,
               additional_categories, phone, normalized_phone, full_address,
               locality, state, postcode, latitude, longitude,
               business_status, rating, review_count, google_profile_url,
               source_website_url, normalized_domain, website_ownership,
               duplicate_evidence, is_franchise, matched_location_count,
               route, outcome_reason, status, source_payload,
               source_payload_expires_at, created_at, updated_at
        FROM business_prospects
        WHERE tenant_id = $1
          AND discovery_run_id = $2
          AND status IN ('discovered', 'normalized', 'assessed', 'held', 'rejected')
        ORDER BY created_at, id
        """,
        tenant_id,
        discovery_run_id,
    )
    return [dict(cast(Mapping[str, object], row)) for row in rows]


async def list_prospects_for_shadow_review(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    discovery_run_id: UUID,
) -> list[dict[str, object]]:
    rows = await connection.fetch(
        """
        SELECT id, tenant_id, discovery_run_id, source, source_business_id,
               business_name, normalized_name, primary_category,
               additional_categories, phone, normalized_phone, full_address,
               locality, state, postcode, latitude, longitude,
               business_status, rating, review_count, google_profile_url,
               source_website_url, normalized_domain, website_ownership,
               duplicate_evidence, is_franchise, matched_location_count,
               route, outcome_reason, status, validation_sample,
               validation_cohort, created_at, updated_at
        FROM business_prospects
        WHERE tenant_id = $1
          AND discovery_run_id = $2
          AND lead_id IS NULL
          AND status IN (
            'normalized', 'assessed', 'contact_enriched', 'review_ready',
            'held', 'rejected', 'failed'
          )
        ORDER BY created_at, id
        """,
        tenant_id,
        discovery_run_id,
    )
    return [dict(cast(Mapping[str, object], row)) for row in rows]


async def apply_validation_sample(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    discovery_run_id: UUID,
    members: tuple[ValidationSampleMember, ...],
) -> dict[str, object]:
    result = await connection.fetchrow(
        """
        WITH selected(prospect_id, cohort) AS (
          SELECT *
          FROM UNNEST($3::uuid[], $4::text[])
        ),
        reset AS (
          UPDATE business_prospects
          SET validation_sample = FALSE,
              validation_cohort = NULL,
              updated_at = NOW()
          WHERE tenant_id = $1
            AND discovery_run_id = $2
            AND validation_sample = TRUE
          RETURNING id
        ),
        updated AS (
          UPDATE business_prospects
          SET validation_sample = TRUE,
              validation_cohort = selected.cohort,
              updated_at = NOW()
          FROM selected
          WHERE business_prospects.tenant_id = $1
            AND business_prospects.discovery_run_id = $2
            AND business_prospects.id = selected.prospect_id
            AND business_prospects.lead_id IS NULL
          RETURNING business_prospects.id
        )
        SELECT COUNT(*)::integer AS selected_count
        FROM updated
        """,
        tenant_id,
        discovery_run_id,
        [member.prospect_id for member in members],
        [member.cohort for member in members],
    )
    if result is None:
        raise LookupError("Validation sample could not be applied")
    return dict(cast(Mapping[str, object], result))


async def apply_prospect_normalization(
    connection: DatabaseConnection,
    **values: object,
) -> dict[str, object]:
    result = await connection.fetchrow(
        """
        UPDATE business_prospects
        SET normalized_name = $4,
            normalized_phone = $5,
            normalized_domain = $6,
            website_ownership = $7,
            duplicate_evidence = $8::jsonb,
            is_franchise = $9,
            matched_location_count = $10,
            route = $11,
            status = $12,
            outcome_reason = $13,
            updated_at = NOW()
        WHERE tenant_id = $1
          AND discovery_run_id = $2
          AND id = $3
          AND status = 'discovered'
          AND lead_id IS NULL
        RETURNING id, tenant_id, discovery_run_id, source, source_business_id,
                  business_name, normalized_name, normalized_phone,
                  normalized_domain, website_ownership, duplicate_evidence,
                  is_franchise, matched_location_count, route, status,
                  outcome_reason, updated_at
        """,
        values["tenant_id"],
        values["discovery_run_id"],
        values["prospect_id"],
        values["normalized_name"],
        values.get("normalized_phone"),
        values.get("normalized_domain"),
        values.get("website_ownership"),
        json.dumps(dict(cast(Mapping[str, object], values["duplicate_evidence"]))),
        values["is_franchise"],
        values["matched_location_count"],
        values.get("route"),
        values["status"],
        values["outcome_reason"],
    )
    if result is None:
        raise LookupError("Prospect normalization target not found for tenant/run")
    return dict(cast(Mapping[str, object], result))


async def upsert_prospect_assessment(
    connection: DatabaseConnection,
    **values: object,
) -> dict[str, object]:
    result = await connection.fetchrow(
        """
        INSERT INTO prospect_assessments (
          tenant_id, discovery_run_id, prospect_id, assessment_type,
          assessment_version, eligible, computed_route, total_score,
          category_scores, rule_evidence, forced_route_reason
        )
        VALUES ($1, $2, $3, 'automated', $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
        ON CONFLICT (tenant_id, discovery_run_id, prospect_id, assessment_version)
        WHERE assessment_type = 'automated'
        DO UPDATE SET
          eligible = EXCLUDED.eligible,
          computed_route = EXCLUDED.computed_route,
          total_score = EXCLUDED.total_score,
          category_scores = EXCLUDED.category_scores,
          rule_evidence = EXCLUDED.rule_evidence,
          forced_route_reason = EXCLUDED.forced_route_reason
        RETURNING id, tenant_id, discovery_run_id, prospect_id,
                  assessment_type, assessment_version, eligible,
                  computed_route, total_score, category_scores, rule_evidence,
                  forced_route_reason, created_at
        """,
        values["tenant_id"],
        values["discovery_run_id"],
        values["prospect_id"],
        values["assessment_version"],
        values["eligible"],
        values.get("computed_route"),
        values.get("total_score"),
        json.dumps(dict(cast(Mapping[str, object], values.get("category_scores", {})))),
        json.dumps(dict(cast(Mapping[str, object], values["rule_evidence"]))),
        values.get("forced_route_reason"),
    )
    if result is None:
        raise LookupError("Prospect assessment could not be upserted")
    return dict(cast(Mapping[str, object], result))


async def apply_prospect_assessment_result(
    connection: DatabaseConnection,
    **values: object,
) -> dict[str, object]:
    result = await connection.fetchrow(
        """
        WITH assessed AS (
          UPDATE business_prospects
          SET route = $4,
              status = $5,
              outcome_reason = $6,
              website_ownership = $7,
              normalized_domain = $8,
              source_payload = $9::jsonb,
              updated_at = NOW()
          WHERE tenant_id = $1
            AND discovery_run_id = $2
            AND id = $3
            AND status = 'normalized'
            AND website_ownership = 'owned'
            AND route IS NULL
            AND lead_id IS NULL
          RETURNING id, tenant_id, discovery_run_id, source, source_business_id,
                    business_name, normalized_name, normalized_phone,
                    normalized_domain, website_ownership, duplicate_evidence,
                    is_franchise, matched_location_count, route, status,
                    outcome_reason, updated_at
        ),
        assessment AS (
          INSERT INTO prospect_assessments (
            tenant_id, discovery_run_id, prospect_id, assessment_type,
            assessment_version, eligible, computed_route, total_score,
            category_scores, rule_evidence, forced_route_reason
          )
          SELECT tenant_id, discovery_run_id, id, 'automated',
                 $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16
          FROM assessed
          ON CONFLICT (tenant_id, discovery_run_id, prospect_id, assessment_version)
          WHERE assessment_type = 'automated'
          DO UPDATE SET
            eligible = EXCLUDED.eligible,
            computed_route = EXCLUDED.computed_route,
            total_score = EXCLUDED.total_score,
            category_scores = EXCLUDED.category_scores,
            rule_evidence = EXCLUDED.rule_evidence,
            forced_route_reason = EXCLUDED.forced_route_reason
          RETURNING id AS assessment_id
        )
        SELECT assessed.*, assessment.assessment_id
        FROM assessed
        CROSS JOIN assessment
        """,
        values["tenant_id"],
        values["discovery_run_id"],
        values["prospect_id"],
        values["route"],
        values["status"],
        values["outcome_reason"],
        values["website_ownership"],
        values.get("normalized_domain"),
        json.dumps(dict(cast(Mapping[str, object], values["source_payload"]))),
        values["assessment_version"],
        values["eligible"],
        values.get("computed_route"),
        values.get("total_score"),
        json.dumps(dict(cast(Mapping[str, object], values.get("category_scores", {})))),
        json.dumps(dict(cast(Mapping[str, object], values["rule_evidence"]))),
        values.get("forced_route_reason"),
    )
    if result is None:
        raise LookupError("Prospect assessment target not found for tenant/run")
    return dict(cast(Mapping[str, object], result))


async def get_existing_prospect_contact(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    prospect_id: UUID,
    provider: str,
    input_fingerprint: str,
) -> dict[str, object] | None:
    result = await connection.fetchrow(
        """
        SELECT id, tenant_id, prospect_id, provider, input_fingerprint,
               provider_request_id, provider_organization_id, provider_person_id,
               person_name, person_title, email, provider_email_status,
               credits_consumed, status, match_evidence, provider_payload,
               provider_payload_expires_at, created_at, updated_at
        FROM prospect_contacts
        WHERE tenant_id = $1
          AND prospect_id = $2
          AND provider = $3
          AND input_fingerprint = $4
        """,
        tenant_id,
        prospect_id,
        provider,
        input_fingerprint,
    )
    if result is None:
        return None
    return dict(cast(Mapping[str, object], result))


async def is_email_suppressed(
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
          WHERE leads.tenant_id = $1
            AND LOWER(leads.email) = LOWER($2)
            AND (
              leads.is_deleted = FALSE
              OR leads.status = 'archived'
            )
        )
        OR EXISTS (
          SELECT 1
          FROM outreach_sends
          INNER JOIN leads
            ON leads.tenant_id = outreach_sends.tenant_id
           AND leads.id = outreach_sends.lead_id
          WHERE outreach_sends.tenant_id = $1
            AND LOWER(leads.email) = LOWER($2)
            AND (
              outreach_sends.bounced = TRUE
              OR outreach_sends.unsubscribed = TRUE
              OR leads.status = 'archived'
            )
        )
        """,
        tenant_id,
        email,
    )
    return bool(result)


async def apply_prospect_contact_result(
    connection: DatabaseConnection,
    **values: object,
) -> dict[str, object]:
    result = await connection.fetchrow(
        """
        WITH target AS (
          SELECT id, tenant_id, discovery_run_id
          FROM business_prospects
          WHERE tenant_id = $1
            AND discovery_run_id = $2
            AND id = $3
            AND route IN ('A', 'B')
            AND status = 'assessed'
            AND lead_id IS NULL
        ),
        contact AS (
          INSERT INTO prospect_contacts (
            tenant_id, prospect_id, provider, input_fingerprint,
            provider_request_id, provider_organization_id, provider_person_id,
            person_name, person_title, email, provider_email_status,
            credits_consumed, status, match_evidence, provider_payload,
            provider_payload_expires_at
          )
          SELECT tenant_id, id, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15::jsonb, $16::jsonb,
                 CASE WHEN $16::jsonb IS NULL THEN NULL ELSE NOW() + INTERVAL '30 days' END
          FROM target
          ON CONFLICT (tenant_id, prospect_id, provider, input_fingerprint)
          DO UPDATE SET
            provider_request_id = EXCLUDED.provider_request_id,
            provider_organization_id = EXCLUDED.provider_organization_id,
            provider_person_id = EXCLUDED.provider_person_id,
            person_name = EXCLUDED.person_name,
            person_title = EXCLUDED.person_title,
            email = EXCLUDED.email,
            provider_email_status = EXCLUDED.provider_email_status,
            credits_consumed = EXCLUDED.credits_consumed,
            status = EXCLUDED.status,
            match_evidence = EXCLUDED.match_evidence,
            provider_payload = EXCLUDED.provider_payload,
            provider_payload_expires_at = EXCLUDED.provider_payload_expires_at,
            updated_at = NOW()
          RETURNING id, tenant_id, prospect_id, provider, input_fingerprint,
                    provider_request_id, provider_organization_id,
                    provider_person_id, person_name, person_title, email,
                    provider_email_status, credits_consumed, status,
                    match_evidence, provider_payload, provider_payload_expires_at,
                    created_at, updated_at
        ),
        updated_prospect AS (
          UPDATE business_prospects
          SET status = 'contact_enriched',
              updated_at = NOW()
          FROM target
          WHERE business_prospects.tenant_id = target.tenant_id
            AND business_prospects.discovery_run_id = target.discovery_run_id
            AND business_prospects.id = target.id
          RETURNING business_prospects.id
        )
        SELECT contact.*
        FROM contact
        CROSS JOIN updated_prospect
        """,
        values["tenant_id"],
        values["discovery_run_id"],
        values["prospect_id"],
        values["provider"],
        values["input_fingerprint"],
        values.get("provider_request_id"),
        values.get("provider_organization_id"),
        values.get("provider_person_id"),
        values.get("person_name"),
        values.get("person_title"),
        values.get("email"),
        values.get("provider_email_status"),
        values.get("credits_consumed"),
        values["status"],
        json.dumps(dict(cast(Mapping[str, object], values["match_evidence"]))),
        None
        if values.get("provider_payload") is None
        else json.dumps(dict(cast(Mapping[str, object], values["provider_payload"]))),
    )
    if result is None:
        raise LookupError("Prospect contact target not found for tenant/run")
    return dict(cast(Mapping[str, object], result))


async def apply_prospect_normalization_with_assessment(
    connection: DatabaseConnection,
    **values: object,
) -> dict[str, object]:
    result = await connection.fetchrow(
        """
        WITH normalized AS (
          UPDATE business_prospects
          SET normalized_name = $4,
              normalized_phone = $5,
              normalized_domain = $6,
              website_ownership = $7,
              duplicate_evidence = $8::jsonb,
              is_franchise = $9,
              matched_location_count = $10,
              route = $11,
              status = $12,
              outcome_reason = $13,
              source_payload = $14::jsonb,
              updated_at = NOW()
          WHERE tenant_id = $1
            AND discovery_run_id = $2
            AND id = $3
            AND status = 'discovered'
            AND lead_id IS NULL
          RETURNING id, tenant_id, discovery_run_id, source, source_business_id,
                    business_name, normalized_name, normalized_phone,
                    normalized_domain, website_ownership, duplicate_evidence,
                    is_franchise, matched_location_count, route, status,
                    outcome_reason, updated_at
        ),
        assessment AS (
          INSERT INTO prospect_assessments (
            tenant_id, discovery_run_id, prospect_id, assessment_type,
            assessment_version, eligible, computed_route, rule_evidence,
            forced_route_reason
          )
          SELECT tenant_id, discovery_run_id, id, 'automated',
                 $15, $16, $17, $18::jsonb, $19
          FROM normalized
          ON CONFLICT (tenant_id, discovery_run_id, prospect_id, assessment_version)
          WHERE assessment_type = 'automated'
          DO UPDATE SET
            eligible = EXCLUDED.eligible,
            computed_route = EXCLUDED.computed_route,
            rule_evidence = EXCLUDED.rule_evidence,
            forced_route_reason = EXCLUDED.forced_route_reason
          RETURNING id AS assessment_id
        )
        SELECT normalized.*, assessment.assessment_id
        FROM normalized
        CROSS JOIN assessment
        """,
        values["tenant_id"],
        values["discovery_run_id"],
        values["prospect_id"],
        values["normalized_name"],
        values.get("normalized_phone"),
        values.get("normalized_domain"),
        values.get("website_ownership"),
        json.dumps(dict(cast(Mapping[str, object], values["duplicate_evidence"]))),
        values["is_franchise"],
        values["matched_location_count"],
        values.get("route"),
        values["status"],
        values["outcome_reason"],
        json.dumps(dict(cast(Mapping[str, object], values["source_payload"]))),
        values["assessment_version"],
        values["eligible"],
        values.get("computed_route"),
        json.dumps(dict(cast(Mapping[str, object], values["rule_evidence"]))),
        values.get("forced_route_reason"),
    )
    if result is None:
        raise LookupError("Prospect normalization target not found for tenant/run")
    return dict(cast(Mapping[str, object], result))


async def refresh_discovery_run_aggregates(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    discovery_run_id: UUID,
) -> dict[str, object]:
    result = await connection.fetchrow(
        """
        WITH prospect_counts AS (
          SELECT COUNT(*)::integer AS discovered_count,
                 COUNT(*) FILTER (
                   WHERE status IN ('normalized', 'assessed', 'contact_enriched', 'review_ready')
                 )::integer AS usable_count,
                 COUNT(*) FILTER (WHERE route = 'A')::integer AS route_a_count,
                 COUNT(*) FILTER (WHERE route = 'B')::integer AS route_b_count
          FROM business_prospects
          WHERE tenant_id = $1
            AND discovery_run_id = $2
        ),
        verified_contacts AS (
          SELECT COUNT(DISTINCT prospect_contacts.prospect_id)::integer
                   AS verified_contact_count
          FROM prospect_contacts
          INNER JOIN business_prospects
            ON business_prospects.tenant_id = prospect_contacts.tenant_id
           AND business_prospects.id = prospect_contacts.prospect_id
          WHERE prospect_contacts.tenant_id = $1
            AND business_prospects.discovery_run_id = $2
            AND prospect_contacts.status = 'verified'
        ),
        verified_by_route AS (
          SELECT COUNT(DISTINCT prospect_contacts.prospect_id) FILTER (
                   WHERE business_prospects.route = 'A'
                 )::integer AS route_a_verified_contact_count,
                 COUNT(DISTINCT prospect_contacts.prospect_id) FILTER (
                   WHERE business_prospects.route = 'B'
                 )::integer AS route_b_verified_contact_count
          FROM prospect_contacts
          INNER JOIN business_prospects
            ON business_prospects.tenant_id = prospect_contacts.tenant_id
           AND business_prospects.id = prospect_contacts.prospect_id
          WHERE prospect_contacts.tenant_id = $1
            AND business_prospects.discovery_run_id = $2
            AND prospect_contacts.status = 'verified'
        )
        UPDATE discovery_runs
        SET discovered_count = prospect_counts.discovered_count,
            usable_count = prospect_counts.usable_count,
            route_a_count = prospect_counts.route_a_count,
            route_b_count = prospect_counts.route_b_count,
            verified_contact_count = verified_contacts.verified_contact_count,
            provider_usage = jsonb_set(
              provider_usage,
              '{apollo_contact_match}',
              jsonb_build_object(
                'route_a_verified_contact_count',
                verified_by_route.route_a_verified_contact_count,
                'route_b_verified_contact_count',
                verified_by_route.route_b_verified_contact_count,
                'route_a_match_rate',
                CASE
                  WHEN prospect_counts.route_a_count = 0 THEN NULL
                  ELSE ROUND(
                    verified_by_route.route_a_verified_contact_count::numeric
                    / prospect_counts.route_a_count,
                    4
                  )
                END,
                'route_b_match_rate',
                CASE
                  WHEN prospect_counts.route_b_count = 0 THEN NULL
                  ELSE ROUND(
                    verified_by_route.route_b_verified_contact_count::numeric
                    / prospect_counts.route_b_count,
                    4
                  )
                END,
                'cost_reconciliation_required',
                TRUE
              ),
              TRUE
            ),
            updated_at = NOW()
        FROM prospect_counts, verified_contacts, verified_by_route
        WHERE discovery_runs.tenant_id = $1
          AND discovery_runs.id = $2
        RETURNING discovery_runs.id, discovery_runs.tenant_id,
                  discovery_runs.source, discovery_runs.source_request_id,
                  discovery_runs.query_spec, discovery_runs.status,
                  discovery_runs.shadow_mode, discovery_runs.discovered_count,
                  discovery_runs.usable_count, discovery_runs.route_a_count,
                  discovery_runs.route_b_count,
                  discovery_runs.verified_contact_count,
                  discovery_runs.provider_usage, discovery_runs.failure_code,
                  discovery_runs.failure_detail, discovery_runs.submitted_at,
                  discovery_runs.results_received_at,
                  discovery_runs.review_ready_at, discovery_runs.created_at,
                  discovery_runs.updated_at
        """,
        tenant_id,
        discovery_run_id,
    )
    if result is None:
        raise LookupError(
            f"Discovery run {discovery_run_id} not found for tenant {tenant_id}"
        )
    return dict(cast(Mapping[str, object], result))


async def purge_expired_prospect_data(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    now: datetime,
    raw_payload_retention_days: int,
    snapshot_retention_days: int,
) -> dict[str, object]:
    result = await connection.fetchrow(
        """
        WITH expired_source_payloads AS (
          UPDATE business_prospects
          SET source_payload = NULL,
              source_payload_expires_at = NULL,
              updated_at = NOW()
          WHERE tenant_id = $1
            AND source_payload IS NOT NULL
            AND source_payload_expires_at IS NOT NULL
            AND source_payload_expires_at <= $2
          RETURNING id
        ),
        expired_provider_payloads AS (
          UPDATE prospect_contacts
          SET provider_payload = NULL,
              provider_payload_expires_at = NULL,
              updated_at = NOW()
          WHERE tenant_id = $1
            AND provider_payload IS NOT NULL
            AND provider_payload_expires_at IS NOT NULL
            AND provider_payload_expires_at <= $2
          RETURNING id
        ),
        deletable_prospects AS (
          SELECT business_prospects.id, business_prospects.discovery_run_id
          FROM business_prospects
          INNER JOIN discovery_runs
            ON discovery_runs.tenant_id = business_prospects.tenant_id
           AND discovery_runs.id = business_prospects.discovery_run_id
          WHERE business_prospects.tenant_id = $1
            AND discovery_runs.status = 'completed'
            AND business_prospects.lead_id IS NULL
            AND business_prospects.created_at <= $2 - ($4::text || ' days')::interval
            AND business_prospects.status IN (
              'normalized', 'assessed', 'contact_enriched', 'review_ready',
              'held', 'rejected', 'failed'
            )
        ),
        deleted_contacts AS (
          DELETE FROM prospect_contacts
          USING deletable_prospects
          WHERE prospect_contacts.tenant_id = $1
            AND prospect_contacts.prospect_id = deletable_prospects.id
          RETURNING prospect_contacts.id
        ),
        deleted_assessments AS (
          DELETE FROM prospect_assessments
          USING deletable_prospects
          WHERE prospect_assessments.tenant_id = $1
            AND prospect_assessments.discovery_run_id =
                deletable_prospects.discovery_run_id
            AND prospect_assessments.prospect_id = deletable_prospects.id
          RETURNING prospect_assessments.id
        ),
        deleted_prospects AS (
          DELETE FROM business_prospects
          USING deletable_prospects
          WHERE business_prospects.tenant_id = $1
            AND business_prospects.discovery_run_id =
                deletable_prospects.discovery_run_id
            AND business_prospects.id = deletable_prospects.id
          RETURNING business_prospects.id
        ),
        deleted_runs AS (
          DELETE FROM discovery_runs
          WHERE discovery_runs.tenant_id = $1
            AND discovery_runs.status = 'completed'
            AND discovery_runs.created_at <= $2 - ($4::text || ' days')::interval
            AND NOT EXISTS (
              SELECT 1
              FROM business_prospects
              WHERE business_prospects.tenant_id = discovery_runs.tenant_id
                AND business_prospects.discovery_run_id = discovery_runs.id
            )
          RETURNING discovery_runs.id
        )
        SELECT
          (SELECT COUNT(*)::integer FROM expired_source_payloads)
            AS source_payloads_cleared,
          (SELECT COUNT(*)::integer FROM expired_provider_payloads)
            AS provider_payloads_cleared,
          (SELECT COUNT(*)::integer FROM deleted_contacts) AS contacts_deleted,
          (SELECT COUNT(*)::integer FROM deleted_assessments) AS assessments_deleted,
          (SELECT COUNT(*)::integer FROM deleted_prospects) AS prospects_deleted,
          (SELECT COUNT(*)::integer FROM deleted_runs) AS runs_deleted,
          $3::integer AS raw_payload_retention_days,
          $4::integer AS snapshot_retention_days
        """,
        tenant_id,
        now,
        raw_payload_retention_days,
        snapshot_retention_days,
    )
    if result is None:
        raise LookupError("Prospect retention cleanup did not return counts")
    return dict(cast(Mapping[str, object], result))


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
        SELECT id, tenant_id, email, email_status, website_url, technologies, status,
               phone,
               first_name, last_name, business_name, city, state,
               industry, vertical, keywords
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
    has_actionable_weakness: bool | None
    subject_line: str | None
    personalised_opener: str | None
    followup_1: str | None
    followup_2: str | None
    weakness_sentence: str | None
    model_haiku: str
    model_sonnet: str | None
    cost_usd: Decimal
    prompt_version: str


# asyncpg returns json/jsonb columns as raw str unless a codec is registered
# on the connection, and none is: the pool is created bare in
# workers/orchestrator.py. Decoding cannot be done pool-wide with
# set_type_codec, because that registers an encoder too, and every jsonb write
# in this module already passes a json.dumps() string into a $n::jsonb
# parameter. Registering one would double-encode all of them. So decode on the
# way out, at the read that has a consumer.
_ENRICHMENT_JSONB_COLUMNS: tuple[str, ...] = ("weaknesses", "raw_audit")


def _decode_jsonb(value: object) -> object:
    """Decode a jsonb column asyncpg handed back as str.

    Non-str values pass through untouched, so this stays correct for NULL
    columns and for a future pool that does register a codec.
    """
    if not isinstance(value, str):
        return value
    return json.loads(value)


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
    row = dict(cast(Mapping[str, object], result))
    for column in _ENRICHMENT_JSONB_COLUMNS:
        if column in row:
            row[column] = _decode_jsonb(row[column])
    return row


async def list_leads_for_shadow_scoring(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    limit: int,
) -> list[dict[str, object]]:
    """Read enriched leads for an offline scoring run. Read-only by design.

    Used by workers.shadow_qualify to measure what the rewritten scoring
    prompt does to the score distribution, before the threshold that was
    calibrated against the old prompt is trusted with the new one. Nothing
    here writes, and the caller is handed no way to write either.
    """
    rows = await connection.fetch(
        """
        SELECT l.id AS lead_id, l.tenant_id, l.status,
               l.business_name, l.email, l.email_status, l.phone,
               l.city, l.state, l.website_url, l.industry, l.keywords,
               e.has_site, e.is_reachable, e.weaknesses
        FROM leads l
        JOIN enrichments e
          ON e.lead_id = l.id
        -- enrichments.lead_id references leads(id) alone, not the composite
        -- (tenant_id, id), so a mismatched enrichment row is physically
        -- insertable. This predicate is what stops one pairing with another
        -- tenant's lead.
         AND l.tenant_id = e.tenant_id
        WHERE l.tenant_id = $1
          AND l.is_deleted = FALSE
        -- imported_at alone ties across a bulk import and Postgres breaks
        -- ties arbitrarily, so two runs over unchanged data could return
        -- different rows and nobody would be able to see why.
        ORDER BY l.imported_at DESC, l.id DESC
        LIMIT $2
        """,
        tenant_id,
        limit,
    )
    decoded: list[dict[str, object]] = []
    for raw_row in rows:
        row = dict(cast(Mapping[str, object], raw_row))
        for column in _ENRICHMENT_JSONB_COLUMNS:
            if column in row:
                row[column] = _decode_jsonb(row[column])
        decoded.append(row)
    return decoded


async def insert_qualification(
    connection: DatabaseConnection,
    q: QualificationInsert,
) -> UUID:
    raw_id = await connection.fetchval(
        """
        INSERT INTO qualifications (
          lead_id, tenant_id,
          score, rationale, top_weakness, has_actionable_weakness,
          subject_line, personalised_opener, followup_1, followup_2,
          weakness_sentence,
          model_haiku, model_sonnet,
          cost_usd, prompt_version
        )
        SELECT
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15
        FROM leads
        WHERE id = $1
          AND tenant_id = $2
          AND is_deleted = FALSE
        ON CONFLICT (lead_id) DO UPDATE
        SET tenant_id = EXCLUDED.tenant_id,
            score = EXCLUDED.score,
            rationale = EXCLUDED.rationale,
            top_weakness = EXCLUDED.top_weakness,
            has_actionable_weakness = EXCLUDED.has_actionable_weakness,
            subject_line = EXCLUDED.subject_line,
            personalised_opener = EXCLUDED.personalised_opener,
            followup_1 = EXCLUDED.followup_1,
            followup_2 = EXCLUDED.followup_2,
            weakness_sentence = EXCLUDED.weakness_sentence,
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
        q.has_actionable_weakness,
        q.subject_line,
        q.personalised_opener,
        q.followup_1,
        q.followup_2,
        q.weakness_sentence,
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
               weakness_sentence,
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
    preview_slug: str
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
          tenant_id, lead_id, template_used, preview_slug, preview_url,
          personalisation_data, prompt_version, cost_usd
        )
        SELECT $1, $2, $3, $4, $5, $6::jsonb, $7, $8
        FROM leads
        WHERE tenant_id = $1
          AND id = $2
          AND is_deleted = FALSE
        ON CONFLICT (lead_id) DO UPDATE
        SET tenant_id = EXCLUDED.tenant_id,
            template_used = EXCLUDED.template_used,
            preview_slug = EXCLUDED.preview_slug,
            preview_url = EXCLUDED.preview_url,
            personalisation_data = EXCLUDED.personalisation_data,
            prompt_version = EXCLUDED.prompt_version,
            cost_usd = EXCLUDED.cost_usd,
            generated_at = NOW()
        WHERE website_previews.tenant_id = EXCLUDED.tenant_id
        RETURNING id
        """,
        preview.tenant_id,
        preview.lead_id,
        preview.template_used,
        preview.preview_slug,
        preview.preview_url,
        json.dumps(preview.personalisation_data),
        preview.prompt_version,
        preview.cost_usd,
    )
    if isinstance(raw_id, UUID):
        return raw_id
    if isinstance(raw_id, str):
        return UUID(raw_id)
    if raw_id is None:
        raise LookupError(f"Lead {preview.lead_id} not found for tenant {preview.tenant_id}")
    raise TypeError(f"Expected website preview UUID, got {type(raw_id).__name__}")


async def get_website_preview_by_lead_id(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
    lead_id: UUID,
) -> dict[str, object] | None:
    result = await connection.fetchrow(
        """
        SELECT id, tenant_id, lead_id, template_used, preview_slug, preview_url,
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
    """Record an outreach send.

    sent_at is set to NOW() at the moment Instantly accepts the lead, so it
    marks the handoff to Instantly and not the moment the email actually left
    a mailbox. Instantly queues the lead and sends it later, inside the
    campaign schedule and its own sending limits, and it never tells us when
    that happened. Anything that reads sent_at as a send time, a per-day sent
    count for instance, is counting handoffs.
    """
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
    """Attach the Instantly lead id to a reserved send.

    sent_at means the same thing here as in insert_outreach_send: the handoff
    to Instantly, not the actual send.
    """
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
           OR (
             $7 = TRUE
             AND
             queue_jobs.status = 'active'
             AND queue_jobs.started_at < NOW() - INTERVAL '10 minutes'
           )
        RETURNING id, TRUE AS acquired, started_at
        ),
        existing_job AS (
        SELECT id, FALSE AS acquired, started_at
        FROM queue_jobs
        WHERE tenant_id = $1
          AND lead_id = $2
          AND job_type = $3
          AND status IN ('pending', 'active', 'failed')
          AND NOT EXISTS (SELECT 1 FROM inserted_job)
        LIMIT 1
        )
        SELECT id, acquired, started_at FROM inserted_job
        UNION ALL
        SELECT id, acquired, started_at FROM existing_job
        LIMIT 1
        """,
        insert.tenant_id,
        insert.lead_id,
        insert.job_type,
        insert.attempt_count,
        insert.max_attempts,
        json.dumps(dict(insert.payload)),
        insert.recover_stale_active,
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
           OR (
             $6 = TRUE
             AND
             queue_jobs.status = 'active'
             AND queue_jobs.started_at < NOW() - INTERVAL '10 minutes'
           )
        RETURNING id, TRUE AS acquired, started_at
        ),
        existing_job AS (
        SELECT id, FALSE AS acquired, started_at
        FROM queue_jobs
        WHERE tenant_id = $1
          AND lead_id IS NULL
          AND job_type = $2
          AND status IN ('pending', 'active', 'failed')
          AND NOT EXISTS (SELECT 1 FROM inserted_job)
        LIMIT 1
        )
        SELECT id, acquired, started_at FROM inserted_job
        UNION ALL
        SELECT id, acquired, started_at FROM existing_job
        LIMIT 1
        """,
        insert.tenant_id,
        insert.job_type,
        insert.attempt_count,
        insert.max_attempts,
        json.dumps(dict(insert.payload)),
        insert.recover_stale_active,
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
    raw_started_at = row.get("started_at")
    if isinstance(raw_started_at, str):
        lease_started_at = datetime.fromisoformat(raw_started_at)
    elif isinstance(raw_started_at, datetime):
        lease_started_at = raw_started_at
    else:
        raise TypeError(
            f"Expected queue job started_at datetime, got {type(raw_started_at).__name__}"
        )
    return QueueJobLease(
        job_id=job_id,
        acquired=bool(row["acquired"]),
        lease_started_at=lease_started_at,
    )


async def fetch_queue_progress(
    connection: DatabaseConnection,
    *,
    tenant_id: UUID,
) -> QueueProgress:
    """Read the progress signal the stall alarm is built on.

    `completed_at` is written only by `update_queue_job` for the `completed`
    and `dead` statuses, so a non-null maximum is proof that a job reached a
    terminal state. A `failed` row leaves `completed_at` null on purpose: a
    worker that fails every job is not making progress either, and this alarm
    should say so rather than count failures as movement.

    Scoped by tenant like every other read in this module. The alarm runs for
    the tenant in TENANT_ID, which is the tenant the campaign runs under.
    """
    row = await connection.fetchrow(
        """
        SELECT
          max(completed_at) AS last_completion_at,
          max(started_at) AS last_start_at,
          count(*) FILTER (WHERE status = 'active') AS active_job_count,
          min(started_at) FILTER (WHERE status = 'active') AS oldest_active_started_at
        FROM queue_jobs
        WHERE tenant_id = $1
        """,
        tenant_id,
    )
    if row is None:
        return QueueProgress(
            last_completion_at=None,
            last_start_at=None,
            active_job_count=0,
            oldest_active_started_at=None,
        )
    mapping = cast(Mapping[str, object], row)
    return QueueProgress(
        last_completion_at=_optional_datetime(mapping.get("last_completion_at")),
        last_start_at=_optional_datetime(mapping.get("last_start_at")),
        active_job_count=int(cast(SupportsInt, mapping.get("active_job_count") or 0)),
        oldest_active_started_at=_optional_datetime(mapping.get("oldest_active_started_at")),
    )


def _optional_datetime(value: object) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        return datetime.fromisoformat(value)
    raise TypeError(f"Expected a timestamp, got {type(value).__name__}")


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
          AND status = 'active'
          AND started_at = $6::timestamptz
        """,
        update.job_id,
        update.tenant_id,
        update.status,
        update.attempt_count,
        update.error_message,
        update.lease_started_at,
    )
