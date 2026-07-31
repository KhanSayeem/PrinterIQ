# Operator Runbook

Macauley's guide for day-to-day operations.

## SSH into the VPS

```bash
ssh root@170.64.143.200
cd /root/printeriq
```

## View service status

```bash
pm2 status
```

Healthy output shows three processes (`pipeline`, `reply-agent`, `dashboard`) with status `online`.

## View logs

```bash
pm2 logs pipeline       # Python workers
pm2 logs reply-agent    # Node.js webhook + Claude handler
pm2 logs dashboard      # Next.js dashboard

pm2 logs --lines 100    # All services, last 100 lines
```

## Restart a service

```bash
pm2 restart pipeline
pm2 restart reply-agent
pm2 restart dashboard
pm2 restart all         # restart everything
```

## Restart Nginx

```bash
systemctl reload nginx
```

## Deploy a new release

Deployments trigger automatically when a commit is pushed to `main` via GitHub Actions.
To deploy manually:

```bash
cd /root/printeriq
git pull origin main
python3 -m pip install -e services/pipeline
python3 -m playwright install --with-deps chromium
pm2 restart all
pm2 save
```

## Fresh worktree dashboard dependencies

`services/dashboard` uses pnpm so Codex worktrees can share one package store instead of duplicating full npm `node_modules` installs in every checkout.

On Windows agent machines, run this once per user:

```powershell
corepack enable
pnpm config set store-dir C:\Users\Hi\.pnpm-store
```

Then use this inside each fresh worktree:

```powershell
cd services/dashboard
pnpm install --frozen-lockfile
```

Do not commit a machine-specific `.npmrc` or `.pnpm-store` path. The store setting belongs in the user-level pnpm config.

## Apply a new database migration

```bash
# Option A: Supabase dashboard SQL editor (paste the SQL file content)
# Option B: psql (if installed)
psql $DATABASE_URL -f database/migrations/0003_<name>.sql
```

## Ingest a new Apollo CSV

Confirm `QUALIFICATION_SCORE_THRESHOLD` is configured on the server before any
dashboard CSV import. Imports fail closed without it so doomed qualification
jobs are not queued.

1. Upload the CSV to `/root/printeriq/uploads/` on the VPS
2. Trigger the ingest job (dashboard upload feature or direct queue push):

```bash
cd /root/printeriq/services/pipeline
python -m src.workers.ingest --file /uploads/<filename>.csv
```

Use `--dry-run` first to validate without writing:

```bash
python -m src.workers.ingest --file /uploads/<filename>.csv --dry-run
```

## Check queue health

```bash
redis-cli
> LLEN bull:pipeline:wait    # jobs waiting in pipeline queue
> LLEN bull:replies:wait     # jobs waiting in replies queue
```

## Prospect shadow discovery operations

Use this section only for the Outscraper/Apollo shadow pilot. Shadow prospect
jobs stop at `/prospects` review and export; they must not create leads, website
previews, outreach sends, or Instantly activity.

### Prerequisites

- [ ] Confirm database migrations through `0008_create_prospect_staging.sql` are applied.
- [ ] Confirm Redis is reachable and the `pipeline` PM2 process is online.
- [ ] Confirm `TENANT_ID` is configured on the server for the intended tenant.
- [ ] Confirm `OUTSCRAPER_API_KEY` is configured, and confirm the expected provider credit limit before starting.
- [ ] Confirm Apollo has master-key capability if contact resolution will be run; missing capability is recorded as failed contact evidence.
- [ ] Confirm no live outreach campaign is being activated as part of this shadow run.

### Create Exactly One Run

- [ ] Open `/prospects` as an authenticated operator for the configured tenant.
- [ ] Start one Greater Brisbane plumbing shadow run only.
- [ ] Do not start a second run while the first run has status `created`, `submitted`, `polling`, `persisted`, `processing`, or `review_ready`.
- [ ] Do not edit the provider query set in the browser; the server owns the approved categories, localities, and limits.

### Observe The Queue

Run from the VPS:

```bash
cd /root/printeriq
pm2 logs pipeline --lines 100
redis-cli LLEN bull:pipeline:wait
```

Expected progression:

```text
start_discovery -> poll_outscraper -> normalize_prospects -> assess_prospects -> enrich_prospect_contacts -> prepare_shadow_review
```

Safe outcomes are `review_ready`, `failed` with actionable provider evidence, or
an operator-aborted run that remains available for investigation. Do not delete
or rewrite snapshots to force a run through review.

### Safe Retries And Abort Behavior

