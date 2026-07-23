from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv


def load_pipeline_env() -> bool:
    dotenv_path = os.getenv("DOTENV_PATH")
    if dotenv_path:
        return load_dotenv(dotenv_path=dotenv_path, override=False)

    repo_dotenv = _find_worktree_root(Path.cwd()) / ".env"
    if repo_dotenv.is_file():
        return load_dotenv(dotenv_path=repo_dotenv, override=False)

    return False


def _find_worktree_root(start: Path) -> Path:
    current = start.resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate
    return current
