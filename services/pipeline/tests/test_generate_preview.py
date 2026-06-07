from __future__ import annotations

import asyncio
import importlib
import importlib.util
import json
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from uuid import UUID

import pytest

from pipeline_queue.definitions import JobType

TENANT_ID = UUID("10000000-0000-0000-0000-000000000001")
LEAD_ID = UUID("20000000-0000-0000-0000-000000000002")
HAIKU_MODEL = "claude-haiku-4-5-20251001"
HAIKU_COST = Decimal("0.000100")
TEMPLATE_KEYS = ["plumbing", "electrical", "hvac", "concreting", "landscaping", "general"]


def _generate_preview_module() -> object:
    spec = importlib.util.find_spec("workers.generate_preview")
    assert spec is not None
    return importlib.import_module("workers.generate_preview")


@dataclass(frozen=True)
class ClaudeResponse:
    text: str
    cost_usd: Decimal
    model: str


@dataclass
class FakeLeadFetcher:
    lead: dict[str, object]
    calls: list[tuple[UUID, UUID]] = field(default_factory=list)

    async def get_lead(self, *, tenant_id: UUID, lead_id: UUID) -> dict[str, object]:
        self.calls.append((tenant_id, lead_id))
        return self.lead


@dataclass
class FakePreviewRepository:
    inserted: list[dict[str, object]] = field(default_factory=list)
    fail_insert: bool = False

    async def insert_website_preview(self, preview: dict[str, object]) -> UUID:
        if self.fail_insert:
            raise RuntimeError("database unavailable")
        self.inserted.append(preview)
        return UUID("40000000-0000-0000-0000-000000000004")


@dataclass
class FakeScheduleQueue:
    jobs: list[dict[str, object]] = field(default_factory=list)

    async def enqueue(self, payload: dict[str, object]) -> None:
        self.jobs.append(payload)


@dataclass
class FakeClaudeClient:
    responses: list[ClaudeResponse]
    calls: list[tuple[str, dict[str, str]]] = field(default_factory=list)
    _index: int = field(default=0, init=False)

    async def call(self, prompt_name: str, variables: dict[str, str]) -> ClaudeResponse:
        self.calls.append((prompt_name, variables))
        response = self.responses[self._index]
        self._index += 1
        return response


def _lead(**overrides: object) -> dict[str, object]:
    lead: dict[str, object] = {
        "id": LEAD_ID,
        "tenant_id": TENANT_ID,
        "business_name": "Aqua Flow Plumbing",
        "city": "Brisbane",
        "state": "QLD",
        "phone": "+61400000001",
        "email": "hello@aquaflow.example",
        "industry": "Plumbing",
        "vertical": "tradies",
        "keywords": "hot water, blocked drains",
    }
    lead.update(overrides)
    return lead


def _payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "job_type": JobType.GENERATE_PREVIEW.value,
        "tenant_id": str(TENANT_ID),
        "lead_id": str(LEAD_ID),
        "campaign_id": "campaign-123",
        "channel": "email",
        "send_after": "2026-05-25T09:30:00+10:00",
    }
    payload.update(overrides)
    return payload


def _personalisation(**overrides: object) -> dict[str, object]:
    data: dict[str, object] = {
        "about_blurb": (
            "Aqua Flow Plumbing helps Brisbane homes with fast, tidy trade work. "
            "The team keeps every job straightforward from first call to final clean-up."
        ),
        "founder_name": "Sarah Nguyen",
        "year_founded": 2008,
        "services": [
            {"title": "Blocked Drains", "description": "Fast drain clearing for homes."},
            {"title": "Hot Water Repairs", "description": "Reliable help for failed systems."},
            {"title": "Leak Detection", "description": "Accurate checks before damage spreads."},
            {"title": "Tap Repairs", "description": "Clean fixes for everyday plumbing issues."},
            {
                "title": "Bathroom Plumbing",
                "description": "Careful rough-ins and fixture installs.",
            },
            {
                "title": "Emergency Callouts",
                "description": "Responsive support when plumbing fails.",
            },
        ],
    }
    data.update(overrides)
    return data


def _claude_response(data: dict[str, object] | None = None) -> ClaudeResponse:
    return ClaudeResponse(
        text=json.dumps(data or _personalisation()),
        cost_usd=HAIKU_COST,
        model=HAIKU_MODEL,
    )


def _bad_response() -> ClaudeResponse:
    return ClaudeResponse(text="not json", cost_usd=HAIKU_COST, model=HAIKU_MODEL)


