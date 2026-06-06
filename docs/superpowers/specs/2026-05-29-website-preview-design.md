# Website Preview Feature — Design Spec

**Date:** 2026-05-29
**Last updated:** 2026-06-02
**Status:** Approved for implementation

---

## Overview

When a lead is qualified, PrinterIQ generates a personalised, trade-matched HTML website preview and hosts it at a unique URL. That URL is injected into the outreach email via Instantly's custom variables. The lead clicks a real browser link and sees a polished website mocked up for their specific business. The generated preview is also visible in the dashboard lead detail page.

Two lead scenarios are handled:

- **Lead has a website:** preview demonstrates what a rebuilt, weakness-free version could look like.
- **Lead has no website:** preview shows a clean landing page as if they already had a professional site.

The bar for template quality is a site that looks like a genuine $10,000–$15,000 build. Not a mockup. Not a wireframe. Leads should feel compelled on first view. This is the competitive moat.

---

## Updated Pipeline

```
ingest -> enrich -> qualify -> generate_preview -> schedule_outreach
```

The `qualify` worker no longer enqueues `SCHEDULE_OUTREACH` directly. Instead it enqueues `GENERATE_PREVIEW`, forwarding the full `schedule_outreach` payload (campaign_id, channel, send_after) so nothing is lost downstream.

`generate_preview` enqueues `SCHEDULE_OUTREACH` (with `preview_url` added to the payload) only after a confirmed DB insert into `website_previews`.

`schedule_outreach` passes `preview_url` as a custom variable to Instantly alongside the existing `opener`, `weakness`, `followup_1`, `followup_2`, `lead_id` variables.

---

## New Worker: `generate_preview`

**File:** `services/pipeline/src/workers/generate_preview.py`

**Job type:** `GENERATE_PREVIEW`

**Steps (in order):**

1. Fetch lead record (tenant-scoped) — need: `business_name`, `city`, `state`, `phone`, `email`, `industry`, `vertical`, `keywords`
2. Determine template via keyword trade-type mapping (see Template System section)
3. Call Claude Haiku with `preview-personalise-v1` prompt to generate: `about_blurb`, `founder_name`, `year_founded`, and `services` array (6 items with title + description each)
4. Render final HTML by injecting Haiku output + lead data into the selected template file via simple string replace — no template engine
5. Write rendered HTML to `/var/www/previews/{lead_id}.html` on VPS
6. Insert row into `website_previews` table
7. Enqueue `SCHEDULE_OUTREACH` with forwarded payload + `preview_url`

**Retry / failure handling:**

- BullMQ max attempts: 5
- Exponential backoff: 60s, 120s, 240s, 480s, 960s
- On all retries exhausted: dead-letter queue (existing handler); surfaces in dashboard
- `SCHEDULE_OUTREACH` is only enqueued after confirmed DB insert — if the insert fails, the job retries from step 6

**TDD requirement:** `generate_preview` is on the TDD-mandatory path. Tests must cover:

- Successful end-to-end generation for each of the 6 template keys
- Trade-type keyword mapping (all 5 specific + fallback)
- Haiku JSON parse failure triggers retry
- Haiku services array outside 6 items triggers retry
- Disk write failure triggers retry
- DB insert failure does not enqueue schedule_outreach
- All DB reads and writes scoped by tenant_id

---

## Database Schema

### New table: `website_previews`

```sql
CREATE TABLE website_previews (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  -- Phase 1: one preview per lead.
  -- If regeneration is added in a future phase, replace with
  -- soft-delete versioning before removing this constraint.
  lead_id              uuid NOT NULL UNIQUE,
  template_used        text NOT NULL,
  preview_url          text NOT NULL,
  personalisation_data jsonb NOT NULL,
  prompt_version       text NOT NULL,
  cost_usd             numeric(10,6) NOT NULL,
  generated_at         timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_website_previews_lead
    FOREIGN KEY (lead_id) REFERENCES leads(id),
  CONSTRAINT fk_website_previews_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);

CREATE INDEX idx_website_previews_tenant_lead
  ON website_previews (tenant_id, lead_id);
```

**No `generated_html` column.** The rendered HTML lives on VPS disk at `/var/www/previews/{lead_id}.html`. Storing a duplicate in Postgres is redundant and bloats the DB at scale. `personalisation_data` (Haiku output) + `template_used` + `prompt_version` is sufficient to replay or regenerate any preview. For debugging, fetch from disk directly.

