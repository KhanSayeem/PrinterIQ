from __future__ import annotations

import os

from env import load_pipeline_env


def test_load_pipeline_env_reads_dotenv_path(tmp_path, monkeypatch) -> None:
    dotenv_path = tmp_path / ".env.local"
    dotenv_path.write_text("REDIS_URL=redis://dotenv.example:6379\n", encoding="utf-8")

    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.setenv("DOTENV_PATH", str(dotenv_path))

    assert load_pipeline_env() is True
    assert os.environ["REDIS_URL"] == "redis://dotenv.example:6379"
