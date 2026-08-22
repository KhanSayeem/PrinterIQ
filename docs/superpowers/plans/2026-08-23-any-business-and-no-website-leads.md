# Any-Business Qualification and No-Website Leads Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD is mandatory for every task that touches qualifier logic, per `CLAUDE.md`.

**Status:** plan only. No production code has been written, no PR opened, nothing deployed.

**Goal:** Stop the pipeline throwing away the two largest groups of good prospects in the new 900k database: businesses with no website at all (165,675 of them), and businesses that are not tradies (95.8% of the database).

**Two independent problems, one shared consequence.** Both end in the same place: `leads.status = 'archived'`, no email sent, no revenue. They are separable and should be shipped in the order below, because Problem 2 changes the meaning of the score and Problem 1 depends on the score to get through the gate.

**Tech stack touched:** Python 3.12 pipeline workers, `prompts/*.txt`, pytest. Small doc changes. No database migration required.

---

## Part 0: What I confirmed by reading the code

Every claim below was traced in this worktree. Line references are current as of this branch.

### Problem 1: the no-website path, in pipeline order

There are **five** places a no-website lead dies, not four. The first one is earlier than expected and is the hardest blocker.

1. **`services/pipeline/src/workers/ingest.py:109-120`**: `_missing_required_fields()` lists `"Website"` as a required column. A CSV row with a blank Website is counted as `rejected_rows` and never becomes a lead at all. **The 165,675 no-website businesses would not even reach the database.** This is the true first gate and the brief did not mention it.

2. **`services/pipeline/src/workers/enrich.py:52-62`**: `website_url = str(lead.get("website_url", ""))` then `audit = await auditor.audit(website_url)`, with no guard for an empty string. Confirmed.

3. **`services/pipeline/src/clients/playwright_audit.py:44-46`**: `page.goto("")` with no short-circuit. The Playwright error is caught at line 121 (`except _PlaywrightError`) and returns `_unreachable()`. Confirmed.

4. **`services/pipeline/src/clients/playwright_audit.py:150-165`**: `_unreachable()` returns `"has_site": True` and `"weaknesses": []`. For a business with no site, `has_site: True` is simply false, and the empty weaknesses array is the payload that kills the lead. Confirmed.

5. **`services/pipeline/src/workers/qualify.py:176-178`**: `has_actionable_weakness = bool(grounded_weaknesses)`, and lines 206-216 archive the lead when that is `False`. Confirmed.

So today a no-website business is either rejected at ingest, or (if it somehow gets in) is recorded as a business that *has* a site which *happens to be unreachable*, with nothing wrong with it, and is archived. The record is wrong and the outcome is wrong.

### Problem 2: the tradie assumption

Every place the word appears that actually changes behaviour:

| File | What it says | Effect |
|---|---|---|
| `prompts/qualify-v1.txt:1-2` | "a done-for-you website service for Australian tradies" | Frames the whole scoring task |
| `prompts/qualify-v1.txt:4` | High score signal: "construction/trades industry" | Rewards 4.2% of the new database |
| `prompts/qualify-v1.txt:5` | Low score signal: "not a tradie business" | Punishes 95.8% of the new database |
| `prompts/opener-v2.txt:1-2` | "for Australian tradies" | Copy voice |
| `prompts/opener-v2.txt:34` | "plain language a tradie understands" | Copy voice |
| `prompts/preview-personalise-v1.txt:3-4, 36` | "Services must reflect the trade implied by industry and keywords" | **Generates six fake trade services for a cafe** |
| `prompts/reply-agent-v1.txt:1` | "for Australian tradies" | Reply voice |
| `services/pipeline/src/templates/previews/general.html` | See below | **The preview itself is a trades site** |
| `services/pipeline/src/workers/orchestrator.py:248, 457` | `vertical` defaults to `"tradies"` | Cosmetic, stored on the lead row |
| `database/schema.sql:43` | `vertical TEXT DEFAULT 'tradies'` | Cosmetic default |
| `CLAUDE.md` | Product described as for Australian tradies | Instructs every future agent |

**The most damaging finding is not in a prompt.** `services/pipeline/src/templates/previews/general.html` is named "general" but is a trades template. Its `<title>` reads "Local Trades & Services", and the page body contains "Fully Licensed", "Licensed & Insured", "Free Quotes", "Get a Free Quote", and trade-site hero photography, all hard-coded. `select_template_key()` in `generate_preview.py:221-227` falls back to this template for anything that is not one of the five trades.