### Changes to existing tables

**`qualifications`:** No change to schema. The preview is a separate concern.

### Query layer

All access to `website_previews` goes through:

- `services/pipeline/src/db/queries.py` — insert + get by lead_id (Python worker)
- `services/dashboard/src/db/queries.ts` — get by lead_id for dashboard read (TypeScript)

No raw queries outside these files.

---

## Template System

### Template inventory

| Key           | Dedicated trade types (keyword match)                                 | Accent (primary) | Accent (light)  |
| ------------- | --------------------------------------------------------------------- | ---------------- | --------------- |
| `plumbing`    | plumber, plumbing, hot water, pipes, drainage, blocked drains         | `#1b4f8a`        | `#4a82c4`       |
| `electrical`  | electrician, electrical, solar, switchboard, wiring, lighting         | `#d4820a`        | `#e8a830`       |
| `hvac`        | air conditioning, hvac, heating, cooling, refrigeration, split system | `#2c3e52`        | `#7a9ab5`       |
| `concreting`  | concreting, concrete, driveways, paths, slabs, footings               | `#3d3528`        | `#8c7d65`       |
| `landscaping` | landscaping, lawn, gardens, turf, retaining walls, mowing             | `#1a3d2b`        | `#6b9e78`       |
| `general`     | Fallback — all leads that do not match any of the above               | `#d4820a`        | `#e8a830`       |

### Trade-type matching logic

Pure deterministic keyword lookup — no Claude call. Matching runs against `industry`, `vertical`, and `keywords` fields (lowercased), evaluated in that priority order. First match wins. If no match, `general` is selected.

All keyword lists live in a single config dict in `generate_preview.py` — not scattered across the worker. Easy to extend.

### Template rendering

Each template is a single self-contained `.html` file stored at:
`services/pipeline/src/templates/previews/{key}.html`

Templates use `{{PLACEHOLDER}}` tokens (double curly, uppercase). The render step is a simple multi-key `str.replace` loop — no template engine dependency. The render function iterates over all 20 tokens in a flat dict and replaces each in a single pass.

### Token table

All 20 tokens are present in every template. The render step always injects all 20 — no conditional logic per template.

| Token | Source | Notes |
| --- | --- | --- |
| `{{BUSINESS_NAME}}` | `lead.business_name` | Nav logo, loader, hero, about, CTA band, testimonials, footer — appears ~11 times per template |
| `{{CITY}}` | `lead.city` | Hero eyebrow, marquee, about headline, project slides, sectors, quote, CTA band, footer — appears ~23 times per template |
| `{{STATE}}` | `lead.state` | Hero sub, footer |
| `{{PHONE}}` | `lead.phone` | Nav CTA, footer contact column |
| `{{EMAIL}}` | `lead.email` | CTA band `mailto:` link, footer contact column |
| `{{ABOUT_BLURB}}` | Haiku | About section left column, first paragraph |
| `{{YEAR_FOUNDED}}` | Haiku | About section second paragraph ("Founded in `{{CITY}}` in `{{YEAR_FOUNDED}}`"), footer tagline |
| `{{FOUNDER_NAME}}` | Haiku | Quote section attribution ("— `{{FOUNDER_NAME}}`, Founder") |
| `{{SERVICE_1_TITLE}}` | Haiku | Service card 1 heading + footer services list |
| `{{SERVICE_1_DESC}}` | Haiku | Service card 1 body |
| `{{SERVICE_2_TITLE}}` | Haiku | Service card 2 heading + footer services list |
| `{{SERVICE_2_DESC}}` | Haiku | Service card 2 body |
| `{{SERVICE_3_TITLE}}` | Haiku | Service card 3 heading + footer services list |
| `{{SERVICE_3_DESC}}` | Haiku | Service card 3 body |
| `{{SERVICE_4_TITLE}}` | Haiku | Service card 4 heading + footer services list |
| `{{SERVICE_4_DESC}}` | Haiku | Service card 4 body |
| `{{SERVICE_5_TITLE}}` | Haiku | Service card 5 heading + footer services list |
| `{{SERVICE_5_DESC}}` | Haiku | Service card 5 body |
| `{{SERVICE_6_TITLE}}` | Haiku | Service card 6 heading + footer services list |
| `{{SERVICE_6_DESC}}` | Haiku | Service card 6 body |

