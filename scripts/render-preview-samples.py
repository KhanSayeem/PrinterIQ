from __future__ import annotations

import argparse
from pathlib import Path


TOKENS = {
    "{{ABOUT_BLURB}}": (
        "Harbour City Trades is a Sydney team known for careful planning and tidy delivery. "
        "They work with homeowners and builders who want reliable communication from start to finish."
    ),
    "{{BUSINESS_NAME}}": "Harbour City Trades",
    "{{CITY}}": "Sydney",
    "{{EMAIL}}": "hello@harbourcity.example",
    "{{FOUNDER_NAME}}": "James Callahan",
    "{{PHONE}}": "+61 400 000 000",
    "{{SERVICE_1_DESC}}": "Detailed planning and clear communication before work begins.",
    "{{SERVICE_1_TITLE}}": "Project Planning",
    "{{SERVICE_2_DESC}}": "Licensed specialists for homes, shops and small commercial sites.",
    "{{SERVICE_2_TITLE}}": "Licensed Work",
    "{{SERVICE_3_DESC}}": "Clean finishes, careful handover and reliable site standards.",
    "{{SERVICE_3_TITLE}}": "Quality Finishes",
    "{{SERVICE_4_DESC}}": "Responsive callouts for urgent jobs across the local area.",
    "{{SERVICE_4_TITLE}}": "Fast Response",
    "{{SERVICE_5_DESC}}": "Practical upgrades that improve safety, comfort and presentation.",
    "{{SERVICE_5_TITLE}}": "Smart Upgrades",
    "{{SERVICE_6_DESC}}": "Ongoing care for repeat clients and property managers.",
    "{{SERVICE_6_TITLE}}": "Maintenance Care",
    "{{STATE}}": "NSW",
    "{{YEAR_FOUNDED}}": "2008",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Render sample preview template HTML files.")
    parser.add_argument(
        "--template-dir",
        default="services/pipeline/src/templates/previews",
        help="Directory containing preview template HTML files.",
    )
    parser.add_argument("--output-dir", required=True, help="Directory to write rendered samples.")
    args = parser.parse_args()

    template_dir = Path(args.template_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    for template_path in sorted(template_dir.glob("*.html")):
        html = template_path.read_text(encoding="utf-8")
        for token, value in TOKENS.items():
            html = html.replace(token, value)

        unresolved_tokens = sorted(set(part for part in html.split() if "{{" in part or "}}" in part))
        if unresolved_tokens:
            raise RuntimeError(
                f"{template_path.name} still contains unresolved token fragments: "
                f"{', '.join(unresolved_tokens[:5])}"
            )

        output_path = output_dir / f"sample-{template_path.stem}.html"
        output_path.write_text(html, encoding="utf-8")
        print(output_path)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