That means: **today, if you point the pipeline at a cafe, the "here is what your site could look like" preview you email them is a licensed-tradesman website.** That is worse than sending nothing. Fixing the prompts without fixing this template would produce well-scored leads receiving an embarrassing demo.

### Two configuration discrepancies worth resolving before anything else

- `.env.example:19` sets `QUALIFICATION_SCORE_THRESHOLD=40`. The brief describes the threshold as 35. Nobody can reason about recalibration without knowing the number actually deployed on the VPS. **Operator: confirm the live value.**
- `prompts/opener-v2.txt` and the Instantly sequence in `docs/operator-runbook.md:322-346` are not the same copy. The prompt uses `{price_aud}`; the runbook still hard-codes `$1,500`. The runbook copy is what Instantly actually sends.

---

## Part 1: Decisions I am making, with reasoning

### Decision 1: add `no_website` to the canonical vocabulary. Recommended: YES.

`services/pipeline/src/weaknesses.py` carries its own rule: *"Every value here must correspond to a signal that is actually measured by a website auditor. Do not add a label here unless something in the codebase measures it."*

**The case against adding it:** no auditor measures it. Playwright cannot observe the absence of a URL, because it is never handed one. "Weakness" also implies a defect *of a site*, and there is no site to have a defect.

**The case for adding it:** absence of a URL is measured, and measured more reliably than any signal in the current list. `no_h1` depends on a page load succeeding, a render completing, and a selector matching. `no_website` depends on reading one column of the lead row. It is the *least* inferential item in the vocabulary. The vocabulary's real purpose, stated one paragraph up in the same docstring, is to let `qualify.py` "validate a Claude-generated `weakness_label` against what was actually measured", so that customer-facing copy never asserts an unobserved problem. A no-website lead needs exactly that protection, because copy will be written about it.

**Decision: add it, and correct the docstring** from "measured by a website auditor" to "measured by an enrichment producer", with `workers/enrich.py` named as the producer for this one label. The enrich worker is the only component that sees the lead row, so it is the only component that can measure this honestly.

**The alternative I rejected:** leave the vocabulary closed and widen the gate instead, to `has_actionable_weakness = bool(weaknesses) or enrichment["has_site"] is False`. Rejected because it only moves the problem. The grounding gate at `qualify.py:225` would then have no label to bind to, so it would need a special case; the opener prompt would receive an empty `top_weakness`, so it would need a special case; and the "never assert an unmeasured problem" rule would lose its single enforcement point. Adding one label keeps one gate, one rule, one code path.

### Decision 2: where the label is emitted. Recommended: in `enrich.py`, not `playwright_audit.py`.

The auditor gets a short-circuit for a blank URL as a safety net (any future caller is protected), but the authoritative decision lives in `enrich_lead`, which reads the lead row. The auditor is never called at all for a lead with no URL. This also saves 165,675 browser launches.

### Decision 3: a separate copy path for no-website leads. Recommended: a new prompt file, not a branch inside `opener-v2.txt`.

`opener-v2.txt:52` hard-codes the structure: *"spotted [business name]'s site and noticed [specific weakness]"*. There is no wording of that sentence that is true for a business with no site.

A new `prompts/opener-nosite-v1.txt`, selected in `qualify.py` when `weakness_label == "no_website"`, is preferable to conditional instructions inside one prompt because:
- The site path keeps working untouched, which is a hard constraint of this work.
- `qualifications.prompt_version` then records which copy path ran, so the two can be compared in the dashboard.
- Prompt files stay readable. A prompt with two mutually exclusive halves is where models start blending the halves.

### Decision 4: a separate Instantly campaign for no-website leads. Recommended: YES.

- The Instantly Step 1 template (`docs/operator-runbook.md:322`) opens with `spotted {{company_name}}'s site and noticed {{weakness}}`. That sentence is in the Instantly sequence, not in our code, so it is fixed for every lead in that campaign. A no-website lead cannot share it.
- Reply rate, bounce rate and unsubscribe rate are reported per campaign in Instantly. This is the only cheap way to learn whether no-website leads convert better, which is the whole premise.
- The mechanism already exists. `campaign_id` flows through the payload from `qualify` to `generate_preview` to `schedule_outreach` (`qualify.py:307`, `generate_preview.py:180`, `schedule_outreach.py:96`), with an env fallback. Selecting a different campaign id for these leads is a few lines, not an architecture change.