**Removed tokens vs original spec:**
- `{{TAGLINE}}` — removed. Each template has a hardcoded hero tagline (see per-template spec below). No Haiku call needed.
- `{{WEAKNESS_CALLOUT}}` — removed. Callout band has been removed from all templates. Not used in Phase 1.
- `{{PREVIEW_URL}}` — removed. Not injected into the template HTML itself; passed separately in the Instantly payload.

---

## New Prompt File

**`prompts/preview-personalise-v1.txt`**

Called once per lead from `generate_preview` worker via `claude_client.py`.

**Input variables:** `business_name`, `city`, `state`, `industry`, `keywords`

**Output schema (JSON, validated before use):**

```json
{
  "about_blurb": "string — exactly 2 sentences, casual and professional tone, references the business name and city, no em-dashes",
  "founder_name": "string — plausible Australian full name e.g. 'James Callahan' or 'Sarah Nguyen', not generic",
  "year_founded": "integer — between 1995 and 2018 inclusive",
  "services": [
    {
      "title": "string — service name, 2 to 4 words",
      "description": "string — one line, max 15 words, no em-dashes"
    }
  ]
}
```

**Validation rules (enforced in `generate_preview.py` before render):**

- `services` array must contain exactly 6 items — no more, no less
- All required keys must be present and non-empty
- `year_founded` must be an integer between 1995 and 2018
- Any validation failure is treated as a parse failure and triggers a retry

**Model:** `claude-haiku-4-5-20251001` (cheapest, fast, sufficient for short structured output)

**Estimated cost:** ~$0.001 per lead

**Note:** `top_weakness` has been removed from Haiku inputs. The weakness callout band is not present in the built templates and is out of scope for Phase 1.

---

## Haiku Output → Token Mapping

The render step maps Haiku JSON fields to template tokens as follows:

```python
token_map = {
    # From lead data
    "{{BUSINESS_NAME}}": lead.business_name,
    "{{CITY}}":          lead.city,
    "{{STATE}}":         lead.state,
    "{{PHONE}}":         lead.phone,
    "{{EMAIL}}":         lead.email,
    # From Haiku output
    "{{ABOUT_BLURB}}":   haiku.about_blurb,
    "{{YEAR_FOUNDED}}":  str(haiku.year_founded),
    "{{FOUNDER_NAME}}":  haiku.founder_name,
    "{{SERVICE_1_TITLE}}": haiku.services[0]["title"],
    "{{SERVICE_1_DESC}}":  haiku.services[0]["description"],
    "{{SERVICE_2_TITLE}}": haiku.services[1]["title"],
    "{{SERVICE_2_DESC}}":  haiku.services[1]["description"],
    "{{SERVICE_3_TITLE}}": haiku.services[2]["title"],
    "{{SERVICE_3_DESC}}":  haiku.services[2]["description"],
    "{{SERVICE_4_TITLE}}": haiku.services[3]["title"],
    "{{SERVICE_4_DESC}}":  haiku.services[3]["description"],
    "{{SERVICE_5_TITLE}}": haiku.services[4]["title"],
    "{{SERVICE_5_DESC}}":  haiku.services[4]["description"],
    "{{SERVICE_6_TITLE}}": haiku.services[5]["title"],
    "{{SERVICE_6_DESC}}":  haiku.services[5]["description"],
}

html = template_source
for token, value in token_map.items():
    html = html.replace(token, value)
```

---

## Template Design

### Shared design language

All templates share the same structural and visual foundation. Every template is a complete, production-ready single-file HTML document. No stubs.

**Layout — every template has these sections in this order:**

