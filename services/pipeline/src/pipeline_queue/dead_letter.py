from __future__ import annotations


def should_dead_letter(attempt_count: int, max_attempts: int) -> bool:
    if max_attempts < 1:
        raise ValueError("max_attempts must be at least 1")
    return attempt_count >= max_attempts