### Decision 5: what the score should reward instead of industry.

The operator's goal is to sell as many websites as possible. Industry is not what predicts a sale. Four things do, and the new prompt should name them explicitly so the rationale field becomes auditable rather than a vibe.

| Component | Points | What earns them |
|---|---|---|
| **Website opportunity** | 0-45 | No website at all: 45. Two or more measured weaknesses: 35. One measured weakness: 25. Domain exists but does not load: 20. Reachable site with nothing measurably wrong: 5. |
| **Contactability** | 0-25 | Verified email plus a phone number: 25. Verified email only: 15. Unverified or catch-all email: 5. No usable contact: 0. |
| **How much a website drives this business's revenue** | 0-20 | High (20): customers search, compare, and choose before making contact. Trades, health and allied health, legal, accounting and professional services, tutoring, events, beauty, real estate, automotive repair. Medium (12): gets walk-in or aggregator traffic but still converts on a site. Cafes, restaurants, retail, gyms, tourism, accommodation. Low (4): customers never look them up. Wholesale, contract manufacturing, government-contracted suppliers, franchise outlets already covered by a national brand site. |
| **Live and independent business** | 0-10 | A named human contact, a plausible local address, not a directory or marketplace, not a franchise outlet, not an obviously defunct listing. |

Note what survives from the old prompt and what does not. "Not a tradie business" goes entirely. "Directory or referral platform" stays, because a directory genuinely does not want a $1,499 brochure site.

**Being straight about the example lead:** the lead that scored 28 had the rationale *"Business model does not match tradie profile. This is a directory/referral platform, not a tradie service provider."* Half of that rationale was the bug. The other half is a judgement the new rubric deliberately keeps. Under the new scoring that lead would score better but might still land low. If the operator wants to sell to directories and marketplaces too, that is a separate instruction and should be said out loud rather than assumed.

### Decision 6: does copy adapt per industry? Recommended: generic voice, industry-aware nouns. One prompt, not many.

A cafe and an accountant do want different things from a website. But the opener is five lines long, and the thing that differs between them is one noun and one clause about what the site is for, not the whole email. Maintaining a copy matrix across dozens of industries means dozens of prompt files, dozens of QA passes, and dozens of chances for the grounding rule to be dropped from one of them.

**Mechanism:** keep one opener prompt per branch (site / no-site). Pass `industry` and `keywords`, which are already on the lead row and already in `lead_json`, and instruct the model to name in one clause what a website does *for this kind of business*. The model adapts; the file count does not grow.

**Where per-industry work does pay for itself is the preview page**, because that is the actual product demo and it is the thing the reader clicks. See Task 10. Food, Hospitality and Travel is 25.6% of the new database, which makes one hospitality template worth more than every prompt variant combined.

---

## Part 2: The plan

Ordered so that each task is reviewable alone, and so that nothing is sent to a real prospect until the copy and the preview are both correct for them.

### Phase A: make the score mean the right thing (Problem 2)

#### Task 1: Rewrite `qualify-v1.txt` as `qualify-v2.txt`

- [ ] **Files:** create `prompts/qualify-v2.txt`; modify `services/pipeline/src/clients/claude_client.py` (`_MODEL_MAP`, add `"qualify-v2": "claude-haiku-4-5-20251001"`); modify `services/pipeline/src/workers/qualify.py` (`_HAIKU_PROMPT = "qualify-v2"`).
- [ ] **Tests first** (`services/pipeline/tests/test_qualify_prompt.py`):
  - `test_qualify_v2_prompt_does_not_mention_trades_or_tradies`: asserts neither word appears, case-insensitive.
  - `test_qualify_v2_prompt_names_the_four_scoring_components`: asserts the prompt names website opportunity, contactability, website dependence, and live-business signals.
  - `test_qualify_v2_prompt_still_grounds_weakness_label_in_enrichment_data`: port the existing grounding assertions verbatim from the v1 test so the rule cannot be lost in the rewrite.
  - `test_qualify_v2_prompt_does_not_ask_the_model_to_judge_actionability`: port from v1.
  - `test_qualify_v2_prompt_bans_dash_substitutes`: port from v1.
  - `test_qualify_v2_uses_haiku_model`.
  - Keep the v1 tests and the v1 file in place until Task 8 retires them, so a rollback is one constant.