1. Custom animated cursor (dot + lagging ring)
2. Page loader — shows `{{BUSINESS_NAME}}` with animated progress bar, dismisses after 2.2s
3. Mobile slide-down menu
4. Nav bar — `{{BUSINESS_NAME}}` logo left, nav links centre, "Get a Free Quote" CTA right. Transparent over hero, frosted glass on scroll.
5. Hero — full-viewport, trade photo background with dark gradient overlay, hardcoded tagline H1 with italic `<em>` accent word, city/state location line, scroll indicator
6. Marquee strip — dark background, scrolling trust/service keywords including `{{CITY}}`
7. About section — two-column: left has `{{ABOUT_BLURB}}` + `{{YEAR_FOUNDED}}` copy + two CTA buttons; right has 4 animated stat cards
8. Full-bleed parallax image 1 — with left-side caption overlay
9. Services grid — 6 cards (3×2), each with inline SVG icon, service number, `{{SERVICE_N_TITLE}}`, `{{SERVICE_N_DESC}}`, hover-reveal "Learn more →"
10. Projects slider — 5 slides with Unsplash photos, drag/arrow navigation, project tag references `{{CITY}}`
11. Quote section — dark background, hardcoded pull quote with italic `<em>` accent, `{{FOUNDER_NAME}}` attribution
12. Sectors grid — 4 cards with photo backgrounds, hover reveal
13. Full-bleed parallax image 2 — with left-side caption overlay
14. Process steps — 4 steps in a horizontal ruled grid
15. Testimonials — 3 cards with Unsplash portrait photos (face-cropped), `{{BUSINESS_NAME}}` and `{{CITY}}` injected into copy
16. CTA band — dark gradient, "Ready to begin your project?", `{{CITY}}` in body copy, `mailto:{{EMAIL}}` button, decorative first letter of `{{BUSINESS_NAME}}`
17. Footer — `{{BUSINESS_NAME}}` logo, `{{CITY}}`/`{{STATE}}` tagline, 4-column grid with `{{SERVICE_N_TITLE}}` links, `{{PHONE}}`, `{{EMAIL}}`

**Typography:**

- Display/body: `'Georgia', 'Times New Roman', serif` — premium editorial feel, zero external loading
- UI labels, nav, captions: `'Helvetica Neue', 'Arial', sans-serif`
- No Google Fonts CDN calls. Both are system fonts.
- H1: `clamp(2.8rem, 6vw, 6.5rem)` desktop, `32px` mobile
- Section headings: `clamp(2rem, 4vw, 3.5rem)`
- All font sizes in `rem` or `clamp()` — no hardcoded `px` outside base reset

**Colour system:**

Each template has two accent colours (primary + light highlight) defined as CSS variables `--accent` and `--accent-light`. All accent usage in the template goes through these variables — a palette swap is a two-line change.

Shared neutral base across all templates:
- Body background: warm off-white (varies slightly per template, see below)
- Dark sections: near-black with trade-specific undertone
- Alt section background: slightly tinted off-white
- Testimonials background: desaturated tint of dark section colour
- White cards: `#ffffff`
- Footer: dark near-black matching dark sections

**Animations:**

- Scroll reveal: `IntersectionObserver` on all `.reveal` elements — `translateY(40px)` → 0, opacity 0 → 1
- Staggered delays: `.delay-1` through `.delay-5` (0.1s to 0.6s)
- Hero: slow `scale(1.05)` → `scale(1)` over 12s on load
- Marquee: CSS `animation: marquee 30s linear infinite`
- Stat counters: JS `requestAnimationFrame` cubic ease-out on scroll into view
- Parallax: full-bleed images translate on scroll via passive scroll listener
- Cursor: custom dot + lagging ring, expands on hover over links/buttons
- Nav: transparent → frosted glass (`backdrop-filter: blur(20px)`) on scroll past 60px

**Performance:**

- No external JS of any kind
- No external CSS of any kind
- No web fonts loaded externally
- Hero image references `/assets/{key}-hero.jpg` on VPS — not inlined
- All other visuals are inline SVG only
- Portrait photos in testimonials reference Unsplash CDN URLs with `w=80&h=80&crop=face` params
- Project slider and sector card images reference Unsplash CDN URLs
- Target file size: under 80KB excluding hero image (actual: ~55–58KB)

**Responsive:**

- Single breakpoint at 768px, secondary at 1024px
- Nav collapses to logo + hamburger at 1024px; mobile slide-down menu
- Hero H1 drops via `clamp()`
- Services grid: 3-col → 2-col → 1-col
- About, process, sectors: stack to single column on mobile
- Testimonials: 3-col → 1-col

---

### Per-template specifications

**`electrical.html`** — file: `services/pipeline/src/templates/previews/electrical.html`

- Accent primary: `#d4820a` · Accent light: `#e8a830`
- Body background: `#f7f6f4` · Dark sections: `#1a1208` · Alt section: `#f0ede8`
- Atmospheric overlay tint: `rgba(212,130,10,...)`
- Hero tagline (hardcoded): `Where power meets` / `<em>precision</em>`
- Hero image: `/assets/electrical-hero.jpg`
- Marquee content: Licensed Electrician · Commercial Fitouts · Smart Home Automation · EV Charging Infrastructure · Bespoke Lighting Design · Licensed & Insured · Serving `{{CITY}}` & Surrounds
- About headline: `Trusted Electricians Serving <span>{{CITY}}</span>`
- Quote (hardcoded): "The finest electrical work is invisible — until the moment it illuminates everything."
- Service icons: lightning bolt, switchboard panel, wifi signal, EV plug, heritage building, data rack

