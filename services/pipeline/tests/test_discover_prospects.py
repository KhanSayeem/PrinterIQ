from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID

from clients.outscraper_client import (
    OutscraperAPIError,
    OutscraperRequest,
    OutscraperRetryableError,
)
from workers.discover_prospects import (
    APPROVED_DISCOVERY_QUERIES,
    poll_outscraper,
    start_discovery,
)

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
RUN_ID = UUID("20000000-0000-0000-0000-000000000001")
NOW = datetime(2026, 7, 22, 12, 0, tzinfo=UTC)


class _Store:
    def __init__(self, run: dict[str, object]) -> None:
        self.run = run
        self.events: list[tuple[str, object]] = []
        self.snapshots: list[object] = []

    async def get_discovery_run(self, *, tenant_id: UUID, discovery_run_id: UUID):
        assert tenant_id == TENANT_ID
        assert discovery_run_id == RUN_ID
        return self.run

    async def transition_discovery_run(self, **values: object) -> bool:
        assert values["tenant_id"] == TENANT_ID
        assert values["discovery_run_id"] == RUN_ID
        self.events.append(("transition", values))
        self.run["status"] = values["to_status"]
        if values.get("source_request_id"):
            self.run["source_request_id"] = values["source_request_id"]
        return True

    async def upsert_source_prospect(self, snapshot: object) -> UUID:
        self.snapshots.append(snapshot)
        self.events.append(("persist", snapshot))
        return UUID("30000000-0000-0000-0000-000000000001")


class _Queue:
    def __init__(self, events: list[tuple[str, object]]) -> None:
        self.events = events

    async def enqueue(
        self, payload: dict[str, object], *, delay_until: datetime | None = None
    ) -> None:
        self.events.append(("enqueue", (payload, delay_until)))


class _Client:
    def __init__(self, response: OutscraperRequest) -> None:
        self.response = response
        self.submit_calls: list[tuple[list[str], int]] = []
        self.poll_calls: list[str] = []

    async def submit_google_maps_search(
        self, queries: list[str], total_limit: int
    ) -> OutscraperRequest:
        self.submit_calls.append((queries, total_limit))
        return self.response

    async def get_request(self, request_id: str) -> OutscraperRequest:
        self.poll_calls.append(request_id)
        return self.response


class _FailingSubmitClient(_Client):
    async def submit_google_maps_search(
        self, queries: list[str], total_limit: int
    ) -> OutscraperRequest:
        self.submit_calls.append((queries, total_limit))
        raise RuntimeError("ambiguous transport failure")


class _FailingPollClient(_Client):
    async def get_request(self, request_id: str) -> OutscraperRequest:
        self.poll_calls.append(request_id)
        raise OutscraperRetryableError("provider transport failed")


class _RejectedPollClient(_Client):
    async def get_request(self, request_id: str) -> OutscraperRequest:
        self.poll_calls.append(request_id)
        raise OutscraperAPIError("request rejected")


def _payload(*, poll_count: int | None = None) -> dict[str, object]:
    payload: dict[str, object] = {
        "tenant_id": str(TENANT_ID),
        "discovery_run_id": str(RUN_ID),
    }
    if poll_count is not None:
        payload["poll_count"] = poll_count
    return payload


def test_fixed_preset_expands_three_categories_across_five_localities() -> None:
    assert len(APPROVED_DISCOVERY_QUERIES) == 15
    assert "Plumber Brisbane QLD" in APPROVED_DISCOVERY_QUERIES
    assert "Drainage service Moreton Bay QLD" in APPROVED_DISCOVERY_QUERIES
    assert "Gas fitter Redlands QLD" in APPROVED_DISCOVERY_QUERIES


def test_start_submits_fixed_preset_stores_request_then_schedules_poll() -> None:
    async def scenario() -> None:
        store = _Store({"status": "created", "source_request_id": None})
        client = _Client(OutscraperRequest("request-123", "Pending", []))

        await start_discovery(
            _payload(),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
            poll_seconds=30,
        )

        assert client.submit_calls == [(list(APPROVED_DISCOVERY_QUERIES), 500)]
        assert [event[0] for event in store.events] == ["transition", "transition", "enqueue"]
        submitted = store.events[0][1]
        assert isinstance(submitted, dict)
        assert submitted["to_status"] == "submitted"
        assert submitted.get("source_request_id") is None
        polling = store.events[1][1]
        assert isinstance(polling, dict)
        assert polling["source_request_id"] == "request-123"
        payload, delay_until = store.events[-1][1]
        assert payload == {
            "job_type": "poll_outscraper",
            "tenant_id": str(TENANT_ID),
            "discovery_run_id": str(RUN_ID),
            "poll_count": 1,
        }
        assert delay_until == NOW + timedelta(seconds=30)

    asyncio.run(scenario())