- [ ] **Why a new file rather than editing v1:** `prompt_version` is written to every `qualifications` row. Editing v1 in place makes every historical row unreadable, because you can no longer tell which wording produced which score. The versioned-filename rule in `CLAUDE.md` exists for exactly this.
- [ ] **Risk if wrong:** the score distribution shifts and nobody notices, so the threshold silently admits junk or rejects everything. Task 3 exists to catch this before any send. Do not deploy Task 1 to a live sending campaign without Task 3.

#### Task 2: De-tradie the remaining prompts

- [ ] **Files:** create `prompts/opener-v3.txt` (copy of v2 with tradie framing replaced and the industry-aware clause added); create `prompts/preview-personalise-v2.txt`; modify `claude_client.py` `_MODEL_MAP` for both; modify `qualify.py` (`_SONNET_PROMPT`, `_PROMPT_VERSION`) and `generate_preview.py` (`_PROMPT_VERSION`).
- [ ] `prompts/reply-agent-v1.txt` is **deferred to Task 11** and flagged below. The file sits at repo root, but it is read by `services/reply-agent`, which another agent is currently editing.
- [ ] **Tests first:**
  - `test_opener_prompt.py`: `test_opener_v3_prompt_does_not_assume_a_trade_audience`; `test_opener_v3_prompt_asks_for_industry_appropriate_framing`; and port all existing v2 assertions, especially `test_opener_v2_prompt_grounds_weakness_sentence_in_enrichment_data` and the `{preview_url}` literal-substring assertions, which are load-bearing for the Instantly link.
  - `test_preview_prompt.py`: `test_preview_personalise_v2_does_not_require_trade_services`: asserts the phrase "reflect the trade" is gone and that the prompt asks for services matching the business type; `test_preview_personalise_v2_still_requires_exactly_six_services` (the `_PERSONALISATION_SCHEMA` in `generate_preview.py` hard-requires exactly six, and a rewrite that loosens the prompt will dead-letter every preview).
- [ ] **Risk if wrong:** the preview personalisation schema is strict (exactly six services, `year_founded` between 1995 and 2018, no dashes anywhere). A looser prompt raises `DeadLetterError` on every preview and stalls the queue. The six-services test is the guard.

#### Task 3: Build the shadow-scoring harness and recalibrate the threshold

**This is the most important task in the plan and the easiest to skip.**

The threshold is currently a number that was chosen against the old, tradie-biased prompt. After Task 1 the same integer means something different. A lead scoring 42 under v1 and a lead scoring 42 under v2 are not comparable; they are two different measurements that happen to share a numeral. Carrying the old threshold forward is not "keeping the setting", it is changing the setting to an unknown value.

- [ ] **Files:** create `services/pipeline/src/workers/shadow_qualify.py` (or extend the existing shadow-review pattern already used by `prepare_shadow_review.py`); create `services/pipeline/tests/test_shadow_qualify.py`.
- [ ] **Hard requirement:** the harness calls Haiku only. It must not call Sonnet, must not write to `qualifications`, must not change `leads.status`, and must not enqueue anything. Output is a CSV the operator can open.
- [ ] **Tests first:**
  - `test_shadow_qualify_never_calls_sonnet`.
  - `test_shadow_qualify_never_changes_lead_status`.
  - `test_shadow_qualify_never_enqueues_downstream_jobs`.
  - `test_shadow_qualify_is_tenant_scoped` (then invoke `db-reviewer`, per `CLAUDE.md`).
  - `test_shadow_qualify_writes_score_and_rationale_per_lead`.
- [ ] **Sample design:** 300 leads, stratified into three groups of 100. (a) Leads already scored under v1, so v1 and v2 can be plotted against each other on the same businesses. (b) No-website leads. (c) A random draw from the new database spanning its top five industry categories.
- [ ] **The calibration itself is the operator's judgement, not the model's.** The operator hand-labels roughly 60 of the 300 with a yes/no on "would I want to sell to this business". Then pick the threshold that gives acceptable precision at the volume you can actually send.
- [ ] **The real constraint is send capacity, not model opinion.** If the mailboxes can send 200 a day, the threshold's job is to produce roughly 200 qualified leads a day. A threshold that qualifies 40,000 leads is not a generous threshold, it is an unused one.
- [ ] **Useful existing affordance:** `score_threshold` already travels per ingest job (`ingest.py:52`, `orchestrator.py:249`), not as a global constant. The no-website import and the has-website import can run at different thresholds with no code change at all. Worth using.
- [ ] **Risk if skipped:** this is the failure mode where everything looks healthy. Clean logs, green tests, jobs completing, and either an empty outreach queue or thousands of emails to businesses nobody vetted. Neither is visible from the dashboard until the damage is done.

