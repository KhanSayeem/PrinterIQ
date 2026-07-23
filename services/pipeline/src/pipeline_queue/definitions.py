from __future__ import annotations

from enum import StrEnum


class QueueName(StrEnum):
    PIPELINE = "pipeline"
    REPLIES = "replies"


class JobType(StrEnum):
    INGEST_CSV = "ingest_csv"
    ENRICH_LEAD = "enrich_lead"
    QUALIFY_LEAD = "qualify_lead"
    GENERATE_PREVIEW = "generate_preview"
    SCHEDULE_OUTREACH = "schedule_outreach"
    START_DISCOVERY = "start_discovery"
    POLL_OUTSCRAPER = "poll_outscraper"
    NORMALIZE_PROSPECTS = "normalize_prospects"
    ASSESS_PROSPECTS = "assess_prospects"
    ENRICH_PROSPECT_CONTACTS = "enrich_prospect_contacts"
    PREPARE_SHADOW_REVIEW = "prepare_shadow_review"
    PURGE_PROSPECT_DATA = "purge_prospect_data"
    PROCESS_REPLY = "process_reply"
    SEND_REPLY = "send_reply"
    RETRY_CHECKOUT = "retry_checkout"


PIPELINE_JOB_TYPES = frozenset(
    {
        JobType.INGEST_CSV,
        JobType.ENRICH_LEAD,
        JobType.QUALIFY_LEAD,
        JobType.GENERATE_PREVIEW,
        JobType.SCHEDULE_OUTREACH,
        JobType.START_DISCOVERY,
        JobType.POLL_OUTSCRAPER,
        JobType.NORMALIZE_PROSPECTS,
        JobType.ASSESS_PROSPECTS,
        JobType.ENRICH_PROSPECT_CONTACTS,
        JobType.PREPARE_SHADOW_REVIEW,
        JobType.PURGE_PROSPECT_DATA,
    }
)
REPLY_JOB_TYPES = frozenset(
    {
        JobType.PROCESS_REPLY,
        JobType.SEND_REPLY,
        JobType.RETRY_CHECKOUT,
    }
)


def queue_for_job_type(job_type: JobType) -> QueueName:
    if job_type in PIPELINE_JOB_TYPES:
        return QueueName.PIPELINE
    if job_type in REPLY_JOB_TYPES:
        return QueueName.REPLIES
    raise ValueError(f"Unknown job type: {job_type}")
