# Website Preview Feature — Design Spec

**Date:** 2026-05-29
**Status:** Approved for implementation planning

---

## Overview

When a lead is qualified, PrinterIQ generates a personalised, trade-matched HTML website preview and hosts it at a unique URL. That URL is injected into the outreach email via Instantly's custom variables. The lead clicks a real browser link and sees a polished website mocked up for their specific business. The generated preview is also visible in the dashboard lead detail page.

Two lead scenarios are handled:

- **Lead has a website:** preview demonstrates what a rebuilt, weakness-free version could look like.
- **Lead has no website:** preview shows a clean landing page as if they already had a professional site.

The bar for template quality is a site that looks like a genuine $3,000-$5,000 build. Not a mockup. Not a wireframe. Leads should feel compelled on first view.

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

1. Fetch lead record (tenant-scoped) -- need: `first_name`, `business_name`, `city`, `state`, `phone`, `industry`, `vertical`, `keywords`
2. Fetch qualification record (tenant-scoped) -- need: `top_weakness`
3. Determine template via keyword trade-type mapping (see Template System section)
4. Call Claude Haiku with `preview-personalise-v1` prompt to generate: services list (3-5 items), 2-line about blurb, location tagline
5. Render final HTML by injecting Haiku output + lead data into the selected template file
6. Write rendered HTML to `/var/www/previews/{lead_id}.html` on VPS
7. Insert row into `website_previews` table
8. Enqueue `SCHEDULE_OUTREACH` with forwarded payload + `preview_url`

**Retry / failure handling:**

- BullMQ max attempts: 5
- Exponential backoff: 60s, 120s, 240s, 480s, 960s
- On all retries exhausted: dead-letter queue (existing handler); surfaces in dashboard
- `SCHEDULE_OUTREACH` is only enqueued after confirmed DB insert -- if the insert fails, the job retries from step 6

**TDD requirement:** `generate_preview` is on the TDD-mandatory path. Tests must cover:

- Successful end-to-end generation for each of the 6 template keys
- Trade-type keyword mapping (all 5 specific + fallback)
- Haiku JSON parse failure triggers retry
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

- `services/pipeline/src/db/queries.py` -- insert + get by lead_id (Python worker)
- `services/dashboard/src/db/queries.ts` -- get by lead_id for dashboard read (TypeScript)

No raw queries outside these files.

---

## Template System

### Template inventory

| Key           | Dedicated trade types (keyword match)                                 | Hero image theme         |
| ------------- | --------------------------------------------------------------------- | ------------------------ |
| `plumbing`    | plumber, plumbing, hot water, pipes, drainage, blocked drains         | Plumber at work, pipes   |
| `electrical`  | electrician, electrical, solar, switchboard, wiring, lighting         | Electrician, switchboard |
| `hvac`        | air conditioning, hvac, heating, cooling, refrigeration, split system | HVAC unit, technician    |
| `concreting`  | concreting, concrete, driveways, paths, slabs, footings               | Fresh concrete pour      |
| `landscaping` | landscaping, lawn, gardens, turf, retaining walls, mowing             | Garden transformation    |
| `general`     | Fallback -- all leads that do not match any of the above              | Construction/trades site |

### Trade-type matching logic

Pure deterministic keyword lookup -- no Claude call. Matching runs against `industry`, `vertical`, and `keywords` fields (lowercased), evaluated in that priority order. First match wins. If no match, `general` is selected.

All keyword lists live in a single config dict in `generate_preview.py` -- not scattered across the worker. Easy to extend.

### General fallback template content

The `general` template uses:

- **Hero imagery:** construction/trades stock photo (hard hat, tools, site)
- **Hero tagline:** "Quality Trades, Local Service"
- **Services grid (5 items):** Free Quotes, Fully Licensed, Local Area Coverage, Quality Guaranteed, Fast Turnaround
- **About section:** filled by Haiku using the lead's business name, city, and industry field
- **Contact section:** business name, city, state, phone injected from lead data

This is the minimum content set required to meet the "looks like a real $3,000-$5,000 site" standard for non-matched leads.

### Template rendering

Each template is a single self-contained `.html` file stored at:
`services/pipeline/src/templates/previews/{key}.html`

Templates use `{{PLACEHOLDER}}` tokens (double curly, uppercase). The render step is a simple multi-key string replace -- no template engine dependency.

**Tokens available in all templates:**