### Phase B: let no-website leads into the system (Problem 1)

#### Task 4: Add `no_website` to the canonical vocabulary

- [ ] **Files:** modify `services/pipeline/src/weaknesses.py` (add `NO_WEBSITE = "no_website"`; amend the class and module docstrings to say "enrichment producer" rather than "website auditor", and name `workers/enrich.py` as the producer for this label).
- [ ] **Tests first** (`services/pipeline/tests/test_weaknesses.py`):
  - Update `test_canonical_weakness_labels_match_the_documented_set` to include `no_website`.
  - Update `test_canonical_vocabulary_is_still_the_producer_contract` likewise, keeping the `"none" not in WEAKNESS_LABELS` assertion.
  - Add `test_no_website_label_is_produced_by_the_enrich_worker`: asserts `enrich` references `Weakness.NO_WEBSITE`, documenting that this one label has a different producer from the rest.
- [ ] **Risk if wrong:** `enrich.py:97-101` filters audit output against `WEAKNESS_LABELS`. If the label is emitted before it is added to the frozenset, it is silently dropped and the lead archives with an empty array, which looks identical to the bug being fixed. Vocabulary first, emission second, in this order.

#### Task 5: Give the enrich worker a real no-site path

- [ ] **Files:** modify `services/pipeline/src/workers/enrich.py`.
- [ ] **Behaviour:** when `lead["website_url"]` is missing, empty or whitespace, skip the auditor entirely and build the enrichment row directly: `has_site: False`, `is_reachable: False`, every measured boolean and `load_ms` left as `None` (nothing was measured, so nothing is claimed), `weaknesses: ["no_website"]`, `raw_audit: {}`. `tech_source` is `NOT NULL` in the schema, so set `"no_site"`, or `"no_site+apollo"` when Apollo `technologies` data is present. Everything downstream is unchanged: same enrichment insert, same status update to `enriched`, same qualify enqueue.
- [ ] **Tests first** (`services/pipeline/tests/test_enrich.py`, using the existing `FakeAuditor`):
  - `test_blank_website_url_never_calls_the_auditor`: asserts `FakeAuditor.calls == []`. This is both a correctness test and 165,675 saved browser launches.
  - `test_blank_website_url_records_has_site_false`.
  - `test_blank_website_url_records_the_no_website_weakness`.
  - `test_blank_website_url_leaves_unmeasured_signals_null`: `has_h1`, `has_ssl`, `load_ms`, `is_mobile_friendly`, `has_meta_title`, `has_meta_description` all `None`. This is the grounding rule expressed as data.
  - `test_whitespace_only_website_url_is_treated_as_no_website`.
  - `test_present_website_url_still_calls_the_auditor`: the regression guard on the working path.
  - `test_blank_website_url_still_enqueues_qualify_with_score_threshold`.
- [ ] **Risk if wrong:** an over-broad blank check (for example treating `"n/a"`, `"-"` or `"none"` as blank) would reroute real websites into the no-site path and generate copy telling a business with a site that they have no site. Keep the check to empty-after-strip only, and handle placeholder strings as a separate, later decision if the data turns out to need it.

#### Task 6: Defensive short-circuit in the auditor

- [ ] **Files:** modify `services/pipeline/src/clients/playwright_audit.py`.
- [ ] **Behaviour:** at the top of `audit()`, before launching a browser, return a `_no_site()` result for a blank or whitespace URL: `has_site: False`, `is_reachable: False`, `weaknesses: [Weakness.NO_WEBSITE]`, everything else `None` or empty. `_unreachable()` is left exactly as it is (see the note below).
- [ ] **Tests first** (`services/pipeline/tests/test_playwright_audit.py`):
  - `test_blank_url_returns_no_site_without_launching_a_browser`.
  - `test_unreachable_still_reports_has_site_true`: an explicit regression guard, so nobody "tidies" the two paths into one.
- [ ] **Why `_unreachable()` keeps `has_site: True`:** a URL that exists but fails to load is evidence of a site that is broken, not evidence of no site. Merging the two would replace one wrong record with a different wrong record. Leave it.
- [ ] **Risk if wrong:** low. `enrich.py` never calls the auditor with a blank URL after Task 5, so this is a safety net for future callers.

#### Task 7: Let no-website rows through ingest

