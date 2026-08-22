from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from string import Template

logger = logging.getLogger(__name__)

_MODEL_MAP: dict[str, str] = {
    # qualify-v1 is superseded by qualify-v2 but stays wired: prompt_version
    # is written to every qualifications row, and rolling back should be one
    # constant rather than a file restore.
    "qualify-v1": "claude-haiku-4-5-20251001",
    "qualify-v2": "claude-haiku-4-5-20251001",
    "preview-personalise-v1": "claude-haiku-4-5-20251001",
    "opener-v1": "claude-sonnet-4-6",
    "opener-v2": "claude-sonnet-4-6",
    # Copy for a lead with no website. A separate file, not a branch inside
    # opener-v2, because opener-v2 hard-codes "spotted [business]'s site and
    # noticed" and no wording of that sentence is true for these leads.
    "opener-nosite-v1": "claude-sonnet-4-6",
}

# USD per million tokens (input / output)
_PRICING: dict[str, tuple[Decimal, Decimal]] = {
    "claude-haiku-4-5-20251001": (Decimal("0.80") / 1_000_000, Decimal("4.00") / 1_000_000),
    "claude-sonnet-4-6": (Decimal("3.00") / 1_000_000, Decimal("15.00") / 1_000_000),
}

_MAX_RETRIES = 3
_BRACE_VARIABLE_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


@dataclass(frozen=True)
class ClaudeResponse:
    text: str
    cost_usd: Decimal
    model: str


class RealClaudeClient:
    """Anthropic SDK wrapper. Use in production; inject FakeClaudeClient in tests."""

    def __init__(self, *, api_key: str, prompts_dir: Path) -> None:
        self._api_key = api_key
        self._prompts_dir = prompts_dir

    async def call(self, prompt_name: str, variables: dict[str, str]) -> ClaudeResponse:
        from anthropic import APIStatusError, AsyncAnthropic, RateLimitError

        model = _MODEL_MAP[prompt_name]
        prompt_path = self._prompts_dir / f"{prompt_name}.txt"
        raw_prompt = prompt_path.read_text(encoding="utf-8")
        prompt = _render_prompt(raw_prompt, variables)

        client = AsyncAnthropic(api_key=self._api_key)
        delay = 1.0
        for attempt in range(1, _MAX_RETRIES + 1):
            try:
                message = await client.messages.create(
                    model=model,
                    max_tokens=1024,
                    messages=[{"role": "user", "content": prompt}],
                )
                input_rate, output_rate = _PRICING[model]
                cost = (
                    Decimal(message.usage.input_tokens) * input_rate
                    + Decimal(message.usage.output_tokens) * output_rate
                )
                text = _extract_text_content(message.content)
                return ClaudeResponse(text=text, cost_usd=cost, model=model)
            except (RateLimitError, APIStatusError) as exc:
                if attempt == _MAX_RETRIES:
                    raise
                logger.warning("Claude API error (attempt %d/%d): %s", attempt, _MAX_RETRIES, exc)
                await asyncio.sleep(delay)
                delay *= 2

        raise RuntimeError("Unreachable")


def _extract_text_content(content: object) -> str:
    if not isinstance(content, list):
        return ""
    for block in content:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            return text
    return ""


def _render_prompt(raw_prompt: str, variables: dict[str, str]) -> str:
    template_rendered = Template(raw_prompt).safe_substitute(variables)

    def replace_brace_variable(match: re.Match[str]) -> str:
        variable_name = match.group(1)
        return variables.get(variable_name, match.group(0))

    return _BRACE_VARIABLE_RE.sub(replace_brace_variable, template_rendered)
