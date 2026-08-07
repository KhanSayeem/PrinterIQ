# PrinterIQ Claude Continuation Handoff

Date: 2026-08-07

This handoff is for taking PrinterIQ further in Claude from the current repo and
production state. It is intentionally detailed enough for a fresh agent to get
oriented without needing this Codex conversation. It redacts secrets and avoids
printing private runtime values.

## Start Here

- Repository: `PrinterIQ`
- Working checkout used for this handoff:
  `C:\Users\Hi\.codex\worktrees\771f\PrinterIQ`
- Protected checkout boundary: do not work in, clean, reset, stage, or switch
  `C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ`.
- Current local branch at handoff: `main`
- Current local state at handoff: clean
- Current remote issue state: no open GitHub issues
- Current remote PR state: no open GitHub PRs
- Current production deploy commit verified by SSH:
  `e21060bb0066c0e455ca70d51035b61ccf44080e`
- Latest successful deploy workflow:
  `https://github.com/KhanSayeem/PrinterIQ/actions/runs/30643569036`
- Production health verified on 2026-08-07:
  - PM2 `dashboard`, `pipeline`, and `reply-agent` online
  - Redis pipeline wait, active, delayed, dead queues all `0`
  - `https://dashboard.presciaiq.com/login` returns HTTP `200`

## Suggested Skills

- `handoff`: use for any next continuation handoff or Claude-to-Codex transfer.
- `diagnose` or `diagnosing-bugs`: use if production behavior differs from the
  expected lead pipeline.
- `chrome:control-chrome` or `computer-use:computer-use`: use if the next agent
  is allowed to inspect Instantly or dashboard UI directly.
- `github:github`: use for live GitHub issue/PR state if the backlog changes.
- `supabase`: use only for read-only inspection or precisely approved cleanup.

## Product Intent

PrinterIQ is intended to:

1. Get leads from Apollo CSV imports or the Outscraper shadow/prospect flow.
2. Enrich/audit the lead website.
3. Score and qualify the lead.
4. Generate a premade custom website preview.
5. Add the lead and preview variables to an Instantly campaign.
6. Let Instantly handle cold email sequence sending, tracking, replies,
   bounces, and unsubscribes.

The intended production pipeline path for lead CSV imports is:

```text
ingest_csv -> enrich_lead -> qualify_lead -> generate_preview -> schedule_outreach
```

The current system can run that path for a controlled test lead and successfully
add the lead to Instantly with preview variables. The remaining non-code blocker
seen in the latest UI is that the Instantly campaign sequence editor is blank,
so there is no email body to preview or send until the sequence copy is added in
Instantly.

## Hard Provider And Safety Boundaries

Preserve these until the operator explicitly changes them:

- Do not start Outscraper requests without explicit scope and spend ceiling.
- Do not spend Apollo credits without explicit approval.
- Do not promote prospects into leads without explicit approval.
- Do not generate website previews for live prospects without explicit approval.
- Do not schedule outreach to live prospects without explicit approval.
- Do not activate or launch an Instantly campaign unless explicitly approved.
- Do not mutate Instantly settings, campaigns, sending accounts, or live leads
  without explicit approval.
- Do not run destructive DB, Redis, storage, or provider cleanup without an exact
  target list approved by the operator.
- Instantly test-send from the campaign editor is separate from launching a
  campaign. A test-send is the safe way to inspect inbox rendering.

## Relevant Code And Docs

- `docs/operator-runbook.md`
  - SSH, PM2, deploy, dashboard pnpm setup, preview QA, and Instantly sequence
    checklist.
- `docs/adr/002-instantly-webhooks.md`
  - Instantly owns cold email sequence sending, reply routing, bounces, and
    unsubscribes.
- `docs/adr/004-outscraper-shadow-discovery.md`
  - Outscraper shadow discovery is isolated from leads/previews/Instantly.
- `docs/superpowers/specs/2026-05-29-website-preview-design.md`
  - Website preview architecture.
- `docs/superpowers/specs/2026-06-16-instantly-api-contract-fixes-design.md`
  - Instantly v2 API fixes and pause/move behavior.