- [ ] **Files:** modify `services/pipeline/src/workers/ingest.py` (`_missing_required_fields`, remove `"Website"` from the required set).
- [ ] **Tests first** (`services/pipeline/tests/test_ingest.py`):
  - `test_row_without_website_is_accepted_and_inserted`.
  - `test_row_without_website_still_enqueues_enrich_with_score_threshold`.
  - `test_row_without_email_is_still_rejected`: the remaining required fields must not be loosened by accident.
  - `test_row_without_website_stores_empty_website_url`: the empty string is what Task 5 keys on, so the contract between ingest and enrich needs a test of its own.
- [ ] **Risk if wrong:** the Website column was doing double duty as a junk filter. Removing it admits more low-quality rows. This is acceptable because the empty column is now a scoring *signal* rather than a rejection, and the score gate catches the junk. Watch `rejected_rows` versus `inserted_rows` on the first real import and compare against expectation.
- [ ] **Open question, flagged for the operator:** `_lead_from_apollo_row` is hard-coded to Apollo's exact column headers (`"Company Name"`, `"Mobile Phone"`, `"Apollo Contact Id"`, and so on). If the new 900k database is not an Apollo export, **every row will be rejected for missing required fields and the cause will look like a data problem rather than a mapping problem.** One sample file is needed before this task can be considered finished. See Operator Decision 5.

#### Task 8: The no-website copy path

- [ ] **Files:** create `prompts/opener-nosite-v1.txt`; modify `claude_client.py` `_MODEL_MAP` (add it against the Sonnet model); modify `services/pipeline/src/workers/qualify.py` to select the prompt and record the matching `prompt_version`.
- [ ] **`weakness_sentence` for these leads.** It must still slot in after "I noticed ", so: lower case start, no trailing full stop. The measured fact is that no website could be found. The prompt must permit the *consequence* of that fact and nothing else. `opener-v2.txt:35` already sanctions consequence framing ("and where useful, its consequence for the business"), so this is not a new licence.
  - Good: `couldn't find a website for you anywhere, so people who look you up find your competitors instead`
  - Banned, and must be named as banned in the prompt: any claim about Google Maps, reviews, rankings, social media, or ad spend. None of those are measured. This is the same failure the existing grounding rule exists to prevent, and a no-site lead is where a model is most tempted to invent, because there is so little to talk about.
- [ ] **Tests first:**
  - `test_qualify_prompt.py`: `test_opener_nosite_prompt_never_claims_the_lead_has_a_site`: asserts the phrases "your site", "your website" and "had a look at" do not appear in the instruction body; `test_opener_nosite_prompt_bans_unmeasured_claims`: asserts Maps, reviews and rankings are explicitly named as off limits; `test_opener_nosite_prompt_requires_the_preview_url_literal`: the `[Check it out]({preview_url})` substring rule must survive into the new prompt or the email ships without its only link.
  - `test_qualify.py`: `test_no_website_lead_uses_the_nosite_opener_prompt`; `test_site_lead_still_uses_the_standard_opener_prompt` (regression guard); `test_no_website_lead_persists_the_nosite_prompt_version`; `test_no_website_weakness_label_passes_the_grounding_gate`: proves `"no_website"` in `["no_website"]` passes `qualify.py:225` with no special casing, which is the whole payoff of Decision 1.
- [ ] **Risk if wrong:** this is the task where a fabricated claim reaches a real inbox. The banned-claims test is not optional.

#### Task 9: Route no-website leads to their own Instantly campaign

- [ ] **Files:** modify `services/pipeline/src/workers/qualify.py` (`_campaign_id`); modify `.env.example` and `.env.test.example` (add `INSTANTLY_NO_WEBSITE_CAMPAIGN_ID`); modify `docs/operator-runbook.md` (a second sequence block, and the fix described below).
- [ ] **Behaviour:** `qualify` picks the campaign id when it enqueues `generate_preview`, based on whether this lead's weakness is `no_website`. An explicit `campaign_id` in the incoming payload still wins, as it does today. Downstream workers are untouched, because `campaign_id` already flows through the payload.
- [ ] **The runbook change is the part that actually reaches customers.** The Instantly Step 1 template at `docs/operator-runbook.md:322` reads `Hey {{first_name}}, spotted {{company_name}}'s site and noticed {{weakness}}.` The words "spotted ... 's site and noticed" live in Instantly, not in our code, so no prompt change can fix them. Two changes are needed:
  1. A second sequence block in the runbook for the no-website campaign, whose Step 1 does not mention an existing site.
  2. Recommended for both campaigns: move the whole opening clause into `{{opener}}` so the Instantly template stops asserting anything about the site and our grounded copy owns the entire sentence. One template that says nothing is safer than two templates that each assert something.
  - While editing: the runbook still hard-codes `$1,500` at lines 328 and 340, while the prompts use `{price_aud}` and the offer is $1,499. Fix it in the same pass.