def test_start_with_empty_provider_request_id_fails_without_polling() -> None:
    async def scenario() -> None:
        store = _Store({"status": "created", "source_request_id": None})
        client = _Client(OutscraperRequest("", "Pending", []))

        await start_discovery(
            _payload(),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
            poll_seconds=30,
        )

        assert len(client.submit_calls) == 1
        assert [event[0] for event in store.events] == ["transition", "transition"]
        failed = store.events[-1][1]
        assert isinstance(failed, dict)
        assert failed["to_status"] == "failed"
        assert failed["failure_code"] == "outscraper_missing_request_id"

    asyncio.run(scenario())


def test_start_retry_with_stored_request_does_not_resubmit() -> None:
    async def scenario() -> None:
        store = _Store({"status": "submitted", "source_request_id": "request-123"})
        client = _Client(OutscraperRequest("unused", "Pending", []))

        await start_discovery(
            _payload(),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
            poll_seconds=30,
        )

        assert client.submit_calls == []
        assert [event[0] for event in store.events] == ["transition", "enqueue"]

    asyncio.run(scenario())


def test_start_retry_after_ambiguous_submission_does_not_spend_again() -> None:
    async def scenario() -> None:
        store = _Store({"status": "submitted", "source_request_id": None})
        client = _Client(OutscraperRequest("unused", "Pending", []))

        await start_discovery(
            _payload(),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
        )

        assert client.submit_calls == []
        transition = store.events[0][1]
        assert isinstance(transition, dict)
        assert transition["to_status"] == "failed"
        assert transition["failure_code"] == "outscraper_submission_uncertain"

    asyncio.run(scenario())


def test_submission_transport_failure_is_terminal_to_avoid_duplicate_spend() -> None:
    async def scenario() -> None:
        store = _Store({"status": "created", "source_request_id": None})
        client = _FailingSubmitClient(OutscraperRequest("unused", "Pending", []))

        await start_discovery(
            _payload(),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
        )

        assert len(client.submit_calls) == 1
        assert [event[0] for event in store.events] == ["transition", "transition"]
        failed = store.events[-1][1]
        assert isinstance(failed, dict)
        assert failed["to_status"] == "failed"
        assert failed["failure_code"] == "outscraper_submission_uncertain"
        assert "ambiguous transport failure" not in str(failed["failure_detail"])

    asyncio.run(scenario())


def test_pending_poll_schedules_next_poll_without_raising() -> None:
    async def scenario() -> None:
        store = _Store({"status": "polling", "source_request_id": "request-123"})
        client = _Client(OutscraperRequest("request-123", "Pending", []))

        await poll_outscraper(
            _payload(poll_count=4),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
            poll_seconds=30,
        )

        assert client.poll_calls == ["request-123"]
        queued, delay_until = store.events[-1][1]
        assert queued["poll_count"] == 5
        assert delay_until == NOW + timedelta(seconds=30)

    asyncio.run(scenario())


def test_poll_limit_marks_run_failed_without_another_provider_call() -> None:
    async def scenario() -> None:
        store = _Store({"status": "polling", "source_request_id": "request-123"})
        client = _Client(OutscraperRequest("request-123", "Pending", []))

        await poll_outscraper(
            _payload(poll_count=30),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
            poll_seconds=30,
        )

        assert client.poll_calls == []
        assert len(store.events) == 1
        transition = store.events[0][1]
        assert isinstance(transition, dict)
        assert transition["to_status"] == "failed"
        assert transition["failure_code"] == "outscraper_timeout"

    asyncio.run(scenario())


def test_exhausted_poll_transport_retries_mark_run_failed() -> None:
    async def scenario() -> None:
        store = _Store({"status": "polling", "source_request_id": "request-123"})
        client = _FailingPollClient(OutscraperRequest("unused", "Pending", []))
        payload = _payload(poll_count=4) | {"attempt_count": 5}

        await poll_outscraper(
            payload,
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
        )

        assert client.poll_calls == ["request-123"]
        transition = store.events[0][1]
        assert isinstance(transition, dict)
        assert transition["to_status"] == "failed"
        assert transition["failure_code"] == "outscraper_transport_exhausted"
        assert "provider transport failed" not in str(transition["failure_detail"])

    asyncio.run(scenario())