| Token                                   | Source                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{BUSINESS_NAME}}`                     | `lead.business_name`                                                                                                                                                                                                                                                                                  |
| `{{FIRST_NAME}}`                        | `lead.first_name`                                                                                                                                                                                                                                                                                     |
| `{{CITY}}`                              | `lead.city`                                                                                                                                                                                                                                                                                           |
| `{{STATE}}`                             | `lead.state`                                                                                                                                                                                                                                                                                          |
| `{{PHONE}}`                             | `lead.phone`                                                                                                                                                                                                                                                                                          |
| `{{TAGLINE}}`                           | Haiku output                                                                                                                                                                                                                                                                                          |
| `{{ABOUT_BLURB}}`                       | Haiku output                                                                                                                                                                                                                                                                                          |
| `{{SERVICE_1}}` through `{{SERVICE_5}}` | Haiku output                                                                                                                                                                                                                                                                                          |
| `{{WEAKNESS_CALLOUT}}`                  | Human-readable label mapped from `qualification.top_weakness` code: `no_mobile` -> "Not mobile-friendly", `no_ssl` -> "No SSL certificate", `no_meta_title` -> "Missing page title", `no_meta_description` -> "Missing meta description", `no_h1` -> "No main heading", unknown -> "Outdated website" |
| `{{PREVIEW_URL}}`                       | `https://preview.printeriq.com/{lead_id}`                                                                                                                                                                                                                                                             |

### Template design requirements

Every template must:

- Be fully self-contained (no external JS, no external fonts via Google Fonts CDN -- embed or use system fonts)
- Be mobile-first responsive
- Include an SSL padlock visual in the hero or nav (design signal, not functional)
- Load in under 1 second on a 4G connection (no large uncompressed images -- use optimised stock photos, max 200KB per image, inline as base64 or reference a VPS-hosted `/var/www/previews/assets/` directory)
- Visually pass as a real $3,000-$5,000 tradie website on first impression
- Not include any PrinterIQ branding -- the preview represents the lead's business, not ours

---

## Preview Hosting

### One-time VPS setup (manual, before first deploy)

```nginx
server {
    listen 80;
    server_name preview.printeriq.com;

    root /var/www/previews;
    autoindex off;

    add_header X-Frame-Options "SAMEORIGIN";
    add_header Content-Security-Policy "frame-ancestors 'self' https://dashboard.printeriq.com";

    location / {
        try_files $uri $uri.html =404;
    }
}
```

After adding this block to `nginx.conf`:

1. `sudo nginx -t && sudo systemctl reload nginx`
2. `sudo certbot --nginx -d preview.printeriq.com`
3. `sudo mkdir -p /var/www/previews/assets && sudo chown -R www-data:www-data /var/www/previews`

**Template assets deployment:** The 6 trade-specific stock photos (optimised, max 200KB each) must be uploaded to `/var/www/previews/assets/` on the VPS before the first preview is generated. Templates reference them as `/assets/{key}-hero.jpg`. This is a one-time deploy step documented in `docs/operator-runbook.md`.

DNS change required at domain registrar: add A record `preview` -> `170.64.143.200`.

### URL format

`https://preview.printeriq.com/{lead_id}`

The UUID is non-guessable. No authentication required on preview pages. `X-Frame-Options` and `Content-Security-Policy` headers restrict iframe embedding to `dashboard.printeriq.com` only, preventing third-party framing.

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

See `docs/operator-runbook.md` -- Macauley must send a test email to himself and visually confirm that no em-dash or double-hyphen substitution has been introduced by the ESP before the campaign goes live.

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

- `null` (generation pending or failed): card shows "Preview generating..." skeleton or "Preview failed -- check pipeline" error state
- Present: renders the full card as designed in `printeriq-dashboard-v2.html`

**Card contents (when preview exists):**

- Template selector tabs -- the matched template tab is active; the other 5 are shown as inactive (Phase 1: one preview per lead, no switching)
- Browser chrome with desktop/mobile toggle
  - Desktop view: iframe pointing to `previewUrl` directly (X-Frame-Options + CSP headers on the preview server permit this)
  - Mobile view: scaled iframe inside the phone shell from the design
- Template details grid: template name, industry match (`templateUsed` + lead city/state), personalisation fields injected, weakness addressed
- Send row: "Prototype link included in Step 1 opener" with delivered badge (shown once `outreachSends` record exists for this lead)
- "Open full preview" link: opens `previewUrl` in a new tab

---

## New Prompt File

**`prompts/preview-personalise-v1.txt`**

Called once per lead from `generate_preview` worker via `claude_client.py`.

Input variables: `business_name`, `city`, `state`, `industry`, `keywords`, `top_weakness`

Output schema (JSON, validated before use):

