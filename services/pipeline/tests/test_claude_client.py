from __future__ import annotations

from dataclasses import dataclass

from clients.claude_client import _extract_text_content


@dataclass(frozen=True)
class _TextBlock:
    text: str


@dataclass(frozen=True)
class _ToolBlock:
    name: str


def test_extract_text_content_returns_first_text_block() -> None:
    assert _extract_text_content([_ToolBlock(name="lookup"), _TextBlock(text="hello")]) == "hello"


def test_extract_text_content_returns_empty_string_without_text_block() -> None:
    assert _extract_text_content([_ToolBlock(name="lookup")]) == ""
