from __future__ import annotations

import argparse
import re
import subprocess
import sys

ASSET_RE = re.compile(r"['\"](/assets/previews/[^'\"]+\.jpg)['\"]")
TEMPLATES = ["concreting", "electrical", "general", "hvac", "landscaping", "plumbing"]


def fetch(url: str, resolve: str | None) -> tuple[str, str, str]:
    command = ["curl", "-fsSL", "--max-time", "15", "-w", "\n%{http_code}\t%{content_type}"]
    if resolve:
        command.extend(["--resolve", resolve])
    command.append(url)
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False)
    if result.returncode != 0:
        return "", "", result.stderr.strip()

    body, _, status = result.stdout.rpartition("\n")
    return body, status, ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify rendered preview sample pages.")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--resolve", help="Optional curl --resolve value.")
    args = parser.parse_args()

    failures: list[str] = []
    for template in TEMPLATES:
        path = f"/sample-{template}.html"
        body, status, error = fetch(args.base_url.rstrip("/") + path, args.resolve)
        print(f"{path}\t{status or error}")

        if error:
            failures.append(f"{path}: {error}")
            continue

        status_parts = status.split("\t")
        if len(status_parts) != 2 or status_parts[0] != "200" or "text/html" not in status_parts[1]:
            failures.append(f"{path}: unexpected response {status}")

        if "{{" in body or "}}" in body:
            failures.append(f"{path}: contains unresolved template tokens")
        if "images.unsplash.com" in body:
            failures.append(f"{path}: contains direct Unsplash references")
        if "https://" in body:
            failures.append(f"{path}: contains external HTTPS references")

        assets = ASSET_RE.findall(body)
        if len(assets) != 15:
            failures.append(f"{path}: expected 15 local image references, found {len(assets)}")

    print(f"checked={len(TEMPLATES)} bad={len(failures)}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