- [ ] **Tests first** (`test_qualify.py`):
  - `test_no_website_lead_enqueues_the_no_website_campaign_id`.
  - `test_site_lead_enqueues_the_default_campaign_id`.
  - `test_explicit_payload_campaign_id_still_wins_for_a_no_website_lead`.
  - `test_missing_no_website_campaign_env_raises_before_any_send`: fail loudly at configuration time rather than silently posting 165,675 no-website leads into the campaign written for businesses that have websites.
- [ ] **Risk if wrong:** the highest-blast-radius failure in the plan. A misrouted no-website lead receives an email opening with "spotted your site and noticed", which is both a lie and obviously automated. The env-missing test is the guard.

### Phase C: make the product demo match the customer

#### Task 10: A preview template that is not a trades site

- [ ] **Files:** create `services/pipeline/src/templates/previews/business.html` (genuinely neutral) and `services/pipeline/src/templates/previews/hospitality.html`, plus hero assets under `templates/previews/assets/`; modify `select_template_key()` in `generate_preview.py`; modify `services/pipeline/tests/test_preview_templates.py`.
- [ ] **Why this is on the critical path and not a follow-up:** `general.html` is the fallback for every non-trade business, and it is a trades template start to finish. Shipping Phases A and B without this means well-scored cafes and accountants receive a licensed-tradesman website as their personalised demo. That is a worse outcome than the current archiving behaviour, because it reaches the customer.
- [ ] **Ordering:** hospitality first. Food, Hospitality and Travel is 25.6% of the new database, which is six times the entire trades category.
- [ ] **Tests first** (`test_preview_templates.py`):
  - `test_business_template_contains_no_trade_specific_copy`: asserts "Licensed", "Free Quote", "Trades" and similar do not appear.
  - `test_every_template_renders_all_tokens`: no `{{...}}` left in the output for any template, run across the whole template directory so new templates are covered automatically.
  - `test_select_template_key_falls_back_to_business_not_general`: the fallback for an unknown industry must be the neutral template.
  - `test_hospitality_keywords_select_the_hospitality_template`.
- [ ] **Risk if wrong:** an unrendered `{{TOKEN}}` on a live preview page, or a hero image referencing an asset path that was never added, produces a broken demo at the exact moment the prospect clicks. The render test covers the first; the asset paths need a manual look at the rendered page.
- [ ] **Operator input needed:** somebody has to produce or buy the hero photography and decide how many templates are worth building. See Operator Decision 4.

#### Task 11: The remaining tradie references

- [ ] **Files:** `CLAUDE.md`; `services/pipeline/src/workers/orchestrator.py` (the `"tradies"` vertical default, lines 248 and 457); `database/schema.sql` and a small migration if the operator wants the column default changed; `docs/queue-payloads.md`; `docs/adr/003-apollo-only.md`; dashboard fixtures and copy that reference tradies.
- [ ] **`prompts/reply-agent-v1.txt` line 1 belongs in this task and must be coordinated.** The file is at repo root, but `services/reply-agent` reads it and another agent is editing that service right now. Do not touch it until that work has landed. `services/reply-agent/src/stripe.ts` also mentions tradies and is entirely off limits for this plan.
- [ ] **Tests first:** a single repository-level guard, `test_no_tradie_assumption_in_active_prompts`, asserting that no file in `prompts/` currently wired into `_MODEL_MAP` contains "tradie" or "tradies". Historical docs and handoffs are excluded, because rewriting the record of what was decided is not a cleanup.
- [ ] **`CLAUDE.md` matters more than it looks.** It is loaded into every future agent session in this repo. Leaving "for Australian tradies" in it means every future agent reintroduces the assumption the rest of this plan removes.
- [ ] **Risk if wrong:** mostly cosmetic, except for the `vertical` default. Changing a column default is a migration, and `generate_preview.select_template_key()` reads `vertical` as one of its template-selection fields, so a careless change there silently reroutes template selection. Change the default only if the operator wants it, and re-run the Task 10 template tests if you do.

---

## Part 3: Decisions for the operator, not for an engineer