```json
{
  "tagline": "string (max 10 words, location-specific, no em-dashes)",
  "about_blurb": "string (2 sentences, casual, professional)",
  "services": ["string", "string", "string"] // 3-5 items
}
```

Model: `claude-haiku-4-5-20251001` (cheapest, fast, sufficient for short structured output)

Estimated cost: ~$0.001 per lead

---

## Cost Profile

| Item                       | Cost per lead |
| -------------------------- | ------------- |
| Haiku personalisation call | ~$0.001       |
| VPS disk (HTML file ~30KB) | ~$0.000003    |
| Nginx static serve         | $0.00         |
| **Total per lead**         | **~$0.001**   |

At $1,500 AUD revenue per conversion, preview generation cost is negligible.

---

## Security

- Preview URLs use UUID (non-guessable, no auth needed)
- Nginx `autoindex off` on `/var/www/previews/`
- `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self' https://dashboard.printeriq.com` on all preview responses -- prevents third-party framing
- No PII in the preview URL itself
- Preview files contain business name, city, phone -- same PII already present in leads table. Acceptable: the lead is the subject of the data.
- `security-reviewer` agent to be invoked after implementing the Nginx config change and the Instantly payload change
- `db-reviewer` agent to be invoked after writing any new query in `queries.py` or `queries.ts` (mandatory per project rules)

---

## Out of Scope (Phase 1)

- Preview regeneration (operator-triggered from dashboard)
- A/B template testing
- Preview expiry / cleanup jobs
- Analytics on preview link clicks (Instantly tracks opens/clicks natively)
- Custom domain per preview (e.g. `aquaoptions.printeriq.com`)
- PDF export of preview
- Operator template switching in the dashboard UI

---

## Template Design Brief

All 6 templates are generated by Claude as part of this task. No template file should be stubbed or left empty. Each must be a complete, production-ready single-file HTML document on delivery.

### Shared design language

All templates share the same structural and visual foundation. The goal is consistent product quality across trades while feeling genuinely trade-specific on first impression.

**Layout — every template must have these sections in this order:**

1. Nav bar — business name (text, not logo), phone number right-aligned, one CTA button ("Get a Free Quote")
2. Hero — full-width, trade photo background with dark overlay, business name as H1, tagline as H2, two CTA buttons ("Call Now" and "Get a Free Quote")
3. Trust bar — 4 inline trust signals rendered as icon + label
4. Services grid — 3 to 5 cards, each with a simple inline SVG icon, service name, one-line description
5. About section — two-column layout, left is `{{ABOUT_BLURB}}`, right is a simple stat block (years in business placeholder, jobs completed placeholder, areas covered)
6. Weakness callout banner — full-width coloured band, headline referencing `{{WEAKNESS_CALLOUT}}`, subtext "We build sites that don't have this problem"
7. Contact section — business name, phone (large, clickable `tel:` link), city/state, simple contact form (name, phone, message — static HTML, no backend)
8. Footer — business name, city/state, ABN placeholder, no PrinterIQ branding anywhere

**Typography:**

- System font stack only — no Google Fonts CDN calls. Use: `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- H1: 48px bold on desktop, 32px on mobile
- H2: 28px, medium weight
- Body: 16px, 1.6 line height
- All font sizes in `rem`, not `px`, for accessibility

**Colour system:**

- Each template has one primary accent colour (defined per template below)
- All templates share the same neutral base: white body (`#ffffff`), dark text (`#1a1a1a`), light section backgrounds (`#f8f8f7`), footer dark (`#1a1a1a` with white text)
- CTA buttons use the accent colour with white text
- Trust bar and weakness callout banner use a light tint of the accent colour as background

**Spacing and layout:**

- Max content width: 1100px, centred
- Section padding: 80px vertical on desktop, 48px on mobile
- All layout via CSS Flexbox or Grid — no frameworks, no external CSS

**Images:**

- Hero background references `/assets/{key}-hero.jpg` — do not inline as base64
- All other visual elements use inline SVG icons only — no image tags outside the hero
- Hero overlay: `background: linear-gradient(rgba(0,0,0,0.55), rgba(0,0,0,0.45))` over the photo

**Performance:**

- No external JS of any kind
- No external CSS of any kind
- No web fonts loaded externally
- Entire file (excluding hero image) must be under 50KB

**Mobile:**

- Single breakpoint at 768px
- Nav collapses to business name + phone only (no hamburger menu needed)
- Hero H1 drops to 32px
- Services grid stacks to single column
- About section stacks to single column

**Trust signals:**

- Include a padlock SVG icon in the nav bar or trust bar, styled in the accent colour — visual signal only, not functional