def test_permanent_poll_error_fails_run_without_queue_retry() -> None:
    async def scenario() -> None:
        store = _Store({"status": "polling", "source_request_id": "request-123"})
        client = _RejectedPollClient(OutscraperRequest("unused", "Pending", []))

        await poll_outscraper(
            _payload(poll_count=4),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
        )

        transition = store.events[0][1]
        assert isinstance(transition, dict)
        assert transition["to_status"] == "failed"
        assert transition["failure_code"] == "outscraper_request_rejected"
        assert "request rejected" not in str(transition["failure_detail"])

    asyncio.run(scenario())


def test_poll_retry_after_persistence_enqueues_normalization_without_provider_call() -> None:
    async def scenario() -> None:
        store = _Store({"status": "persisted", "source_request_id": "request-123"})
        client = _Client(OutscraperRequest("unused", "Pending", []))

        await poll_outscraper(
            _payload(poll_count=2),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
        )

        assert client.poll_calls == []
        assert store.events == [
            (
                "enqueue",
                (
                    {
                        "job_type": "normalize_prospects",
                        "tenant_id": str(TENANT_ID),
                        "discovery_run_id": str(RUN_ID),
                    },
                    None,
                ),
            )
        ]

    asyncio.run(scenario())


def test_late_poll_replay_after_processing_does_not_call_provider_or_rewrite_snapshots() -> None:
    async def scenario() -> None:
        store = _Store({"status": "processing", "source_request_id": "request-123"})
        client = _Client(
            OutscraperRequest(
                "request-123",
                "Success",
                [{"place_id": "place-1", "name": "Replay Plumbing"}],
            )
        )

        await poll_outscraper(
            _payload(poll_count=2),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
        )

        assert client.poll_calls == []
        assert store.events == []
        assert store.snapshots == []

    asyncio.run(scenario())


def test_poll_response_request_id_mismatch_fails_run_without_persisting_records() -> None:
    async def scenario() -> None:
        store = _Store({"status": "polling", "source_request_id": "request-123"})
        client = _Client(
            OutscraperRequest(
                "request-456",
                "Success",
                [{"place_id": "place-1", "name": "Wrong Run Plumbing"}],
            )
        )

        await poll_outscraper(
            _payload(poll_count=2),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
        )

        assert client.poll_calls == ["request-123"]
        assert store.snapshots == []
        assert len(store.events) == 1
        transition = store.events[0][1]
        assert isinstance(transition, dict)
        assert transition["to_status"] == "failed"
        assert transition["failure_code"] == "outscraper_request_mismatch"

    asyncio.run(scenario())


def test_success_persists_every_record_then_enqueues_normalization() -> None:
    async def scenario() -> None:
        records: list[dict[str, object]] = [
            {"place_id": "place-1", "name": "Northside Plumbing"},
            {"name": "Malformed provider record", "phone": "+61 400 000 000"},
        ]
        store = _Store({"status": "polling", "source_request_id": "request-123"})
        client = _Client(OutscraperRequest("request-123", "Success", records))

        await poll_outscraper(
            _payload(poll_count=2),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
            poll_seconds=30,
        )

        assert [event[0] for event in store.events] == [
            "persist",
            "persist",
            "transition",
            "enqueue",
        ]
        first, malformed = store.snapshots
        assert first.source_business_id == "place-1"
        assert first.status == "discovered"
        assert malformed.source_business_id.startswith("invalid:")
        assert malformed.status == "failed"
        assert malformed.outcome_reason == "missing_place_id"
        transition = store.events[-1][1]
        if not isinstance(transition, dict):
            transition = store.events[-2][1]
        assert isinstance(transition, dict)
        assert transition["to_status"] == "persisted"
        queued, delay_until = store.events[-1][1]
        assert queued == {
            "job_type": "normalize_prospects",
            "tenant_id": str(TENANT_ID),
            "discovery_run_id": str(RUN_ID),
        }
        assert delay_until is None

    asyncio.run(scenario())