- `docs/superpowers/handoffs/2026-07-31-lead-pipeline-readiness-handoff.md`
  - Prior readiness handoff before the controlled Instantly smoke.
- `services/pipeline/src/workers/ingest.py`
- `services/pipeline/src/workers/enrich.py`
- `services/pipeline/src/workers/qualify.py`
- `services/pipeline/src/workers/generate_preview.py`
- `services/pipeline/src/workers/schedule_outreach.py`
- `services/pipeline/src/clients/instantly_client.py`
- `services/reply-agent/src/webhook.ts`
- `services/reply-agent/src/escalation.ts`
- `services/dashboard/src/clients/instantly.ts`

## Recent Completed Work

### Issue #100

Issue #100 no-spend postmortem/calibration work was completed and closed in the
prior Codex session. The user later moved the project toward readiness and
pre-launch testing.

### Score Threshold Payload Repair

The qualification threshold contract was repaired and deployed. Important
behavior:

- `QUALIFICATION_SCORE_THRESHOLD` is server-side integer config.
- It must validate as `0..100`.
- It is carried explicitly as `score_threshold` through ingest, enrich, and
  qualify.
- Qualification rejects missing thresholds and does not hardcode a fallback.

Relevant merged work:

- PR #107 to `dev`: score-threshold repair
- PR #108 `dev` to `main`: deployed at commit
  `b2271002161f8c4b5b51ff331b3b4c5dd395f100`

### Issue #24

Issue #24 was completed and closed after a controlled smoke with the operator's
approved Instantly campaign ID and a test recipient. Synthetic smoke artifacts
from the first Issue #24 smoke were later deleted with explicit approval.

### Dashboard Action Error Handling

PR #68 was resolved, merged to `dev`, promoted by PR #109 to `main`, and
deployed at `738478c37db73dfec01f462b248fc2f8db16b14a`.

### Qualification JSON Fence Repair

A later controlled smoke exposed a real parser issue: Claude returned valid JSON
inside Markdown code fences and `qualify_lead` rejected it. The pipeline parser
was patched to strip a surrounding fence before JSON parsing.

Relevant merged work:

- PR #110 to `dev`: `Fix fenced qualification JSON parsing`
- PR #111 `dev` to `main`: `Promote qualification JSON parser repair`
- Production deploy run:
  `https://github.com/KhanSayeem/PrinterIQ/actions/runs/30643569036`
- Production deployed commit:
  `e21060bb0066c0e455ca70d51035b61ccf44080e`

Verification recorded for the parser repair:

- `python -m pytest services/pipeline/tests/test_qualify.py`
- `python -m ruff check services/pipeline`
- `python -m mypy --config-file services/pipeline/pyproject.toml services/pipeline/src`
- `python -m pytest services/pipeline/tests`
- PR checks: Dashboard, Python, Reply Agent

## Controlled Modern Body Method Smoke

The operator approved a one-lead pre-launch drill for:

- Website: `https://modernbodymethod.com/`
- Recipient: owned PresciaIQ mailbox, redacted in this committed handoff
- Instantly campaign:
  `e8ef5219-5308-401f-9489-9ab74c480e54`
- Campaign name observed:
  `PrinterIQ Dev Preview Smoke`
- Campaign status observed:
  `0`, shown in UI as Draft/paused

What was tested:

- One owned test lead was created/resumed in production DB.
- Website enrichment ran.
- Qualification ran with `score_threshold=0` intentionally, so the drill could
  reach preview/outreach plumbing even though the business is outside the normal
  tradie target.
- Preview generation ran.
- `schedule_outreach` added the lead to the paused Instantly campaign.
- No campaign was launched.
- No live prospect was used.
- No Outscraper or Apollo calls were made for this drill.
- No inbox email was delivered because the campaign stayed Draft/paused.

Smoke evidence:

- Campaign preflight passed: status `0`, campaign name
  `PrinterIQ Dev Preview Smoke`.
- Lead status in PrinterIQ became `contacted`. In this code path, the
  `outreach_sends.sent_at` timestamp means "successfully added to Instantly",
  not "an email landed in the inbox".