**`plumbing.html`** — file: `services/pipeline/src/templates/previews/plumbing.html`

- Accent primary: `#1b4f8a` · Accent light: `#4a82c4`
- Body background: `#f5f8fc` · Dark sections: `#0d1e35` · Alt section: `#eaf0f8`
- Atmospheric overlay tint: `rgba(27,79,138,...)`
- Hero tagline (hardcoded): `Where craft meets` / `<em>flow</em>`
- Hero image: `/assets/plumbing-hero.jpg`
- About headline: `Your Local Plumbing Experts in <span>{{CITY}}</span>`
- Quote (hardcoded): "The finest plumbing is the kind you never notice — until the moment it moves you."

**`hvac.html`** — file: `services/pipeline/src/templates/previews/hvac.html`

- Accent primary: `#2c3e52` · Accent light: `#7a9ab5`
- Body background: `#f1f3f6` · Dark sections: `#121b24` · Alt section: `#e4e9ef`
- Atmospheric overlay tint: `rgba(44,62,82,...)`
- Hero tagline (hardcoded): `Where climate meets` / `<em>mastery</em>`
- Hero image: `/assets/hvac-hero.jpg`
- About headline: `{{CITY}}'s Climate <span>Specialists</span>`
- Quote (hardcoded): "Perfect climate control is never felt — it is simply the quiet confidence that every room is exactly right."

**`concreting.html`** — file: `services/pipeline/src/templates/previews/concreting.html`

- Accent primary: `#3d3528` · Accent light: `#8c7d65`
- Body background: `#f2f1ef` · Dark sections: `#1c1a17` · Alt section: `#e8e5e0`
- Atmospheric overlay tint: `rgba(61,53,40,...)`
- Hero tagline (hardcoded): `Where strength meets` / `<em>permanence</em>`
- Hero image: `/assets/concreting-hero.jpg`
- About headline: `Quality Concreting in <span>{{CITY}}</span> and Surrounds`
- Quote (hardcoded): "Concrete is the most honest material in the world — it shows you exactly what it is, and lasts forever."

**`landscaping.html`** — file: `services/pipeline/src/templates/previews/landscaping.html`

- Accent primary: `#1a3d2b` · Accent light: `#6b9e78`
- Body background: `#f4f7f2` · Dark sections: `#0d1f14` · Alt section: `#e8f0e4`
- Atmospheric overlay tint: `rgba(26,61,43,...)`
- Hero tagline (hardcoded): `Where nature meets` / `<em>artistry</em>`
- Hero image: `/assets/landscaping-hero.jpg`
- About headline: `Transforming <span>{{CITY}}</span> Gardens`
- Quote (hardcoded): "A great garden is not built in a season — it is grown, one considered decision at a time."

**`general.html`** — file: `services/pipeline/src/templates/previews/general.html`

- Accent primary: `#d4820a` · Accent light: `#e8a830` (matches electrical — amber palette)
- Body background: `#f7f6f4` · Dark sections: `#1a1208` · Alt section: `#f0ede8`
- Atmospheric overlay tint: `rgba(212,130,10,...)`
- Hero tagline (hardcoded): `Where quality meets` / `<em>results</em>`
- Hero image: `/assets/general-hero.jpg`
- About headline: `Your Local Specialists in <span>{{CITY}}</span>`
- Quote (hardcoded): "The best businesses in `{{CITY}}` are not the biggest — they are the ones that show up, do the work, and stand behind it."
- Marquee content: Fully Licensed · Locally Owned · Quality Guaranteed · Free Quotes · Fast Turnaround · Licensed & Insured · Serving `{{CITY}}` & Surrounds
- Service icons: generic (star, lock, clock, house, chart, sun/cog) — no trade-specific iconography

---

### Assets deployment

Six hero images must be deployed to `/var/www/previews/assets/` on the VPS before the first preview is generated. Templates reference them as `/assets/{key}-hero.jpg`.

| File | Content |
| --- | --- |
| `electrical-hero.jpg` | Electrician at work / switchboard |
| `plumbing-hero.jpg` | Plumber at work / pipes |
| `hvac-hero.jpg` | HVAC unit / technician |
| `concreting-hero.jpg` | Fresh concrete pour / finishing |
| `landscaping-hero.jpg` | Garden transformation |
| `general-hero.jpg` | Construction site / trades worker |