def test_success_maps_realistic_outscraper_fields_into_classification_columns() -> None:
    async def scenario() -> None:
        record = {
            "place_id": "ChIJ-test",
            "name": "Northside Plumbing",
            "site": "https://facebook.com/northsideplumbing",
            "phone": "+61 7 3000 0000",
            "full_address": "100 Creek Street, Fortitude Valley QLD 4006",
            "city": "Fortitude Valley",
            "state": "Queensland",
            "postal_code": "4006",
            "category": "Plumber",
            "subtypes": "Plumber, Drainage service",
            "rating": 4.6,
            "reviews": 42,
            "business_status": "OPERATIONAL",
            "location_link": "https://google.example/place",
        }
        store = _Store({"status": "polling", "source_request_id": "request-123"})
        client = _Client(OutscraperRequest("request-123", "Success", [record]))

        await poll_outscraper(
            _payload(poll_count=2),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
        )

        snapshot = store.snapshots[0]
        assert snapshot.primary_category == "Plumber"
        assert snapshot.additional_categories == ("Plumber", "Drainage service")
        assert snapshot.phone == "+61 7 3000 0000"
        assert snapshot.full_address == "100 Creek Street, Fortitude Valley QLD 4006"
        assert snapshot.locality == "Fortitude Valley"
        assert snapshot.state == "Queensland"
        assert snapshot.postcode == "4006"
        assert snapshot.business_status == "OPERATIONAL"
        assert str(snapshot.rating) == "4.6"
        assert snapshot.review_count == 42
        assert snapshot.google_profile_url == "https://google.example/place"
        assert snapshot.source_website_url == "https://facebook.com/northsideplumbing"

    asyncio.run(scenario())


def test_success_maps_current_outscraper_website_field_into_classification_columns() -> None:
    async def scenario() -> None:
        record = {
            "place_id": "place-current",
            "name": "Current Website Plumbing",
            "website": "https://current-plumbing.example",
            "phone": "+61 7 3000 0000",
            "address": "1 Queen St, Brisbane QLD 4000",
            "city": "Brisbane",
            "state": "Queensland",
            "postal_code": "4000",
            "type": "Plumber",
            "subtypes": "Plumber",
            "business_status": "OPERATIONAL",
        }
        store = _Store({"status": "polling", "source_request_id": "request-123"})
        client = _Client(
            OutscraperRequest("request-123", "Success", [record])
        )

        await poll_outscraper(
            _payload(poll_count=1),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
        )

        snapshot = store.snapshots[0]
        assert snapshot.source_website_url == "https://current-plumbing.example"
        assert snapshot.full_address == "1 Queen St, Brisbane QLD 4000"
        assert snapshot.source_payload["website"] == "https://current-plumbing.example"

    asyncio.run(scenario())


def test_malformed_record_identity_is_stable_for_replay() -> None:
    async def run_once() -> str:
        record = {"phone": "+61 400 000 000", "name": "Malformed"}
        store = _Store({"status": "polling", "source_request_id": "request-123"})
        client = _Client(OutscraperRequest("request-123", "Success", [record]))
        await poll_outscraper(
            _payload(poll_count=1),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
            poll_seconds=30,
        )
        return store.snapshots[0].source_business_id

    assert asyncio.run(run_once()) == asyncio.run(run_once())


def test_provider_failure_marks_run_failed_without_exposing_provider_data() -> None:
    async def scenario() -> None:
        store = _Store({"status": "polling", "source_request_id": "request-123"})
        client = _Client(OutscraperRequest("request-123", "Failure", []))

        await poll_outscraper(
            _payload(poll_count=2),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
            poll_seconds=30,
        )

        transition = store.events[0][1]
        assert isinstance(transition, dict)
        assert transition["to_status"] == "failed"
        assert transition["failure_code"] == "outscraper_provider_failure"
        assert transition["failure_detail"] == "Outscraper reported a terminal failure."

    asyncio.run(scenario())


def test_success_locally_caps_and_deduplicates_persisted_businesses() -> None:
    async def scenario() -> None:
        records = [
            {"place_id": "place-0", "name": "First"},
            {"place_id": "place-0", "name": "Duplicate"},
            *[
                {"place_id": f"place-{index}", "name": f"Business {index}"}
                for index in range(1, 501)
            ],
        ]
        store = _Store({"status": "polling", "source_request_id": "request-123"})
        client = _Client(OutscraperRequest("request-123", "Success", records))

        await poll_outscraper(
            _payload(poll_count=1),
            store=store,
            queue=_Queue(store.events),
            outscraper_client=client,
            now=lambda: NOW,
        )

        assert len(store.snapshots) == 500
        assert len({snapshot.source_business_id for snapshot in store.snapshots}) == 500
        transition = next(event[1] for event in store.events if event[0] == "transition")
        assert isinstance(transition, dict)
        assert transition["discovered_count"] == 500

    asyncio.run(scenario())
