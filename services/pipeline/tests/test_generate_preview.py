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
PREVIEW_SLUG = "preview-token-1234567890abcdef"
HAIKU_MODEL = "claude-haiku-4-5-20251001"
HAIKU_COST = Decimal("0.000100")
TEMPLATE_KEYS = [
    "plumbing",
    "electrical",
    "hvac",
    "concreting",
    "landscaping",
    "general",
    "business",
]


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
    existing_preview: dict[str, object] | None = None
    get_calls: list[tuple[UUID, UUID]] = field(default_factory=list)
    fail_insert: bool = False

    async def get_website_preview(
        self, *, tenant_id: UUID, lead_id: UUID
    ) -> dict[str, object] | None:
        self.get_calls.append((tenant_id, lead_id))
        return self.existing_preview

    async def insert_website_preview(self, preview: dict[str, object]) -> UUID:
        if self.fail_insert:
            raise RuntimeError("database unavailable")
        self.inserted.append(preview)
        return UUID("40000000-0000-0000-0000-000000000004")


@dataclass
class FakeScheduleQueue:
    jobs: list[dict[str, object]] = field(default_factory=list)
    fail_enqueue: bool = False

    async def enqueue(self, payload: dict[str, object]) -> None:
        if self.fail_enqueue:
            raise RuntimeError("queue unavailable")
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


def _preview_url() -> str:
    return f"https://preview.presciaiq.com/p/{PREVIEW_SLUG}/"


def _legacy_preview_url() -> str:
    return f"https://preview.presciaiq.com/{TENANT_ID}/{LEAD_ID}/"


def _preview_output_file(output_dir: Path) -> Path:
    return output_dir / "p" / PREVIEW_SLUG / "index.html"


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


def test_parse_personalisation_json_accepts_fenced_json() -> None:
    module = _generate_preview_module()
    data = _personalisation()

    parsed = module.parse_personalisation_json(f"```json\n{json.dumps(data)}\n```")

    assert parsed == data


def test_parse_personalisation_json_requires_exactly_six_services() -> None:
    module = _generate_preview_module()
    invalid = _personalisation(services=[{"title": "Blocked Drains", "description": "Fast help."}])

    with pytest.raises(module.DeadLetterError, match="exactly 6"):
        module.parse_personalisation_json(json.dumps(invalid))


def test_parse_personalisation_json_rejects_em_dash() -> None:
    module = _generate_preview_module()
    invalid = _personalisation(about_blurb="Great tradies—trusted locally.")

    with pytest.raises(module.DeadLetterError, match="invalid preview personalisation dash"):
        module.parse_personalisation_json(json.dumps(invalid))


def test_parse_personalisation_json_rejects_en_dash() -> None:
    module = _generate_preview_module()
    invalid = _personalisation(about_blurb="Serving Brisbane – fast and reliable.")

    with pytest.raises(module.DeadLetterError, match="invalid preview personalisation dash"):
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
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        module = _generate_preview_module()
        monkeypatch.setattr(module, "_new_preview_slug", lambda: PREVIEW_SLUG)
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

        output_file = _preview_output_file(output_dir)
        assert output_file.exists()
        assert not (output_dir / str(TENANT_ID) / str(LEAD_ID) / "index.html").exists()
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
        assert preview_repo.inserted[0]["preview_slug"] == PREVIEW_SLUG
        assert preview_repo.inserted[0]["preview_url"] == _preview_url()
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
                "preview_url": _preview_url(),
            }
        ]

    asyncio.run(scenario())