---

### Per-template specifications

**`plumbing.html`**

- Accent colour: `#0369a1` (deep blue)
- Trust bar: Licensed Plumber, 24/7 Emergency, Local Business, Free Quotes
- Services label: "Our Plumbing Services"
- About headline: "Your Local Plumbing Experts in `{{CITY}}`"
- Callout tint: `#e0f2fe`
- Hero image: `/assets/plumbing-hero.jpg`

**`electrical.html`**

- Accent colour: `#d97706` (amber)
- Trust bar: Licensed Electrician, Safety Certified, Local Business, Free Quotes
- Services label: "Our Electrical Services"
- About headline: "Trusted Electricians Serving `{{CITY}}` and Surrounds"
- Callout tint: `#fef3c7`
- Hero image: `/assets/electrical-hero.jpg`

**`hvac.html`**

- Accent colour: `#0891b2` (cyan)
- Trust bar: Fully Licensed, All Brands Serviced, Local Business, Free Quotes
- Services label: "Heating and Cooling Services"
- About headline: "`{{CITY}}`'s Air Conditioning Specialists"
- Callout tint: `#cffafe`
- Hero image: `/assets/hvac-hero.jpg`

**`concreting.html`**

- Accent colour: `#57534e` (warm grey)
- Trust bar: Licensed Contractor, Quality Materials, Local Business, Free Quotes
- Services label: "Our Concreting Services"
- About headline: "Quality Concreting in `{{CITY}}` and Surrounding Areas"
- Callout tint: `#f5f5f4`
- Hero image: `/assets/concreting-hero.jpg`

**`landscaping.html`**

- Accent colour: `#16a34a` (green)
- Trust bar: Fully Insured, Locally Owned, Seasonal Availability, Free Quotes
- Services label: "Our Landscaping Services"
- About headline: "Transforming `{{CITY}}` Gardens Since Day One"
- Callout tint: `#dcfce7`
- Hero image: `/assets/landscaping-hero.jpg`

**`general.html`**

- Accent colour: `#1d4ed8` (neutral blue)
- Trust bar: Fully Licensed, Locally Owned, Quality Guaranteed, Free Quotes
- Services label: "Our Services"
- About headline: "Your Local Trade Specialists in `{{CITY}}`"
- Callout tint: `#eff6ff`
- Hero image: `/assets/general-hero.jpg`
- Services grid uses hardcoded fallback values (Free Quotes, Fully Licensed, Local Area Coverage, Quality Guaranteed, Fast Turnaround) — `{{SERVICE_1}}` through `{{SERVICE_5}}` tokens are still used in the template but the worker injects these fixed values directly rather than waiting on Haiku output

---

### Maintenance process

When a template needs updating:

1. Edit the source file in `services/pipeline/src/templates/previews/{key}.html`
2. If a new `{{TOKEN}}` is added, update the token table in this spec and in `generate_preview.py` before deploying
3. Already-generated files at `/var/www/previews/` are not automatically updated — they reflect the template version at generation time. This is intentional for Phase 1.
4. To propagate a fix to existing leads, run a one-off regeneration script against the `website_previews` table — this is a future-phase operator tool, not built now
5. Template changes do not require a DB migration unless a new token requires a new field in `personalisation_data`

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
- `docs/operator-runbook.md` (new, includes pre-launch QA checklist)

**Modified files:**

- `services/pipeline/src/workers/qualify.py` -- replace SCHEDULE_OUTREACH enqueue with GENERATE_PREVIEW enqueue, forward payload
- `services/pipeline/src/workers/schedule_outreach.py` -- accept and forward `preview_url` in Instantly payload
- `services/pipeline/src/pipeline_queue/definitions.py` -- add GENERATE_PREVIEW job type
- `services/pipeline/src/db/queries.py` -- insert_website_preview, get_website_preview_by_lead_id
- `services/pipeline/tests/test_qualify.py` -- update to assert GENERATE_PREVIEW enqueued, not SCHEDULE_OUTREACH
- `services/pipeline/tests/test_schedule_outreach.py` -- update to assert preview_url in Instantly payload
- `services/dashboard/src/db/queries.ts` -- extend getLeadDetail to join website_previews
- `services/dashboard/src/db/schema.ts` -- add websitePreviews table definition
- `services/dashboard/src/components/LeadDetailView.tsx` -- add WebsitePreviewCard
- `nginx.conf` -- add preview.printeriq.com server block
- `prompts/opener-v2.txt` -- new opener prompt with preview_url slot
- `.env.example` -- add PREVIEW_BASE_URL=https://preview.printeriq.com