- Instantly synthetic lead exists and readback returned HTTP `200`.
- Instantly payload readback fields include:
  - `website_preview_url`
  - `preview_url`
  - `weakness`
  - `opener`
  - `followup_1`
  - `followup_2`
  - `lead_id`
- Preview page:
  `https://preview.presciaiq.com/p/y0ubWHHzg8-iebSdGpMNwEf3PXuqsJgu/`
- Preview HTTP check:
  - status `200`
  - contains business name
  - `X-Robots-Tag: noindex, nofollow, noarchive`
- Template used: `general`
- Qualification score: `12`
- Qualification top weakness:
  `Wrong industry vertical - wellness/pilates, not trades/construction`

Synthetic artifact cleanup targets from this smoke:

- Instantly lead ID:
  `019fb8d4-d5a5-7ae9-8dc1-191750606340`
- DB lead ID:
  `cef92936-0f90-4d4c-a8b6-36e70ae0d1f8`
- DB enrichment ID:
  `e2250e64-1cbb-41b0-8442-21764cf0383a`
- DB qualification ID:
  `e936ffe7-c4e6-4929-a013-55004a7f49c3`
- DB preview ID:
  `51512858-53f8-4230-b987-4b9836227ed5`
- DB outreach send ID:
  `dbeaac78-3377-49e3-aee1-37fc7099ba07`
- Preview slug:
  `y0ubWHHzg8-iebSdGpMNwEf3PXuqsJgu`

Do not delete these unless the operator explicitly approves this exact target
set or a narrower target set.

## Current Instantly UI Situation

The operator checked the Instantly campaign and saw:

- Leads tab has exactly the synthetic owned test lead.
- Editor tab is blank: no subject/body sequence copy is configured.
- Clicking Launch opens a warning modal saying sending will begin immediately.

Therefore:

- Do not click Launch for testing.
- Add sequence copy in the Editor first.
- Save while the campaign remains Draft/paused.
- Use Instantly's Preview/Test Email flow to send a test message to the owned
  mailbox.
- Do not activate campaign sending until the operator explicitly approves a
  live launch.

## Instantly Sequence Copy To Configure

The campaign editor must be populated manually in Instantly. Use the fields as
Instantly exposed them on lead readback: `firstName`, `companyName`,
`website_preview_url`, `weakness`, `followup_1`, and `followup_2`. Verify the
actual variable names in Instantly's variable picker before saving if the UI
shows a different naming convention.

Step 1 subject:

```text
Quick preview for {{companyName}}
```

Step 1 body:

```text
Hey {{firstName}}, spotted {{companyName}}'s site and noticed {{weakness}}.

That's quietly costing you leads every week.

I went ahead and put together what your site could look like: Check it out

If you want it, it's $1,500 flat. Domain, hosting, mobile-ready, local SEO basics.
Delivered in 2 weeks. If you hate it, tell me why and I'll fix it before you pay anything.

Macauley
```

In the Step 1 editor, highlight only `Check it out` and set the link URL to:

```text
{{website_preview_url}}
```

Do not paste the raw preview URL into visible body text.

Follow-up 1 body:

```text
Hey {{firstName}}, just checking you got a chance to look at the preview.
Happy to tweak anything to match your branding or services. Still $1,500 all in.
```

Follow-up 2 body:

```text
Last nudge from me. Offer's open if the timing works. No pressure.
```

QA before any live launch:

- Preview the lead in Instantly with the owned test recipient.
- Send a test email to the owned mailbox only.
- Confirm `Check it out` is a clickable hyperlink.
- Confirm the email does not display a raw preview URL.
- Confirm the link opens the generated preview.
- Confirm no em dashes or double-hyphen substitutes appear in the subject/body.
- Confirm the campaign remains Draft/paused after testing.

## Known Gaps And Recommendations

1. Instantly sequence copy is not configured.
   This is the immediate next blocker for inbox rendering.

2. Variable naming should be standardized.
   The runbook currently uses snake_case examples like `{{first_name}}` and
   `{{company_name}}`, while the Instantly readback payload showed camelCase
   fields like `firstName` and `companyName`. Update
   `docs/operator-runbook.md` after verifying the exact variable names in the
   Instantly UI.

