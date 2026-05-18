from __future__ import annotations

import os

from redis.asyncio import Redis


class MissingRedisUrlError(RuntimeError):
    """Raised when Redis configuration is absent."""


def get_redis_client(redis_url: str | None = None) -> Redis:
    url = redis_url or os.getenv("REDIS_URL")
    if not url:
        raise MissingRedisUrlError("Missing env var: REDIS_URL")
    return Redis.from_url(url, decode_responses=True)