def _write_templates(template_dir: Path) -> None:
    template_dir.mkdir()
    template = """
    <html>
      <body>
        {{BUSINESS_NAME}} {{CITY}} {{STATE}} {{PHONE}} {{EMAIL}}
        {{ABOUT_BLURB}} {{YEAR_FOUNDED}} {{FOUNDER_NAME}}
        {{SERVICE_1_TITLE}} {{SERVICE_1_DESC}}
        {{SERVICE_2_TITLE}} {{SERVICE_2_DESC}}
        {{SERVICE_3_TITLE}} {{SERVICE_3_DESC}}
        {{SERVICE_4_TITLE}} {{SERVICE_4_DESC}}
        {{SERVICE_5_TITLE}} {{SERVICE_5_DESC}}
        {{SERVICE_6_TITLE}} {{SERVICE_6_DESC}}
      </body>
    </html>
    """
    for key in TEMPLATE_KEYS:
        (template_dir / f"{key}.html").write_text(template)


@pytest.mark.parametrize(
    ("lead", "expected"),
    [
        (_lead(industry="Plumbing"), "plumbing"),
        (_lead(industry="Electrical Contractors"), "electrical"),
        (_lead(industry="Air Conditioning"), "hvac"),
        (_lead(industry="Concrete Driveways"), "concreting"),
        (_lead(industry="Landscaping"), "landscaping"),
        (_lead(industry="Builder", keywords="renovations"), "general"),
    ],
)
def test_select_template_key_maps_trade_keywords(lead: dict[str, object], expected: str) -> None:
    module = _generate_preview_module()

    assert module.select_template_key(lead) == expected


def test_parse_personalisation_json_rejects_invalid_json() -> None:
    module = _generate_preview_module()

    with pytest.raises(module.DeadLetterError, match="invalid preview personalisation"):
        module.parse_personalisation_json("not json")


def test_parse_personalisation_json_requires_exactly_six_services() -> None:
    module = _generate_preview_module()
    invalid = _personalisation(services=[{"title": "Blocked Drains", "description": "Fast help."}])

    with pytest.raises(module.DeadLetterError, match="exactly 6"):
        module.parse_personalisation_json(json.dumps(invalid))


def test_render_preview_html_escapes_lead_and_claude_values() -> None:
    module = _generate_preview_module()
    malicious = _personalisation(
        about_blurb='Safe text <script>alert("x")</script>',
        founder_name="Sam <img src=x onerror=alert(1)>",
        services=[
            {
                "title": "Pipe <b>Repairs</b>",
                "description": "Fixes 'quoted' leaks <script>alert(1)</script>.",
            },
            *_personalisation()["services"][1:],
        ],
    )

    html = module.render_preview_html(
        """
        <title>{{BUSINESS_NAME}}</title>
        <a href="mailto:{{EMAIL}}">{{EMAIL}}</a>
        <script>const name = '{{BUSINESS_NAME}}';</script>
        <p>{{ABOUT_BLURB}}</p>
        <p>{{FOUNDER_NAME}}</p>
        <h3>{{SERVICE_1_TITLE}}</h3>
        <p>{{SERVICE_1_DESC}}</p>
        """,
        lead=_lead(
            business_name="Bad Biz </script><script>alert(1)</script>",
            email='bad" onclick="alert(1)@example.com',
        ),
        personalisation=malicious,
    )

    assert "<script>alert" not in html
    assert "</script><script>" not in html
    assert '" onclick="' not in html
    assert "&lt;script&gt;alert" in html
    assert "Bad Biz &lt;/script&gt;&lt;script&gt;alert" in html
    assert "bad&quot; onclick=&quot;alert(1)@example.com" in html
    assert "Pipe &lt;b&gt;Repairs&lt;/b&gt;" in html
    assert "&#x27;quoted&#x27;" in html


@pytest.mark.parametrize(
    ("industry", "expected_template"),
    [
        ("Plumbing", "plumbing"),
        ("Electrical", "electrical"),
        ("Air Conditioning", "hvac"),
        ("Concrete", "concreting"),
        ("Landscaping", "landscaping"),
        ("Builder", "general"),
    ],
)
def test_generate_preview_writes_html_inserts_row_and_enqueues_schedule(
    tmp_path: Path,
    industry: str,
    expected_template: str,
) -> None:
    async def scenario() -> None:
        module = _generate_preview_module()
        template_dir = tmp_path / "templates"
        output_dir = tmp_path / "previews"
        _write_templates(template_dir)
        lead_fetcher = FakeLeadFetcher(lead=_lead(industry=industry, keywords=industry))
        preview_repo = FakePreviewRepository()
        queue = FakeScheduleQueue()
        claude = FakeClaudeClient(responses=[_claude_response()])

        await module.generate_preview(
            _payload(),
            lead_fetcher=lead_fetcher,
            preview_repo=preview_repo,
            schedule_queue=queue,
            claude_client=claude,
            template_dir=template_dir,
            output_dir=output_dir,
        )

        output_file = output_dir / f"{LEAD_ID}.html"
        assert output_file.exists()
        html = output_file.read_text()
        assert "Aqua Flow Plumbing" in html
        assert "Brisbane" in html
        assert "+61400000001" in html
        assert "{{BUSINESS_NAME}}" not in html
        assert lead_fetcher.calls == [(TENANT_ID, LEAD_ID)]
        assert claude.calls[0] == (
            "preview-personalise-v1",
            {
                "business_name": "Aqua Flow Plumbing",
                "city": "Brisbane",
                "state": "QLD",
                "industry": industry,
                "keywords": industry,
            },
        )
        assert preview_repo.inserted[0]["tenant_id"] == TENANT_ID
        assert preview_repo.inserted[0]["lead_id"] == LEAD_ID
        assert preview_repo.inserted[0]["template_used"] == expected_template
        assert preview_repo.inserted[0]["preview_url"] == f"https://preview.presciaiq.com/{LEAD_ID}"
        assert preview_repo.inserted[0]["prompt_version"] == "preview-personalise-v1"
        assert preview_repo.inserted[0]["cost_usd"] == HAIKU_COST
        assert queue.jobs == [
            {
                "job_type": JobType.SCHEDULE_OUTREACH.value,
                "tenant_id": str(TENANT_ID),
                "lead_id": str(LEAD_ID),
                "campaign_id": "campaign-123",
                "channel": "email",
                "send_after": "2026-05-25T09:30:00+10:00",
                "preview_url": f"https://preview.presciaiq.com/{LEAD_ID}",
            }
        ]

    asyncio.run(scenario())