Each has a recommendation, but the call is the operator's.

**1. Do you want to sell to directories, marketplaces and referral platforms?**
The old prompt rejected the example lead for two reasons. One was "not a tradie", which is the bug. The other was "directory/referral platform", which the new rubric deliberately keeps as a negative. *Recommendation: keep excluding them.* They already have a web presence and their business model is being the website. If you disagree, say so and it comes out of the rubric in Task 1.

**2. Franchise outlets.**
A suburban outlet of a national chain usually cannot buy its own website, because head office owns the brand. They will look like great prospects in a 900k database and waste a lot of sends. *Recommendation: score them low (the 4-point band in the rubric), do not hard-exclude them, and revisit after the first batch of real replies.*

**3. What is the live `QUALIFICATION_SCORE_THRESHOLD`?**
`.env.example` says 40. The brief says 35. Nothing can be recalibrated against an unknown baseline. *Recommendation: read the value off the VPS and record it in the handoff before Task 3 begins.*

**4. How many preview templates are you willing to build?**
There are six today and five of them are trades. *Recommendation: two more in this round. One genuinely neutral business template, one hospitality template. That covers roughly a third of the new database properly and leaves the rest on a neutral fallback that is at least not wrong.* Anything beyond that should wait for evidence from real reply rates.

**5. Is the 900k database an Apollo export?**
`ingest.py` is hard-coded to Apollo column headers. If the new file uses different headers, every row is rejected and the failure looks like bad data rather than a mapping bug. *Recommendation: get one sample file with its header row before Task 7 is considered done. If the headers differ, a column-mapping step becomes a task of its own and is not in this plan.*

**6. Do you want to reopen "unreachable" leads too?**
This plan deliberately does not change `_unreachable()`. Leads whose domain exists but does not load are still archived with an empty weaknesses array. Some of those are parked domains and dead sites, which are arguably as good a prospect as no website at all. *Recommendation: leave it for now, measure how many there are in the first real import, then decide. It is a small change once you know the volume.*

**7. Two campaigns or one?**
*Recommendation: two.* The opening sentence is structurally different and cannot be shared, and per-campaign reply rates are the only cheap way to learn whether the no-website premise is right.

---

## Part 4: Order of work, and what must not ship together

```
Phase A  Tasks 1, 2, 3    Score means the right thing. Threshold recalibrated.
                          Nothing new is sent yet.
Phase B  Tasks 4-9        No-website leads enter, get an honest record,
                          get honest copy, get their own campaign.
Phase C  Tasks 10, 11     The demo matches the customer. Assumption removed
                          from the docs so it does not grow back.
```

**Do not ship Phase A to a live sending campaign without Task 3.** New prompt plus old threshold is an unmeasured change to who gets emailed.

**Do not ship Phase B without Task 10.** A well-scored cafe receiving a licensed-tradesman preview is a worse outcome than the cafe being archived.

**Keep `INSTANTLY_CAMPAIGN_ID` pointed at the paused test campaign** until Phases A, B and C are all verified end to end, exactly as the previous handoffs in `docs/superpowers/handoffs/` warn.

---

## Part 5: Verification, and the specific way this system lies

The project memory for this repo records that clean logs and green tests here have historically meant "never ran", not "worked". Two of the changes in this plan are especially good at looking healthy while doing nothing:

- **Task 4 before Task 5.** If `no_website` is emitted before it exists in `WEAKNESS_LABELS`, `enrich.py:97-101` filters it out silently. The lead archives with an empty weaknesses array, which is indistinguishable from the bug being fixed. Vocabulary first.
- **Task 3 skipped.** Everything passes, jobs complete, and either nothing qualifies or everything does. Neither is visible until you look at the actual counts.

Before calling any phase done, per `verification-before-completion`:

- [ ] Run the pipeline test suite and paste the real output, not a summary of it.
- [ ] Run one no-website lead end to end against the paused test campaign and read the actual email body that Instantly would send. Not the prompt, not the `qualifications` row: the rendered email.
- [ ] Run one has-website lead end to end and confirm its copy is byte-for-byte unchanged from before this work.
- [ ] Open a rendered preview page for a non-trade business in a browser and look at it.
- [ ] Compare score counts above and below threshold before and after the prompt change, on the same sample of leads.

Invoke `db-reviewer` after Task 3 (the shadow harness reads leads) and `security-reviewer` is not required by this plan, since nothing here touches auth, payments or webhooks.
