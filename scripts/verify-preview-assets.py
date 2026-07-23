from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify preview image assets are served correctly.")
    parser.add_argument("--manifest", default="image-download-manifest.json")
    parser.add_argument("--base-url", required=True)
    parser.add_argument(
        "--resolve",
        help="Optional curl --resolve value, for example preview.presciaiq.com:80:170.64.143.200",
    )
    args = parser.parse_args()

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    failures: list[str] = []

    for asset_path in manifest:
        url = args.base_url.rstrip("/") + asset_path
        command = [
            "curl",
            "-fsSL",
            "--max-time",
            "15",
            "-o",
            os.devnull,
            "-w",
            "%{http_code}\t%{content_type}\t%{size_download}",
        ]
        if args.resolve:
            command.extend(["--resolve", args.resolve])
        command.append(url)

        result = subprocess.run(command, capture_output=True, text=True, check=False)
        status = result.stdout.strip()
        print(f"{asset_path}\t{status}")

        parts = status.split("\t")
        if len(parts) != 3 or parts[0] != "200" or "image/jpeg" not in parts[1] or parts[2] == "0":
            failures.append(f"{asset_path}: {status or result.stderr.strip()}")

    print(f"checked={len(manifest)} bad={len(failures)}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
