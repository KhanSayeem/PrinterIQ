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
jobs are not queued. The dashboard shows `Qualification score threshold is not
configured` and returns HTTP 500 before creating anything.

### Which env file to edit

The two services read different env files. Putting a dashboard variable in the
pipeline's file is a silent no-op.

| Service | Runs as | Reads |
| --- | --- | --- |
| pipeline | python workers, cwd `/root/printeriq` | `/root/printeriq/.env` |
| dashboard | `next start`, cwd `/root/printeriq/services/dashboard` | `/root/printeriq/services/dashboard/.env.production` |

`QUALIFICATION_SCORE_THRESHOLD` is read by the **dashboard**, so it belongs in
`services/dashboard/.env.production`. Adding it to `/root/printeriq/.env` has no
effect. The pipeline never reads it from env at all: the dashboard validates it
per upload and threads it through the job payload as `score_threshold`.

Set it:

```bash
cd /root/printeriq/services/dashboard
cp .env.production ".env.production.bak-$(date -u +%Y%m%dT%H%M%SZ)"
echo "QUALIFICATION_SCORE_THRESHOLD=20" >> .env.production
pm2 restart dashboard
pm2 save
```

Notes:

- `pm2 restart dashboard --update-env` re-reads the **shell** environment, not
  any `.env` file. It will not pick up a file edit on its own. Next.js loads
  `.env.production` at process start, so a plain `pm2 restart` is what applies
  the change.
- `pm2 env <id> | grep QUALIFICATION` will stay empty even when the variable is
  working, because Next.js loads it into the app at runtime rather than through
  PM2's injected env. Verify by hard-refreshing the dashboard and confirming the
  red banner is gone, not with `pm2 env`.
- Value must be an integer `0..100` or the import is rejected. Qualification
  compares with strict `<`, so a lead scoring exactly the threshold passes.

Use the dashboard **Import CSV** button. That is the only working ingest entry
point.

```
https://dashboard.presciaiq.com/leads  ->  Import CSV
```

The dashboard writes the file to disk and enqueues an `ingest_csv` job carrying
`score_threshold`. It does not parse the CSV itself; header and row validation
happen later in the pipeline worker, so a malformed file returns a successful
upload and then silently rejects every row. Check the import summary for
`inserted`, `rejected`, and `skipped_duplicates` rather than assuming success.

There is **no working CLI ingest**. `src/workers/ingest.py` has no `__main__`
block, so `python -m src.workers.ingest --file ...` exits without doing
anything. Only `orchestrator.py` and `purge_prospect_data.py` are runnable as
modules. Do not document or rely on a CLI ingest command until one exists.

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

## Check the Instantly webhooks are alive