Images must be optimised to under 200KB each. This is a one-time deploy step documented in `docs/operator-runbook.md`.

---

### Maintenance process

When a template needs updating:

1. Edit the source file in `services/pipeline/src/templates/previews/{key}.html`
2. If a new `{{TOKEN}}` is added, update the token table in this spec and in `generate_preview.py` before deploying
3. Already-generated files at `/var/www/previews/` are not automatically updated — they reflect the template version at generation time. Intentional for Phase 1.
4. To propagate a fix to existing leads, run a one-off regeneration script against the `website_previews` table — future-phase operator tool, not built now
5. Template changes do not require a DB migration unless a new token requires a new field in `personalisation_data`

---

## Cost Profile

| Item | Cost per lead |
| --- | --- |
| Haiku personalisation call | ~$0.001 |
| VPS disk (HTML file ~55–58KB) | ~$0.000005 |
| Nginx static serve | $0.00 |
| **Total per lead** | **~$0.001** |

At $1,500 AUD revenue per conversion, preview generation cost is negligible.

---

## Preview Hosting

### One-time VPS setup (manual, before first deploy)

```nginx
server {
    listen 80;
    server_name preview.presciaiq.com;

    root /var/www/previews;
    autoindex off;

    add_header X-Frame-Options "SAMEORIGIN";
    add_header Content-Security-Policy "frame-ancestors 'self' https://dashboard.presciaiq.com";

    location / {
        try_files $uri $uri.html =404;
    }
}
```

After adding this block to `nginx.conf`:

1. `sudo nginx -t && sudo systemctl reload nginx`
2. `sudo certbot --nginx -d preview.presciaiq.com`
3. `sudo mkdir -p /var/www/previews/assets && sudo chown -R www-data:www-data /var/www/previews`

DNS change required at domain registrar: add A record `preview` -> `170.64.143.200`.

### URL format

`https://preview.presciaiq.com/{lead_id}`

The UUID is non-guessable. No authentication required on preview pages. `X-Frame-Options` and `Content-Security-Policy` headers restrict iframe embedding to `dashboard.presciaiq.com` only, preventing third-party framing.

`autoindex off` ensures a malformed or truncated URL cannot expose the directory listing.

### File lifecycle

Phase 1: no expiry. Preview files persist indefinitely. Cleanup policy (e.g. archive after 90 days post-paid) is a future-phase concern.

---

## Email Copy

### Prompt: `prompts/opener-v2.txt`

Replaces `opener-v1.txt` for all qualified leads once this feature is live.

**Key constraints baked into the prompt:**

- No em-dashes anywhere in output
- No double-hyphen em-dash substitutes
- No "hope this email finds you well" or equivalent opener
- No corporate language
- Casual Aussie tone
- Price stated upfront ($1,500 flat)
- Preview URL must appear as a hyperlink, not a raw URL

**Step 1 opener structure:**

```
Hey {first_name}, spotted {business_name}'s site and noticed {specific_weakness}.
That's quietly costing you leads every week.

I went ahead and put together what your site could look like: [Check it out]({preview_url})

If you want it, it's $1,500 flat. Domain, hosting, mobile-ready, local SEO basics.
Delivered in 2 weeks. If you hate it, tell me why and I'll fix it before you pay anything.

Macauley
```

**Follow-up 1 (3 days):**

```
Hey {first_name}, just checking you got a chance to look at the preview.
Happy to tweak anything to match your branding or services. Still $1,500 all in.
```

**Follow-up 2 (6 days):**

```
Last nudge from me. Offer's open if the timing works. No pressure.
```

### Instantly campaign setup

`preview_url` is passed as a new key in `custom_variables` alongside the existing `opener`, `weakness`, `followup_1`, `followup_2`, `lead_id` variables in `_instantly_payload()`.

Macauley configures the Instantly campaign email template to reference `{{website_preview_url}}` in the Step 1 body. This is a one-time manual action in the Instantly dashboard before the campaign goes live.

### Pre-launch QA requirement

See `docs/operator-runbook.md` — Macauley must send a test email to himself and visually confirm that no em-dash or double-hyphen substitution has been introduced by the ESP before the campaign goes live.

---

## Dashboard Integration

### Data contract