3. `outreach_sends.sent_at` naming is operationally misleading.
   In the current pipeline it records when PrinterIQ successfully added a lead
   to Instantly, not when Instantly delivered the email. Consider a future
   migration/rename or dashboard copy adjustment, but do not run a DB migration
   without a scoped plan and approval.

4. The tested Modern Body Method lead is deliberately out of target.
   The qualification score was `12`, so a normal threshold should not send it.
   Use a tradie/construction test lead for a more representative pre-launch
   smoke after the Instantly editor is configured.

5. Cleanup remains pending.
   Synthetic Modern Body Method DB and Instantly artifacts are still present for
   operator inspection. Cleanup requires exact approval.

6. Launch gating needs an explicit go/no-go.
   Even when email rendering works, do not activate the campaign until inbox
   warmup, sending accounts, copy, links, reply routing, bounce/unsubscribe
   behavior, and compliance gates are all reviewed.

## Verification Commands To Re-run

Local repo checks:

```powershell
git status --short --branch
python -m pytest services/pipeline/tests
python -m ruff check services/pipeline
python -m mypy --config-file services/pipeline/pyproject.toml services/pipeline/src
```

Dashboard checks, if touching dashboard:

```powershell
cd services/dashboard
corepack pnpm@10.18.3 install --frozen-lockfile
corepack pnpm@10.18.3 test
corepack pnpm@10.18.3 run typecheck
corepack pnpm@10.18.3 run lint
corepack pnpm@10.18.3 run build
```

Production read-only health:

```bash
ssh root@170.64.143.200
cd /root/printeriq
git rev-parse HEAD
pm2 status
redis-cli LLEN bull:pipeline:wait
redis-cli LLEN bull:pipeline:active
redis-cli LLEN bull:pipeline:delayed
redis-cli LLEN bull:pipeline:dead
```

Dashboard HTTP:

```powershell
curl.exe -I https://dashboard.presciaiq.com/login
```

## Claude Kickoff Prompt

Use this as the first message to Claude:

```text
You are taking over PrinterIQ from a committed Codex handoff.

Repository: PrinterIQ
Start by reading:
- docs/superpowers/handoffs/2026-08-07-claude-project-continuation-handoff.md
- docs/operator-runbook.md
- docs/adr/002-instantly-webhooks.md
- docs/adr/004-outscraper-shadow-discovery.md
- docs/superpowers/specs/2026-05-29-website-preview-design.md
- docs/superpowers/specs/2026-06-16-instantly-api-contract-fixes-design.md

Then inspect live repo state with:
- git status --short --branch
- git log -1 --oneline
- gh issue list --state open --limit 50
- gh pr list --state open --limit 50

Protected boundary:
Do not work in, clean, reset, stage, or switch
C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ.
Use the current clean worktree or a fresh worktree.

Provider boundaries:
Do not run Outscraper requests, spend Apollo credits, promote prospects into
leads, generate previews for live prospects, schedule live outreach, activate
campaigns, mutate Instantly, or run destructive cleanup without explicit
operator approval with exact scope and spend/target limits.

Current verified production baseline:
- main deploy commit e21060bb0066c0e455ca70d51035b61ccf44080e
- latest successful deploy run 30643569036
- dashboard, pipeline, reply-agent online
- pipeline Redis wait/active/delayed/dead queues zero
- dashboard /login returns HTTP 200
- no open GitHub issues or PRs at handoff creation

Immediate focus:
Get properly familiar with the project and help finish safe pre-launch readiness.
The current blocker is not code: the Instantly campaign editor is blank, so
the owned test lead was added to the paused/Draft campaign but no email was
sent. The next work should configure or guide configuration of the Instantly
sequence copy, verify variable names, use Preview/Test Email only, and keep the
campaign Draft/paused. Do not click Launch.

Important nuance:
PrinterIQ DB outreach_sends.sent_at currently means successfully added to
Instantly, not email delivered. The Modern Body Method smoke lead scored 12 and
was forced through with score_threshold=0 only to test plumbing; it is not a
representative live lead.

Before making any change, state what you verified from current repo/live state
and what remains memory/handoff-derived. Keep all secrets redacted.
```