- [ ] Retry queue jobs through normal queue redelivery only; repeated delivery is expected to be idempotent.
- [ ] For an uncertain Outscraper submission, reconcile the provider request ID before retrying so the run does not spend twice.
- [ ] For provider transport failures, let bounded queue retries finish before manual intervention.
- [ ] To abort, stop creating new work for the run and leave persisted snapshots/assessments intact for review; mark a run failed only with an operator note that explains the provider or configuration cause.
- [ ] Never run cleanup against a run that is still `created`, `submitted`, `polling`, `persisted`, `processing`, or `review_ready`.

### Review, Export, And Gates

- [ ] Open `/prospects` and verify the run is `review_ready`.
- [ ] Review Route A, Route B, and healthy/rejected validation samples.
- [ ] Confirm metrics show usable yield, route yield, verified email match by route, failure rate, precision, provider usage, and any cost reconciliation gap.
- [ ] Export the run from `/api/prospects/export?runId=<discovery_run_id>` after review evidence is complete.
- [ ] Treat incomplete cost reconciliation, insufficient sample, unresolved provider failures, or missing compliance approval as a no-go.
- [ ] Live outreach requires a separate compliance review and an explicit activation design. This runbook does not authorize promotion, preview generation, outreach scheduling, or Instantly sending from shadow prospects.

### Run Retention Cleanup

Retention cleanup is tenant-scoped and must be enqueued from server
configuration, not from an arbitrary browser tenant parameter:

```bash
cd /root/printeriq/services/pipeline
TENANT_ID=<configured_tenant_uuid> python -m src.workers.purge_prospect_data --enqueue
```

The cleanup worker clears expired raw Outscraper/Apollo payload JSON after the
configured raw-payload window, then deletes eligible child contacts and
assessments before deleting non-promoted prospect snapshots after the configured
snapshot window. It deletes a completed discovery run only after no retained
snapshots remain. It does not cascade into existing leads.

## Pre-launch website preview campaign QA

Complete this checklist before turning on the website preview campaign in Instantly.
The current preview host is `https://preview.presciaiq.com`, and preview pages use
the route `https://preview.presciaiq.com/p/{preview_slug}/`.

### 1. Instantly campaign template setup

- [ ] Open Instantly.
- [ ] Open the PrinterIQ website preview campaign.
- [ ] Open the campaign sequence editor.
- [ ] Keep the campaign paused while editing and testing.
- [ ] In Step 1, use this final email body:

```text
Hey {{first_name}}, spotted {{company_name}}'s site and noticed {{weakness}}.
That's quietly costing you leads every week.

I went ahead and put together what your site could look like: Check it out

If you want it, it's $1,500 flat. Domain, hosting, mobile-ready, local SEO basics.
Delivered in 2 weeks. If you hate it, tell me why and I'll fix it before you pay anything.

Macauley
```

- [ ] In the Step 1 editor, select only the words `Check it out` and set the link URL to `{{website_preview_url}}`.
- [ ] Do not paste `{{website_preview_url}}` as visible text in the email body.
- [ ] In Follow-up 1, use this final email body:

```text
Hey {{first_name}}, just checking you got a chance to look at the preview.
Happy to tweak anything to match your branding or services. Still $1,500 all in.
```

- [ ] In Follow-up 2, use this final email body:

```text
Last nudge from me. Offer's open if the timing works. No pressure.
```

- [ ] Confirm the campaign still uses the correct sending account and a paused dev/test campaign before any live smoke.
- [ ] Save the sequence but leave the campaign paused until all checks below pass.

### 2. Email rendering QA

- [ ] Add or choose a test lead that has a known `website_preview_url` value.
- [ ] Send Step 1 to yourself using Instantly's test-send feature.
- [ ] Open the test email in the same inbox a real lead would use.
- [ ] Confirm `Check it out` is a clickable hyperlink.
- [ ] Confirm the email does not show a raw preview URL in the body.
- [ ] Confirm clicking `Check it out` opens the expected page at `https://preview.presciaiq.com/p/{preview_slug}/`.
- [ ] Confirm there are no em dashes anywhere in the subject or body. This is a manual visual check and cannot be trusted to automated tests because email tools can alter punctuation.
- [ ] Confirm there are no double-hyphen substitutes for em dashes.
- [ ] Send Follow-up 1 and Follow-up 2 test emails to yourself.
- [ ] Confirm both follow-ups render cleanly and have no em dashes.

### 3. Nginx and preview server smoke test

Run these from the VPS.

- [ ] Confirm Nginx config is valid:

```bash
nginx -t
```

- [ ] Confirm Nginx is serving the preview host:

```bash
curl -I https://preview.presciaiq.com/p/<preview_slug>/
```

- [ ] Confirm the response is `200` for a real preview slug.
- [ ] Confirm SSL is valid in a browser by opening `https://preview.presciaiq.com/p/<preview_slug>/`.
- [ ] Confirm a bad root URL does not expose files:

```bash
curl -I https://preview.presciaiq.com/
```

- [ ] Confirm the root response is `404`.
- [ ] Confirm directory listing is not exposed:

```bash
curl -I https://preview.presciaiq.com/assets/
```

- [ ] Confirm the assets directory does not show a browsable file list.
- [ ] Confirm the Nginx site has `autoindex off`:

```bash
grep -n "autoindex off" /etc/nginx/sites-enabled/preview.presciaiq.com.conf
```

- [ ] Confirm preview responses include crawler-blocking headers:

```bash
curl -I https://preview.presciaiq.com/p/<preview_slug>/
```

- [ ] Confirm the headers include `X-Robots-Tag: noindex, nofollow, noarchive`.

### 4. Preview image deployment

Current templates use images under `/var/www/previews/assets/previews/`.

- [ ] Confirm the asset root exists:

```bash
ls -la /var/www/previews/assets/previews
```

- [ ] Confirm each trade has a hero image:

```bash
ls -lh /var/www/previews/assets/previews/plumbing/hero.jpg
ls -lh /var/www/previews/assets/previews/electrical/hero.jpg
ls -lh /var/www/previews/assets/previews/hvac/hero.jpg
ls -lh /var/www/previews/assets/previews/concreting/hero.jpg
ls -lh /var/www/previews/assets/previews/landscaping/hero.jpg
ls -lh /var/www/previews/assets/previews/general/hero.jpg
```

- [ ] Confirm each hero image is under 200KB.
- [ ] Confirm the shared image folder exists:

```bash
ls -lh /var/www/previews/assets/previews/shared
```

- [ ] Open one preview for each trade in a browser and confirm the hero image loads.
- [ ] If any image is missing or over 200KB, fix the deployed asset before sending live email.

### 5. End-to-end pipeline smoke test

Only run this after mailbox warmup is complete and `INSTANTLY_CAMPAIGN_ID` points
to a paused dev/test campaign. Do not use the live campaign for this smoke test.

- [ ] Ingest one test lead only.
- [ ] Confirm the lead reaches `qualified`.
- [ ] Confirm `generate_preview` runs for the lead.
- [ ] Confirm a preview file exists on the VPS:

```bash
ls -la /var/www/previews/p/<preview_slug>/index.html
```

- [ ] Confirm Supabase has a `website_previews` row for the same tenant and lead.
- [ ] Confirm the row has the expected `template_used`, `preview_slug`, `preview_url`, `prompt_version`, and `cost_usd`.
- [ ] Confirm the `preview_url` is `https://preview.presciaiq.com/p/{preview_slug}/`.
- [ ] Open the `preview_url` in a browser and confirm it renders the correct business name and trade template.
- [ ] Confirm `schedule_outreach` passes `website_preview_url` to Instantly.
- [ ] Confirm the received test email contains the working `Check it out` link.
- [ ] Archive or delete the test lead before enabling any live campaign.

After Issue #42 is complete, add this extra dashboard check:

- [ ] Open the lead detail page in the dashboard and confirm the WebsitePreviewCard shows the correct preview.

## Local smoke testing

Local Redis and orchestrator smoke tests are safe to run while domains and mailboxes are warming up. Start local Redis with:

```powershell
docker start printeriq-redis
```

Then run the orchestrator smoke test:

```bash
python -m src.workers.orchestrator --smoke
```

This only checks Redis connectivity, registered workers, concurrency settings, and pending queue count. It does not send emails.

Do not run live `schedule_outreach` smoke tests until warmup is complete and a paused dev/test Instantly campaign ID is configured:

```env
INSTANTLY_CAMPAIGN_ID=<paused_dev_campaign_id>
```

## Monitor escalation SMSes

Escalation SMSes go to `+61 400 457 006`. If you receive one:
1. Open the dashboard `/leads` and find the lead by name/business
2. Read the full conversation thread on `/leads/[id]`
3. Use the "Override reply" action to send a custom response, or call the lead directly

## Check dead-letter queue

Dead-lettered jobs appear in `queue_jobs` table with `status = 'dead'`. Review them in the Supabase dashboard:

```sql
SELECT * FROM queue_jobs WHERE status = 'dead' ORDER BY created_at DESC LIMIT 20;
```