def test_generate_preview_retries_bad_personalisation_once(tmp_path: Path) -> None:
    async def scenario() -> None:
        module = _generate_preview_module()
        template_dir = tmp_path / "templates"
        output_dir = tmp_path / "previews"
        _write_templates(template_dir)
        claude = FakeClaudeClient(responses=[_bad_response(), _claude_response()])
        queue = FakeScheduleQueue()

        await module.generate_preview(
            _payload(),
            lead_fetcher=FakeLeadFetcher(lead=_lead()),
            preview_repo=FakePreviewRepository(),
            schedule_queue=queue,
            claude_client=claude,
            template_dir=template_dir,
            output_dir=output_dir,
        )

        assert len(claude.calls) == 2
        assert len(queue.jobs) == 1

    asyncio.run(scenario())


def test_generate_preview_dead_letters_after_two_bad_personalisation_responses(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        module = _generate_preview_module()
        template_dir = tmp_path / "templates"
        output_dir = tmp_path / "previews"
        _write_templates(template_dir)
        preview_repo = FakePreviewRepository()
        queue = FakeScheduleQueue()

        with pytest.raises(module.DeadLetterError, match="invalid preview personalisation"):
            await module.generate_preview(
                _payload(),
                lead_fetcher=FakeLeadFetcher(lead=_lead()),
                preview_repo=preview_repo,
                schedule_queue=queue,
                claude_client=FakeClaudeClient(responses=[_bad_response(), _bad_response()]),
                template_dir=template_dir,
                output_dir=output_dir,
            )

        assert preview_repo.inserted == []
        assert queue.jobs == []
        assert not (output_dir / f"{LEAD_ID}.html").exists()

    asyncio.run(scenario())


def test_generate_preview_disk_write_failure_does_not_insert_or_enqueue(tmp_path: Path) -> None:
    async def scenario() -> None:
        module = _generate_preview_module()
        template_dir = tmp_path / "templates"
        output_dir = tmp_path / "not-a-directory"
        output_dir.write_text("blocking file")
        _write_templates(template_dir)
        preview_repo = FakePreviewRepository()
        queue = FakeScheduleQueue()

        with pytest.raises(OSError):
            await module.generate_preview(
                _payload(),
                lead_fetcher=FakeLeadFetcher(lead=_lead()),
                preview_repo=preview_repo,
                schedule_queue=queue,
                claude_client=FakeClaudeClient(responses=[_claude_response()]),
                template_dir=template_dir,
                output_dir=output_dir,
            )

        assert preview_repo.inserted == []
        assert queue.jobs == []

    asyncio.run(scenario())


def test_generate_preview_db_insert_failure_does_not_enqueue(tmp_path: Path) -> None:
    async def scenario() -> None:
        module = _generate_preview_module()
        template_dir = tmp_path / "templates"
        output_dir = tmp_path / "previews"
        _write_templates(template_dir)
        queue = FakeScheduleQueue()

        with pytest.raises(RuntimeError, match="database unavailable"):
            await module.generate_preview(
                _payload(),
                lead_fetcher=FakeLeadFetcher(lead=_lead()),
                preview_repo=FakePreviewRepository(fail_insert=True),
                schedule_queue=queue,
                claude_client=FakeClaudeClient(responses=[_claude_response()]),
                template_dir=template_dir,
                output_dir=output_dir,
            )

        assert (output_dir / f"{LEAD_ID}.html").exists()
        assert queue.jobs == []

    asyncio.run(scenario())