`getLeadDetail` in `services/dashboard/src/db/queries.ts` is extended to join `website_previews` on `tenant_id + lead_id`. The returned `detail` object gains a `websitePreview` field:

```typescript
websitePreview: {
  templateUsed: string;
  previewUrl: string;
  personalisationData: Record<string, unknown>;
  promptVersion: string;
  costUsd: string;
  generatedAt: Date;
} | null
```

### LeadDetailView component

A new `WebsitePreviewCard` component is added to `LeadDetailView`, receiving `websitePreview` as a prop.

**States:**

- `null` (generation pending or failed): card shows "Preview generating..." skeleton or "Preview failed — check pipeline" error state
- Present: renders the full card

**Card contents (when preview exists):**

- Template selector tabs — the matched template tab is active; the other 5 are shown as inactive (Phase 1: one preview per lead, no switching)
- Browser chrome with desktop/mobile toggle
  - Desktop view: iframe pointing to `previewUrl` directly (X-Frame-Options + CSP headers on the preview server permit this)
  - Mobile view: scaled iframe inside the phone shell from the design
- Template details grid: template name, industry match (`templateUsed` + lead city/state), personalisation fields injected
- Send row: "Prototype link included in Step 1 opener" with delivered badge (shown once `outreachSends` record exists for this lead)
- "Open full preview" link: opens `previewUrl` in a new tab

---

## Security

- Preview URLs use UUID (non-guessable, no auth needed)
- Nginx `autoindex off` on `/var/www/previews/`
- `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self' https://dashboard.presciaiq.com` on all preview responses — prevents third-party framing
- No PII in the preview URL itself
- Preview files contain business name, city, phone — same PII already present in leads table. Acceptable: the lead is the subject of the data.
- `security-reviewer` agent to be invoked after implementing the Nginx config change and the Instantly payload change
- `db-reviewer` agent to be invoked after writing any new query in `queries.py` or `queries.ts` (mandatory per project rules)

---

## Out of Scope (Phase 1)

- Preview regeneration (operator-triggered from dashboard)
- A/B template testing
- Preview expiry / cleanup jobs
- Analytics on preview link clicks (Instantly tracks opens/clicks natively)
- Custom domain per preview (e.g. `aquaoptions.presciaiq.com`)
- PDF export of preview
- Operator template switching in the dashboard UI
- Weakness callout band (removed — not present in built templates)

---

## Files Affected

**New files:**

- `services/pipeline/src/workers/generate_preview.py`
- `services/pipeline/tests/test_generate_preview.py`
- `services/pipeline/src/templates/previews/plumbing.html`
- `services/pipeline/src/templates/previews/electrical.html`
- `services/pipeline/src/templates/previews/hvac.html`
- `services/pipeline/src/templates/previews/concreting.html`
- `services/pipeline/src/templates/previews/landscaping.html`
- `services/pipeline/src/templates/previews/general.html`
- `prompts/preview-personalise-v1.txt`
- `services/dashboard/src/components/WebsitePreviewCard.tsx`
- `services/dashboard/src/components/WebsitePreviewCard.test.tsx`
- `docs/operator-runbook.md` (new, includes pre-launch QA checklist and assets deploy steps)

**Modified files:**

- `services/pipeline/src/workers/qualify.py` — replace SCHEDULE_OUTREACH enqueue with GENERATE_PREVIEW enqueue, forward payload
- `services/pipeline/src/workers/schedule_outreach.py` — accept and forward `preview_url` in Instantly payload
- `services/pipeline/src/pipeline_queue/definitions.py` — add GENERATE_PREVIEW job type
- `services/pipeline/src/db/queries.py` — insert_website_preview, get_website_preview_by_lead_id
- `services/pipeline/tests/test_qualify.py` — update to assert GENERATE_PREVIEW enqueued, not SCHEDULE_OUTREACH
- `services/pipeline/tests/test_schedule_outreach.py` — update to assert preview_url in Instantly payload
- `services/dashboard/src/db/queries.ts` — extend getLeadDetail to join website_previews
- `services/dashboard/src/db/schema.ts` — add websitePreviews table definition
- `services/dashboard/src/components/LeadDetailView.tsx` — add WebsitePreviewCard
- `nginx.conf` — add preview.presciaiq.com server block
- `prompts/opener-v2.txt` — new opener prompt with preview_url slot
- `.env.example` — add PREVIEW_BASE_URL=https://preview.presciaiq.com