def test_generate_preview_existing_preview_reenqueues_without_regeneration(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        module = _generate_preview_module()
        template_dir = tmp_path / "templates"
        output_dir = tmp_path / "previews"
        _write_templates(template_dir)
        lead_fetcher = FakeLeadFetcher(lead=_lead())
        preview_repo = FakePreviewRepository(
            existing_preview={
                "tenant_id": TENANT_ID,
                "lead_id": LEAD_ID,
                "preview_slug": PREVIEW_SLUG,
                "preview_url": _preview_url(),
            }
        )
        output_file = _preview_output_file(output_dir)
        output_file.parent.mkdir(parents=True)
        output_file.write_text("existing preview")
        queue = FakeScheduleQueue()
        claude = FakeClaudeClient(responses=[])

        await module.generate_preview(
            _payload(),
            lead_fetcher=lead_fetcher,
            preview_repo=preview_repo,
            schedule_queue=queue,
            claude_client=claude,
            template_dir=template_dir,
            output_dir=output_dir,
        )

        assert preview_repo.get_calls == [(TENANT_ID, LEAD_ID)]
        assert lead_fetcher.calls == []
        assert claude.calls == []
        assert preview_repo.inserted == []
        assert output_file.read_text() == "existing preview"
        assert queue.jobs == [
            {
                "job_type": JobType.SCHEDULE_OUTREACH.value,
                "tenant_id": str(TENANT_ID),
                "lead_id": str(LEAD_ID),
                "campaign_id": "campaign-123",
                "channel": "email",
                "send_after": "2026-05-25T09:30:00+10:00",
                "preview_url": _preview_url(),
            }
        ]

    asyncio.run(scenario())


def test_generate_preview_existing_preview_retry_after_enqueue_failure_skips_generation(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        module = _generate_preview_module()
        template_dir = tmp_path / "templates"
        output_dir = tmp_path / "previews"
        _write_templates(template_dir)
        lead_fetcher = FakeLeadFetcher(lead=_lead())
        preview_repo = FakePreviewRepository(
            existing_preview={
                "tenant_id": TENANT_ID,
                "lead_id": LEAD_ID,
                "preview_slug": PREVIEW_SLUG,
                "preview_url": _preview_url(),
            }
        )
        output_file = _preview_output_file(output_dir)
        output_file.parent.mkdir(parents=True)
        output_file.write_text("existing preview")
        failing_queue = FakeScheduleQueue(fail_enqueue=True)
        claude = FakeClaudeClient(responses=[])

        with pytest.raises(RuntimeError, match="queue unavailable"):
            await module.generate_preview(
                _payload(),
                lead_fetcher=lead_fetcher,
                preview_repo=preview_repo,
                schedule_queue=failing_queue,
                claude_client=claude,
                template_dir=template_dir,
                output_dir=output_dir,
            )

        retry_queue = FakeScheduleQueue()
        await module.generate_preview(
            _payload(),
            lead_fetcher=lead_fetcher,
            preview_repo=preview_repo,
            schedule_queue=retry_queue,
            claude_client=claude,
            template_dir=template_dir,
            output_dir=output_dir,
        )

        assert preview_repo.get_calls == [(TENANT_ID, LEAD_ID), (TENANT_ID, LEAD_ID)]
        assert lead_fetcher.calls == []
        assert claude.calls == []
        assert preview_repo.inserted == []
        assert failing_queue.jobs == []
        assert retry_queue.jobs[0]["preview_url"] == _preview_url()
        assert output_file.read_text() == "existing preview"

    asyncio.run(scenario())


def test_generate_preview_regenerates_existing_preview_with_legacy_url(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        module = _generate_preview_module()
        monkeypatch.setattr(module, "_new_preview_slug", lambda: PREVIEW_SLUG)
        template_dir = tmp_path / "templates"
        output_dir = tmp_path / "previews"
        _write_templates(template_dir)
        lead_fetcher = FakeLeadFetcher(lead=_lead())
        preview_repo = FakePreviewRepository(
            existing_preview={
                "tenant_id": TENANT_ID,
                "lead_id": LEAD_ID,
                "preview_url": _legacy_preview_url(),
            }
        )
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

        assert preview_repo.get_calls == [(TENANT_ID, LEAD_ID)]
        assert lead_fetcher.calls == [(TENANT_ID, LEAD_ID)]
        assert len(claude.calls) == 1
        assert preview_repo.inserted[0]["preview_url"] == _preview_url()
        assert preview_repo.inserted[0]["preview_slug"] == PREVIEW_SLUG
        assert queue.jobs[0]["preview_url"] == _preview_url()
        assert _preview_output_file(output_dir).exists()
        assert not (output_dir / str(TENANT_ID) / str(LEAD_ID) / "index.html").exists()

    asyncio.run(scenario())


def test_generate_preview_retries_bad_personalisation_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        module = _generate_preview_module()
        monkeypatch.setattr(module, "_new_preview_slug", lambda: PREVIEW_SLUG)
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
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        module = _generate_preview_module()
        monkeypatch.setattr(module, "_new_preview_slug", lambda: PREVIEW_SLUG)
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
        assert not (output_dir / str(TENANT_ID) / str(LEAD_ID) / "index.html").exists()

    asyncio.run(scenario())


def test_generate_preview_disk_write_failure_does_not_insert_or_enqueue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        module = _generate_preview_module()
        monkeypatch.setattr(module, "_new_preview_slug", lambda: PREVIEW_SLUG)
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


def test_generate_preview_db_insert_failure_does_not_enqueue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        module = _generate_preview_module()
        monkeypatch.setattr(module, "_new_preview_slug", lambda: PREVIEW_SLUG)
        template_dir = tmp_path / "templates"
        output_dir = tmp_path / "previews"
        _write_templates(template_dir)
        queue = FakeScheduleQueue()

        final_output_file = _preview_output_file(output_dir)

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

        assert not final_output_file.exists()
        assert queue.jobs == []

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# Template routing for non-trade businesses
#
# general.html is named "general" but is a trades site start to finish: its
# <title> says "Local Trades & Services" and its body promises "Fully
# Licensed", "Licensed & Insured" and "Free Quotes". Falling back to it for
# every non-trade lead meant a cafe was emailed a licensed-tradesman website
# as its personalised demo.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "lead",
    [
        _lead(industry="Cafe", keywords="coffee"),
        _lead(industry="Finance & Accounting", keywords="accountant"),
        _lead(industry="Legal Services", keywords="solicitor"),
        _lead(industry="School", keywords=""),
        _lead(industry="Retail", keywords="gift shop"),
        _lead(industry="", keywords=""),
    ],
)
def test_non_trade_leads_fall_back_to_the_neutral_business_template(
    lead: dict[str, object],
) -> None:
    module = _generate_preview_module()

    assert module.select_template_key(lead) == "business"


@pytest.mark.parametrize(
    ("lead", "expected"),
    [
        (_lead(industry="Plumbing"), "plumbing"),
        (_lead(industry="Electrical Contractors"), "electrical"),
        (_lead(industry="Air Conditioning"), "hvac"),
        (_lead(industry="Concrete Driveways"), "concreting"),
        (_lead(industry="Landscaping"), "landscaping"),
        (_lead(industry="Builder", keywords="renovations"), "general"),
        (_lead(industry="Construction & Trades", keywords=""), "general"),
        (_lead(industry="Carpentry", keywords="carpenter"), "general"),
        (_lead(industry="Roofing", keywords="roof restoration"), "general"),
    ],
)
def test_trade_leads_still_reach_a_trade_template(
    lead: dict[str, object], expected: str
) -> None:
    """Regression guard. Making `business` the fallback must not take the
    trades templates away from actual trades."""
    module = _generate_preview_module()

    assert module.select_template_key(lead) == expected


def test_default_tradies_vertical_does_not_force_the_trades_template() -> None:
    """leads.vertical defaults to 'tradies' for every row in the database.

    It is a per-import campaign label, not a description of the business.
    Scanning it for the generic trades keywords would route every lead in the
    system to general.html and make the neutral fallback unreachable, which
    is exactly the bug this whole change exists to fix.
    """
    module = _generate_preview_module()
    lead = _lead(industry="Cafe", keywords="coffee")
    lead["vertical"] = "tradies"

    assert module.select_template_key(lead) == "business"


def test_a_specific_trade_beats_the_generic_trades_template() -> None:
    """A plumber whose Industry cell reads "Construction" is still a plumber.

    The generic trades keyword set is checked only after the five specific
    trades, in every field, so adding "construction" to it cannot steal a
    lead that a specific template matches.
    """
    module = _generate_preview_module()

    assert module.select_template_key(_lead(industry="Construction", keywords="plumber")) == (
        "plumbing"
    )


# ---------------------------------------------------------------------------
# Conditional blocks: an empty field must not leave an empty row on the page
# ---------------------------------------------------------------------------


def test_phone_block_is_removed_when_the_lead_has_no_phone() -> None:
    """54.2% of the Australian list has no phone number. Rendering the block
    anyway produces a contact list with an empty clickable "tel:" row on the
    page the prospect is being asked to judge."""
    module = _generate_preview_module()

    html = module.render_preview_html(
        '<ul>{{#IF_PHONE}}<li><a href="tel:{{PHONE}}">{{PHONE}}</a></li>{{/IF_PHONE}}'
        '<li>{{EMAIL}}</li></ul>',
        lead=_lead(phone=""),
        personalisation=_personalisation(),
    )

    assert "tel:" not in html
    assert "<li>" in html
    assert "{{" not in html


def test_phone_block_is_kept_when_the_lead_has_a_phone() -> None:
    module = _generate_preview_module()

    html = module.render_preview_html(
        '<ul>{{#IF_PHONE}}<li><a href="tel:{{PHONE}}">{{PHONE}}</a></li>{{/IF_PHONE}}</ul>',
        lead=_lead(phone="+61400000001"),
        personalisation=_personalisation(),
    )

    assert 'href="tel:+61400000001"' in html
    assert ">+61400000001<" in html
    assert "{{" not in html


def test_whitespace_only_phone_removes_the_block() -> None:
    module = _generate_preview_module()

    html = module.render_preview_html(
        "{{#IF_PHONE}}<li>{{PHONE}}</li>{{/IF_PHONE}}",
        lead=_lead(phone="   "),
        personalisation=_personalisation(),
    )

    assert html.strip() == ""


def test_unknown_conditional_token_dead_letters_instead_of_rendering() -> None:
    """A typo in a conditional name must not silently keep or drop a block.

    Silently keeping it would ship a page asserting something about a field
    nobody supplied; silently dropping it would remove a section nobody
    noticed was gone.
    """
    module = _generate_preview_module()

    with pytest.raises(module.DeadLetterError, match="unknown conditional"):
        module.render_preview_html(
            "{{#IF_FAX}}<li>{{PHONE}}</li>{{/IF_FAX}}",
            lead=_lead(),
            personalisation=_personalisation(),
        )


def test_unclosed_conditional_block_dead_letters() -> None:
    module = _generate_preview_module()

    with pytest.raises(module.DeadLetterError, match="unbalanced conditional"):
        module.render_preview_html(
            "{{#IF_PHONE}}<li>{{PHONE}}</li>",
            lead=_lead(phone="+61400000001"),
            personalisation=_personalisation(),
        )


# ---------------------------------------------------------------------------
# {{LOCATION}}: one token for the city/state pair, so the comma between them
# belongs to the value rather than to the template
# ---------------------------------------------------------------------------


def test_location_joins_city_and_state() -> None:
    module = _generate_preview_module()

    html = module.render_preview_html(
        "{{LOCATION}}",
        lead=_lead(city="Brisbane", state="QLD"),
        personalisation=_personalisation(),
    )

    assert html == "Brisbane, QLD"


def test_location_is_the_city_alone_when_the_state_is_blank() -> None:
    """A template that wrote `{{CITY}}, {{STATE}}` produced "Brisbane, " here.

    The comma is punctuation between two values, so it can only be decided
    where both values are known: in the renderer, not in seven templates.
    """
    module = _generate_preview_module()

    html = module.render_preview_html(
        "{{LOCATION}}",
        lead=_lead(city="Brisbane", state=""),
        personalisation=_personalisation(),
    )

    assert html == "Brisbane"


def test_location_is_the_state_alone_when_the_city_is_blank() -> None:
    module = _generate_preview_module()

    html = module.render_preview_html(
        "{{LOCATION}}",
        lead=_lead(city="", state="QLD"),
        personalisation=_personalisation(),
    )

    assert html == "QLD"


def test_location_is_empty_when_neither_city_nor_state_is_known() -> None:
    module = _generate_preview_module()

    html = module.render_preview_html(
        "{{LOCATION}}",
        lead=_lead(city="", state=""),
        personalisation=_personalisation(),
    )

    assert html == ""


def test_location_ignores_a_whitespace_only_state() -> None:
    """Whitespace is not a value. `_missing_required_fields` uses the same
    rule, so a row that imports on a blank state must render on one too."""
    module = _generate_preview_module()

    html = module.render_preview_html(
        "{{LOCATION}}",
        lead=_lead(city="Brisbane", state="   "),
        personalisation=_personalisation(),
    )

    assert html == "Brisbane"


def test_location_is_html_escaped() -> None:
    module = _generate_preview_module()

    html = module.render_preview_html(
        "{{LOCATION}}",
        lead=_lead(city="Sut<on", state="NSW"),
        personalisation=_personalisation(),
    )

    assert html == "Sut&lt;on, NSW"


def test_location_block_is_removed_when_neither_city_nor_state_is_known() -> None:
    module = _generate_preview_module()

    html = module.render_preview_html(
        '<ul>{{#IF_LOCATION}}<li>{{LOCATION}}</li>{{/IF_LOCATION}}<li>{{EMAIL}}</li></ul>',
        lead=_lead(city="", state=""),
        personalisation=_personalisation(),
    )

    assert "<li>hello@aquaflow.example</li>" in html
    assert html.count("<li>") == 1
    assert "{{" not in html


# ---------------------------------------------------------------------------
# Inverted conditional blocks: copy that needs a location-free wording
# ---------------------------------------------------------------------------


def test_inverted_block_is_kept_when_the_field_is_blank() -> None:
    """Some copy cannot simply drop its city. "Looking After <City>" needs a
    noun in the accent slot, so the template has to be able to say what to
    write when there is no city, not only what to write when there is."""
    module = _generate_preview_module()

    html = module.render_preview_html(
        "{{#IF_CITY}}{{CITY}}{{/IF_CITY}}{{^IF_CITY}}Our Locals{{/IF_CITY}}",
        lead=_lead(city=""),
        personalisation=_personalisation(),
    )

    assert html == "Our Locals"


def test_inverted_block_is_dropped_when_the_field_has_a_value() -> None:
    module = _generate_preview_module()

    html = module.render_preview_html(
        "{{#IF_CITY}}{{CITY}}{{/IF_CITY}}{{^IF_CITY}}Our Locals{{/IF_CITY}}",
        lead=_lead(city="Brisbane"),
        personalisation=_personalisation(),
    )

    assert html == "Brisbane"


def test_unknown_inverted_conditional_token_dead_letters() -> None:
    """The inverted form gets the same guard as the positive one. Without it
    a typo would silently publish the fallback copy on every page."""
    module = _generate_preview_module()

    with pytest.raises(module.DeadLetterError, match="unknown conditional"):
        module.render_preview_html(
            "{{^IF_FAX}}no fax{{/IF_FAX}}",
            lead=_lead(),
            personalisation=_personalisation(),
        )


def test_unclosed_inverted_conditional_block_dead_letters() -> None:
    module = _generate_preview_module()

    with pytest.raises(module.DeadLetterError, match="unbalanced conditional"):
        module.render_preview_html(
            "{{^IF_CITY}}no city",
            lead=_lead(city=""),
            personalisation=_personalisation(),
        )