Replies, bounces and unsubscribes all arrive by webhook. There is no polling,
so if the webhook is not delivering, the dashboard simply shows nothing and
looks idle rather than broken. This failed silently for two months (#122).

Verify auth end to end. A correct secret returns `invalid webhook payload`
(auth passed, the empty payload is what is rejected); a wrong secret returns
`invalid webhook secret`:

```bash
ssh -o BatchMode=yes root@170.64.143.200 'cd /root/printeriq && export $(grep -E "^INSTANTLY_WEBHOOK_ID_REPLY=" .env | xargs) && curl -s -X POST -H "Content-Type: application/json" -d "[]" https://webhooks.presciaiq.com/instantly/reply/$INSTANTLY_WEBHOOK_ID_REPLY'
```

Confirm the registered webhooks still point at this host and are active:

```bash
ssh -o BatchMode=yes root@170.64.143.200 'cd /root/printeriq && export $(grep -E "^INSTANTLY_API_KEY=" .env | xargs) && curl -s -H "Authorization: Bearer $INSTANTLY_API_KEY" https://api.instantly.ai/api/v2/webhooks'
```

Rejections now log to the reply-agent log, so a delivery problem is visible:

```bash
ssh -o BatchMode=yes root@170.64.143.200 "grep 'instantly webhook rejected' /root/.pm2/logs/reply-agent-*.log | tail"
```

**Do not "harden" the `/instantly/<event>/<id>` path form away.** Instantly
cannot send custom headers, so the trailing path segment is the only credential
it can present. `nginx.conf` sets `access_log off` on `location ^~ /instantly/`
specifically to keep that secret out of the access log. Removing either the
path route or that directive breaks or exposes the integration.

## Change the sending volume (send rate control)

The dashboard has a **Sending** page at `https://dashboard.presciaiq.com/sending`.
It reads every Instantly sending account, shows each mailbox's daily limit and the
campaign total, and applies a new total across the mailboxes without leaving the
dashboard.

It follows the ramp in `docs/adr/005-sending-volume-ramp.md`: 30, 45, 68, 101, 152,
155 campaign sends per day. The **Use next ramp step** button fills in the next
documented step, so the ramp is followed rather than guessed.

### Configure the sending domain allowlist first

The Instantly workspace also holds accounts on `adsiqdigital.com` and
`buildpredictiqdigital.com`. Those belong to a different project and are not
PrinterIQ capacity. The control therefore refuses to read or change anything until
`INSTANTLY_SENDING_DOMAINS` names the PrinterIQ mail domains.

It is read by the **dashboard**, so it belongs in
`services/dashboard/.env.production`:

```bash
cd /root/printeriq/services/dashboard
cp .env.production ".env.production.bak-$(date -u +%Y%m%dT%H%M%SZ)"
echo "INSTANTLY_SENDING_DOMAINS=presciaweb.com" >> .env.production
pm2 restart dashboard
pm2 save
```

Comma separate several domains, for example
`INSTANTLY_SENDING_DOMAINS=presciaweb.com,second-domain.com`. Any Instantly account
outside this list is counted separately on the page as out of scope and is never
written to.

### What it does and does not do

- It writes each in-scope mailbox's `daily_limit` through
  `PATCH /api/v2/accounts/{email}`. The requested campaign total is split across
  the mailboxes so the per-mailbox limits sum to exactly that total.
- It does **not** change the campaign level daily limit inside Instantly. That
  setting can still cap sending below the mailbox capacity, and it is still edited
  in the Instantly UI.
- An increase of more than double the current total is blocked behind an explicit
  confirmation. Google's guidance for senders increasing volume describes a common
  daily increase of 25% to 100%
  (https://support.google.com/mail/answer/15256272), so more than 100% in one step
  is outside that guidance.

### Read the result, do not assume it

The page reports the outcome per mailbox: which limits changed, which failed and
with what status code, and what the campaign total actually adds up to afterwards.
A partial failure is reported as a failure, not a success. If the report says
`Applied to 6 of 8 mailboxes`, then two mailboxes still hold their old limit and
the campaign total is not the number that was requested.

If Instantly cannot be read at all, the page shows the read error and no control.
Nothing is changed in that state.

## Change the offer price

The price lives in one place, `OFFER_PRICE_AUD` (defaults to 1499), read by
`services/pipeline/src/offer.py` and `services/reply-agent/src/offer.ts`. It
feeds the Stripe checkout amount and both prompts.

**The Instantly email templates are not covered by it** and must be edited by
hand in the Instantly UI, because they are static copy in a third-party
system. Changing the price is therefore two steps:

1. Set `OFFER_PRICE_AUD` in `/root/printeriq/.env` and restart, or change the
   default in both `offer` modules.
2. Edit the Instantly campaign: Step 1 body, both variants, and both
   follow-ups.

Missing step 2 is what caused #124, where the emails quoted $1,499 while
checkout charged $1,500 against a live Stripe key.

## Enrichment data quality

`tech_source = 'apollo'` enrichment rows were never actually measured. They
have `load_ms` and `has_h1` NULL, and almost all are flagged `has_ssl = FALSE`
despite an `https://` URL. Their `weaknesses` arrays are fabricated, and they
will pass both the actionable-weakness gate and the grounding check because
the wrong label genuinely is in the stored array.

Check before trusting any enrichment row:

```bash
ssh -o BatchMode=yes root@170.64.143.200 "cd /root/printeriq && export \$(grep -E '^DATABASE_URL=' .env | xargs) && psql \"\$DATABASE_URL\" -c \"SELECT tech_source, count(*), count(load_ms) AS measured FROM enrichments GROUP BY 1;\""
```

Only `playwright` and `playwright+apollo` rows reflect a real audit. Every
lead imported since 2026-08-12 gets one; older rows need re-enriching before
they are used for outreach. See #120.

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

### 1b. Second Instantly campaign, for leads with no website

Needed because of one sentence. Step 1 above opens with `spotted
{{company_name}}'s site and noticed {{weakness}}`. Those words live in
Instantly, not in this repo, so no prompt change can make them true for a
business that has no website at all. 6,011 rows of the Australian list are in
that state.

Until this campaign exists and `INSTANTLY_NO_WEBSITE_CAMPAIGN_ID` is set,
`qualify.py` falls back to the campaign above and logs a warning, which means
those leads receive an email about a site they do not have.

- [ ] Create a second campaign in Instantly, paused.
- [ ] In Step 1, use this final email body:

```text
Hey {{firstName|there}}, I went looking for {{company_name}} online and couldn't
find a website anywhere. Anyone who hears about you and goes to check is landing
on a competitor instead.

I went ahead and put together what a site for you could look like: Check it out

If you want it, it's $1,499 flat. Domain, hosting, mobile-ready, local SEO basics.
Delivered in 2 weeks. If you hate it, tell me why and I'll fix it before you pay anything.

Macauley
```

- [ ] In the Step 1 editor, select only the words `Check it out` and set the link URL to `{{website_preview_url}}`.
- [ ] Do not mention Google Maps, reviews, rankings, social media or ad spend anywhere in this sequence. None of those are measured by the pipeline, and a business that does have a Google listing will read the claim as proof the email was machine-written.
- [ ] Copy the campaign id into `INSTANTLY_NO_WEBSITE_CAMPAIGN_ID` in the VPS `.env`.
- [ ] Restart the pipeline workers so the new variable is read.
- [ ] Confirm the pipeline logs no longer contain `INSTANTLY_NO_WEBSITE_CAMPAIGN_ID is unset`.

### 1c. Recalibrate the score threshold before the first live send

`QUALIFICATION_SCORE_THRESHOLD` is 35 on the VPS. That number was chosen
against `prompts/qualify-v1.txt`, whose rubric rewarded "construction/trades
industry" and penalised "not a tradie business". The live prompt is now
`qualify-v2`, which scores four different components. The same integer no
longer means the same thing, so carrying 35 forward is not keeping the
setting, it is changing it to a value nobody has measured.

- [ ] Run a shadow scoring pass. It calls Haiku only, writes nothing to the
      database, and sends nothing:

```bash
cd /root/printeriq/services/pipeline
python -m workers.shadow_qualify --tenant-id <tenant-uuid> --limit 300     --output /root/shadow-scores.csv
```

- [ ] Note what the sample is: the most recently imported enriched leads for that
      tenant, ordered `imported_at DESC, id DESC`, capped at 5,000. It is not a
      stratified draw, so in practice it is one import batch. If you need the
      cohorts compared separately, run it once per import.
- [ ] Open the CSV and plot the score distribution.
- [ ] Use the `lead_status` column to separate leads that already went through
      the old gate from fresh ones. Both are included on purpose, so v1 and v2
      can be compared on the same businesses, but mixing them in one
      distribution will mislead you.
- [ ] Hand-label roughly 60 rows with a yes/no on "would I want to sell to this business".
- [ ] Check where the no-website rows (`has_website` is `False`) land relative to the rest.
- [ ] Pick the threshold that gives acceptable precision **at the volume the mailboxes can actually send**. A threshold that qualifies 40,000 leads is not a generous threshold, it is an unused one.
- [ ] `score_threshold` travels per ingest job, not as a global constant, so the no-website import and the has-website import can run at different thresholds with no code change.

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

- [ ] Confirm the neutral business template's images exist. This template is the
      fallback for every industry no trade template claims, so a missing image
      here breaks the demo for the majority of the Australian list:

```bash
ls -lh /var/www/previews/assets/previews/business/hero.jpg
ls -lh /var/www/previews/assets/previews/business/fullbleed-1.jpg
ls -lh /var/www/previews/assets/previews/business/project-1.jpg
```

- [ ] If they are missing, download every path in `image-download-manifest.json`
      to `/var/www/previews`, then re-run
      `python scripts/verify-preview-assets.py --base-url https://preview.presciaiq.com`.
- [ ] The eight `business/` images are neutral placeholders reused from photos
      already in the manifest. Replace them with real photography before this
      template carries volume.

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

## Enabling preview view tracking

With open and click tracking switched off, a hit on a preview URL is the only
per-lead evidence that an email was delivered and read. It is recorded by an
nginx `mirror` on `preview.presciaiq.com` that posts to the reply-agent. The
mirror never delays or breaks the page: if any of the steps below are skipped,
previews still serve normally and only the tracking is missing.

1. Apply `database/migrations/0013_add_website_preview_view_tracking.sql`.
2. Set `PREVIEW_VIEW_SECRET` in the root `.env`, generated with
   `openssl rand -hex 32`, and restart the reply-agent so it picks it up:

```bash
pm2 restart reply-agent --update-env
```

3. Give nginx the same secret. It lives outside the repo so it never reaches
   git:

```bash
printf 'proxy_set_header X-Preview-View-Secret "%s";\n' "$PREVIEW_VIEW_SECRET" \
  > /etc/nginx/snippets/preview-view-secret.conf
chmod 600 /etc/nginx/snippets/preview-view-secret.conf
```

4. Deploy `nginx/preview.presciaiq.com.conf`, then:

```bash
nginx -t && systemctl reload nginx
```

Verification. Load a real preview in a browser, not with `curl`, because a
`curl` user agent is deliberately not counted:

```sql
SELECT lead_id, first_viewed_at, last_viewed_at, view_count
FROM website_previews
WHERE tenant_id = '<tenant_id>' AND preview_slug = '<preview_slug>';
```

- [ ] `view_count` is 1 and both timestamps are set.
- [ ] Reload the page. `view_count` is 2, `last_viewed_at` moves, and
      `first_viewed_at` does not.

If nothing is recorded, check the reply-agent log. The two lines worth looking
for are `preview view tracking disabled: missing ...`, which means the service
booted without the secret or `TENANT_ID`, and
`preview view rejected: reason=invalid_secret`, which means nginx and the
reply-agent hold different secrets.

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
