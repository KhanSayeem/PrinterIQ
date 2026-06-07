from __future__ import annotations

import asyncio
from decimal import Decimal
from uuid import UUID

import db.queries as queries
from db.queries import (
    OutreachSendInsert,
    WebsitePreviewInsert,
    abandon_outreach_send_reservation,
    acquire_outreach_send_lock,
    complete_outreach_send,
    get_lead_by_id,
    get_outreach_send_by_lead_campaign_channel,
    get_qualification_by_lead_id,
    insert_outreach_send,
    mark_lead_contacted,
    release_outreach_send_lock,
    reserve_outreach_send,
)

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
LEAD_ID = UUID("20000000-0000-0000-0000-000000000002")
PREVIEW_ID = UUID("30000000-0000-0000-0000-000000000004")


class RecordingConnection:
    def __init__(self, *, fetchval_result: object = None, fetchrow_result: object = None) -> None:
        self.fetchval_result = fetchval_result
        self.fetchrow_result = fetchrow_result
        self.queries: list[str] = []
        self.args: list[tuple[object, ...]] = []

    async def fetchval(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        return self.fetchval_result

    async def fetchrow(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        return self.fetchrow_result

    async def execute(self, query: str, *args: object) -> object:
        self.queries.append(query)
        self.args.append(args)
        return "UPDATE 1"


def test_get_qualification_by_lead_id_is_tenant_scoped() -> None:
    async def scenario() -> None:
        expected = {"lead_id": LEAD_ID, "tenant_id": TENANT_ID, "personalised_opener": "Hi"}
        conn = RecordingConnection(fetchrow_result=expected)

        result = await get_qualification_by_lead_id(
            conn,
            tenant_id=TENANT_ID,
            lead_id=LEAD_ID,
        )

        assert result == expected
        assert "FROM qualifications" in conn.queries[0]
        assert "tenant_id = $1" in conn.queries[0]
        assert "lead_id = $2" in conn.queries[0]
        assert conn.args[0] == (TENANT_ID, LEAD_ID)

    asyncio.run(scenario())


def test_get_lead_by_id_includes_preview_trade_context() -> None:
    async def scenario() -> None:
        expected = {
            "id": LEAD_ID,
            "tenant_id": TENANT_ID,
            "email": "hello@example.com",
            "industry": "Plumbing",
            "vertical": "tradies",
            "keywords": "hot water, blocked drains",
        }
        conn = RecordingConnection(fetchrow_result=expected)

        result = await get_lead_by_id(conn, tenant_id=TENANT_ID, lead_id=LEAD_ID)

        assert result == expected
        query = conn.queries[0]
        assert "industry" in query
        assert "vertical" in query
        assert "keywords" in query
        assert "tenant_id = $1" in query
        assert "id = $2" in query

    asyncio.run(scenario())


def test_insert_website_preview_writes_tenant_scoped_metadata() -> None:
    async def scenario() -> None:
        conn = RecordingConnection(fetchval_result=PREVIEW_ID)

        assert hasattr(queries, "insert_website_preview")

        result = await queries.insert_website_preview(
            conn,
            WebsitePreviewInsert(
                tenant_id=TENANT_ID,
                lead_id=LEAD_ID,
                template_used="plumbing",
                preview_url=f"https://preview.presciaiq.com/{LEAD_ID}",
                personalisation_data={
                    "about_blurb": "Aqua Flow helps Brisbane homes. Locals call for urgent jobs.",
                    "founder_name": "Sarah Nguyen",
                    "year_founded": 2008,
                    "services": [],
                },
                prompt_version="preview-personalise-v1",
                cost_usd=Decimal("0.000100"),
            ),
        )

        assert result == PREVIEW_ID
        query = conn.queries[0]
        assert "INSERT INTO website_previews" in query
        assert "FROM leads" in query
        assert "id = $2" in query
        assert "tenant_id = $1" in query
        assert "is_deleted = FALSE" in query
        assert "ON CONFLICT (lead_id) DO UPDATE" in query
        assert "website_previews.tenant_id = EXCLUDED.tenant_id" in query
        assert "tenant_id" in query
        assert "lead_id" in query
        assert "personalisation_data" in query
        assert "prompt_version" in query
        assert conn.args[0][0] == TENANT_ID
        assert conn.args[0][1] == LEAD_ID

    asyncio.run(scenario())


def test_get_website_preview_by_lead_id_is_tenant_scoped() -> None:
    async def scenario() -> None:
        expected = {
            "id": PREVIEW_ID,
            "tenant_id": TENANT_ID,
            "lead_id": LEAD_ID,
            "template_used": "plumbing",
            "preview_url": f"https://preview.presciaiq.com/{LEAD_ID}",
        }
        conn = RecordingConnection(fetchrow_result=expected)

        assert hasattr(queries, "get_website_preview_by_lead_id")

        result = await queries.get_website_preview_by_lead_id(
            conn,
            tenant_id=TENANT_ID,
            lead_id=LEAD_ID,
        )

        assert result == expected
        query = conn.queries[0]
        assert "FROM website_previews" in query
        assert "tenant_id = $1" in query
        assert "lead_id = $2" in query
        assert conn.args[0] == (TENANT_ID, LEAD_ID)

    asyncio.run(scenario())


def test_insert_outreach_send_writes_tenant_campaign_and_instantly_ids() -> None:
    async def scenario() -> None:
        outreach_id = UUID("30000000-0000-0000-0000-000000000003")
        conn = RecordingConnection(fetchval_result=outreach_id)

        result = await insert_outreach_send(
            conn,
            OutreachSendInsert(
                tenant_id=TENANT_ID,
                lead_id=LEAD_ID,
                instantly_campaign_id="campaign-123",
                instantly_lead_id="instantly-lead-123",
                channel="email",
            ),
        )

        assert result == outreach_id
        query = conn.queries[0]
        assert "INSERT INTO outreach_sends" in query
        assert "existing_send" in query
        assert "SELECT" in query
        assert "FROM leads" in query
        assert "id = $2" in query
        assert "tenant_id = $1" in query
        assert "status = 'qualified'" in query
        assert "ON CONFLICT" in query
        assert "tenant_id" in query
        assert "lead_id" in query
        assert "instantly_campaign_id" in query
        assert "instantly_lead_id" in query
        assert conn.args[0] == (
            TENANT_ID,
            LEAD_ID,
            "instantly-lead-123",
            "campaign-123",
            "email",
        )

    asyncio.run(scenario())


def test_insert_outreach_send_returns_existing_send_for_replay_after_contacted() -> None:
    async def scenario() -> None:
        outreach_id = UUID("30000000-0000-0000-0000-000000000003")
        conn = RecordingConnection(fetchval_result=outreach_id)

        result = await insert_outreach_send(
            conn,
            OutreachSendInsert(
                tenant_id=TENANT_ID,
                lead_id=LEAD_ID,
                instantly_campaign_id="campaign-123",
                instantly_lead_id="instantly-lead-123",
                channel="email",
            ),
        )

        assert result == outreach_id
        query = conn.queries[0]
        assert "existing_send" in query
        assert "UNION ALL" in query
        assert "LIMIT 1" in query

    asyncio.run(scenario())


def test_reserve_outreach_send_writes_tenant_scoped_pending_row() -> None:
    async def scenario() -> None:
        outreach_id = UUID("30000000-0000-0000-0000-000000000003")
        conn = RecordingConnection(fetchval_result=outreach_id)

        result = await reserve_outreach_send(
            conn,
            tenant_id=TENANT_ID,
            lead_id=LEAD_ID,
            instantly_campaign_id="campaign-123",
            channel="email",
        )

        assert result == outreach_id
        query = conn.queries[0]
        assert "INSERT INTO outreach_sends" in query
        assert "instantly_lead_id" not in query
        assert "sent_at" not in query
        assert "tenant_id = $1" in query
        assert "id = $2" in query
        assert "status = 'qualified'" in query
        assert "ON CONFLICT" in query
        assert "DO NOTHING" in query
        assert conn.args[0] == (TENANT_ID, LEAD_ID, "campaign-123", "email")

    asyncio.run(scenario())


def test_complete_outreach_send_sets_instantly_id_and_sent_at_for_reserved_row() -> None:
    async def scenario() -> None:
        outreach_id = UUID("30000000-0000-0000-0000-000000000003")
        conn = RecordingConnection(fetchval_result=outreach_id)

        result = await complete_outreach_send(
            conn,
            OutreachSendInsert(
                tenant_id=TENANT_ID,
                lead_id=LEAD_ID,
                instantly_campaign_id="campaign-123",
                instantly_lead_id="instantly-lead-123",
                channel="email",
            ),
        )

        assert result == outreach_id
        query = conn.queries[0]
        assert "UPDATE outreach_sends" in query
        assert "SET instantly_lead_id = $3" in query
        assert "sent_at = NOW()" in query
        assert "tenant_id = $1" in query
        assert "lead_id = $2" in query
        assert "instantly_campaign_id = $4" in query
        assert "channel = $5" in query
        assert conn.args[0] == (
            TENANT_ID,
            LEAD_ID,
            "instantly-lead-123",
            "campaign-123",
            "email",
        )

    asyncio.run(scenario())


def test_abandon_outreach_send_reservation_deletes_only_pending_tenant_row() -> None:
    async def scenario() -> None:
        conn = RecordingConnection()

        await abandon_outreach_send_reservation(
            conn,
            tenant_id=TENANT_ID,
            lead_id=LEAD_ID,
            instantly_campaign_id="campaign-123",
            channel="email",
        )

        query = conn.queries[0]
        assert "DELETE FROM outreach_sends" in query
        assert "tenant_id = $1" in query
        assert "lead_id = $2" in query
        assert "instantly_campaign_id = $3" in query
        assert "channel = $4" in query
        assert "instantly_lead_id IS NULL" in query
        assert conn.args[0] == (TENANT_ID, LEAD_ID, "campaign-123", "email")

    asyncio.run(scenario())


def test_get_existing_outreach_send_is_tenant_scoped_by_campaign_and_channel() -> None:
    async def scenario() -> None:
        expected = {
            "id": UUID("30000000-0000-0000-0000-000000000003"),
            "tenant_id": TENANT_ID,
            "lead_id": LEAD_ID,
            "instantly_campaign_id": "campaign-123",
            "channel": "email",
        }
        conn = RecordingConnection(fetchrow_result=expected)

        result = await get_outreach_send_by_lead_campaign_channel(
            conn,
            tenant_id=TENANT_ID,
            lead_id=LEAD_ID,
            instantly_campaign_id="campaign-123",
            channel="email",
        )

        assert result == expected
        query = conn.queries[0]
        assert "FROM outreach_sends" in query
        assert "tenant_id = $1" in query
        assert "lead_id = $2" in query
        assert "instantly_campaign_id = $3" in query
        assert "channel = $4" in query
        assert conn.args[0] == (TENANT_ID, LEAD_ID, "campaign-123", "email")

    asyncio.run(scenario())


def test_mark_lead_contacted_is_tenant_scoped_and_requires_qualified_status() -> None:
    async def scenario() -> None:
        conn = RecordingConnection()

        updated = await mark_lead_contacted(conn, tenant_id=TENANT_ID, lead_id=LEAD_ID)

        query = conn.queries[0]
        assert "UPDATE leads" in query
        assert "SET status = 'contacted'" in query
        assert "tenant_id = $1" in query
        assert "id = $2" in query
        assert "status = 'qualified'" in query
        assert conn.args[0] == (TENANT_ID, LEAD_ID)
        assert updated is True

    asyncio.run(scenario())


def test_acquire_outreach_send_lock_uses_tenant_scoped_lock_key() -> None:
    async def scenario() -> None:
        conn = RecordingConnection(fetchval_result=True)

        acquired = await acquire_outreach_send_lock(
            conn,
            tenant_id=TENANT_ID,
            lead_id=LEAD_ID,
            instantly_campaign_id="campaign-123",
            channel="email",
        )

        query = conn.queries[0]
        assert "pg_try_advisory_lock" in query
        assert "hashtextextended($1::text, 0)" in query
        assert str(TENANT_ID) in str(conn.args[0][0])
        assert str(LEAD_ID) in str(conn.args[0][0])
        assert "campaign-123" in str(conn.args[0][0])
        assert "email" in str(conn.args[0][0])
        assert acquired is True

    asyncio.run(scenario())


def test_release_outreach_send_lock_uses_same_tenant_scoped_lock_key() -> None:
    async def scenario() -> None:
        conn = RecordingConnection(fetchval_result=True)

        await release_outreach_send_lock(
            conn,
            tenant_id=TENANT_ID,
            lead_id=LEAD_ID,
            instantly_campaign_id="campaign-123",
            channel="email",
        )

        query = conn.queries[0]
        assert "pg_advisory_unlock" in query
        assert "hashtextextended($1::text, 0)" in query
        assert str(TENANT_ID) in str(conn.args[0][0])
        assert str(LEAD_ID) in str(conn.args[0][0])
        assert "campaign-123" in str(conn.args[0][0])
        assert "email" in str(conn.args[0][0])

    asyncio.run(scenario())
