# Issue #73 / PR #81 Review Findings Handoff

Date: 2026-07-23

## Purpose

Pick up Issue #73 after the final technical reviewer returned `CHANGES REQUIRED` on PR #81.

This handoff is intentionally narrow. Do not restart the Issue #73 implementation from scratch. Continue from the existing branch, add failing regression tests for the reviewer findings first, fix the production path, rerun verification, request mandatory specialist reviews, update PR #81, and send the repaired PR back to the Sol reviewer for an explicit verdict.

## Current Branch State

- Repository: `C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ`
- Protected dirty main checkout: `C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ`
- Implementation worktree only: `C:\Users\Hi\Documents\GitHub\Miscellanious\PrinterIQ\.worktrees\issue-73-route-a-classification`
- Branch: `codex/issue-73-route-a-classification`
- Current head before this handoff commit: `630df3a92e34a24d386b2b2d67b906aaf69d1390`
- PR: `https://github.com/KhanSayeem/PrinterIQ/pull/81`
- Base at PR creation: `dev @ 4d56270d00bf13ec012e1a8e0b910c8a7cf47f1e`

Do not work in, clean, reset, stage, or switch the dirty main checkout. All edits must happen in the Issue #73 worktree above.

## Source Context

Read these before editing:

- `CLAUDE.md`
- `AGENTS.md`
- `docs/adr/004-outscraper-a-b-shadow-pilot.md`
- `docs/superpowers/specs/2026-07-22-outscraper-a-b-shadow-pilot-design.md`
- `docs/superpowers/plans/2026-07-22-outscraper-a-b-shadow-pilot.md`
- Issue #73: `[Prospects] Classify Route A businesses with no owned website`
- PR #81: `https://github.com/KhanSayeem/PrinterIQ/pull/81`
- Reviewer task: `019f8b31-1a4c-76b1-bd36-6213424100b4`

PR #80 was approved by the Sol reviewer and merged into `dev` before this branch was created.

## Reviewer Verdict

Final technical reviewer verdict for PR #81: `CHANGES REQUIRED`.

The reviewer explicitly remains the final authority. Do not merge PR #81 until that reviewer returns an explicit `APPROVED` verdict after the repair.

## Complete Findings To Fix

1. Critical - Outscraper fields are not mapped into classification columns.
   - References: `services/pipeline/src/clients/outscraper_client.py:13`, `services/pipeline/src/workers/discover_prospects.py:360`, `services/pipeline/src/workers/normalize_prospects.py:145`, `services/pipeline/src/prospects/normalization.py:148`, `services/pipeline/tests/test_normalize_prospects.py:14`.
   - Production impact: realistic provider rows retain raw payload data but lose category, phone, address, status, rating, reviews, and website fields needed by normalization, causing real eligible plumbers to be rejected as `wrong_category`.

2. High - Partial-batch replay can change duplicate decisions and re-enqueue assessment.
   - References: `services/pipeline/src/db/queries.py:599`, `services/pipeline/src/db/queries.py:646`, `services/pipeline/src/workers/normalize_prospects.py:78`, `services/pipeline/src/workers/normalize_prospects.py:135`.
   - Reviewer reproduction:
     ```text
     after_partial: place-1=held/ambiguous_duplicate, place-2=discovered
     after_replay:  place-1=held/ambiguous_duplicate, place-2=assessed/no_owned_website
     ```
   - Required direction: duplicate context must be deterministic across replays, writes must guard the expected source status, and assessment enqueue must be replay-safe.

3. High - Shared social and directory hosts are incorrectly treated as owned-domain duplicates.
   - References: `services/pipeline/src/prospects/normalization.py:132`, `services/pipeline/src/workers/normalize_prospects.py:166`.
   - Production impact: unrelated Facebook, directory, or marketplace pages collapse to the same host and become `ambiguous_duplicate` or `too_many_locations`, breaking the core social-only Route A case.
   - Required direction: duplicate grouping by website domain must use only normalized owned domains, not shared social/directory/marketplace hosts.

4. High - Closed-business and Greater Brisbane eligibility logic does not match production boundaries.
   - References: `services/pipeline/src/prospects/normalization.py:148`, `services/pipeline/src/prospects/normalization.py:229`, `services/pipeline/tests/test_prospect_normalization.py:63`.
   - Production impact: provider value `closed_permanently` can be allowed into Route A; `Brisbane, California 94005` can be accepted; `Fortitude Valley, QLD 4006` can be rejected.
   - Required direction: support production status terminology and operational Greater Brisbane locality/state/postcode boundaries.

5. High - Redirect, placeholder, and twice-inaccessible evidence has no production producer.
   - References: `services/pipeline/src/prospects/normalization.py:183`, `services/pipeline/src/workers/normalize_prospects.py:242`, `services/pipeline/src/workers/orchestrator.py:286`.
   - Production impact: tests inject final URL, content, and fetch-failure evidence, but production normalization does not fetch or write it; redirects are not followed, placeholders are not inspected, and two independent accessibility attempts are not performed.
   - Required direction: add a production website evidence producer in the normalization path with deterministic evidence. Because this changes request-handling/external HTTP behavior, invoke `security-reviewer` after the fix.

6. Medium - Discovery aggregates count held and rejected prospects as usable.
   - References: `services/pipeline/src/db/queries.py:721`, `services/pipeline/tests/test_queries.py:361`.
   - Required direction: align `usable_count` with the design/dashboard meaning instead of counting every non-`failed` status.

7. Medium - Automated-assessment idempotency conflict is not discovery-run scoped.
   - References: `services/pipeline/src/db/queries.py:675`, `services/pipeline/tests/test_queries.py:165`.
   - Required direction: make assessment idempotency compatible with discovery-run scoping and add direct tests for repeated runs.

8. Medium - Required direct boundary tests and exact dashboard evidence are incomplete.
   - References: `services/dashboard/src/components/ProspectsWorkbench.tsx:120`, `services/dashboard/src/components/ProspectsWorkbench.tsx:181`, `services/dashboard/src/components/ProspectsWorkbench.test.tsx:83`.
   - Required direction: add the complete Issue #73 boundary matrix, including the social-only end-to-end fixture and dashboard evidence proof for final URL/domain/reason data.

## Existing Verification Before Findings

These were run before the reviewer returned `CHANGES REQUIRED`; rerun after repairs rather than relying on them:

- `services/pipeline`: `python -m pytest -q` -> `217 passed`
- `services/pipeline`: `python -m ruff check src tests` -> passed
- `services/pipeline`: `python -m mypy src` -> passed
- Focused pipeline suite -> `93 passed`
- `services/dashboard`: `npm test` -> `35 files, 205 tests passed`
- Focused dashboard suite -> `44 tests passed`
- `services/dashboard`: `npm run lint` -> passed
- `services/dashboard`: `npm run build` -> passed
- PR #81 CI was green at head `630df3a` before review findings.

## Required Working Method

- Use `brainstorming`, `writing-plans`, `executing-plans`, `receiving-code-review`, `systematic-debugging`, `test-driven-development`, `verification-before-completion`, and `requesting-code-review`.
- Follow mandatory TDD. Add failing tests for the reviewer findings before production edits.
- Preserve tenant isolation on every read and write.
- Route all database access through established query modules.
- Invoke `db-reviewer` after any database query change.
- Invoke `security-reviewer` after website resolver/provider/request-handling changes.
- Keep processing shadow-only.
- Prove that lead creation, preview generation, outreach, and Instantly remain unreachable.
- Do not make a live Outscraper request without explicit user approval.
- Do not apply migration `0008` to hosted Postgres without explicit approval and a target-environment audit.
- Do not implicitly combine credential setup or hosted deployment with this repair.

## Suggested Repair Order

1. Re-read the reviewer task final response and this handoff.
2. Refresh GitHub PR #81 state and local branch status from the Issue #73 worktree.
3. Add failing pipeline tests for provider field mapping, social-only end-to-end discovery-to-normalization, closed/status boundaries, Greater Brisbane state/postcode boundaries, shared social/directory duplicate handling, partial replay stability, run-scoped assessment idempotency, aggregate counts, and website evidence production.
4. Add failing dashboard tests for exact Route A evidence display and absence of lead/preview/outreach/Instantly actions.
5. Implement fixes in the narrowest production path.
6. Run focused tests after each blocker class.
7. Run full Python, dashboard, lint, strict typing, and production build verification.
8. Browser-check `/prospects` if the preview can attach.
9. Request mandatory `db-reviewer`, `security-reviewer`, and whole-diff Sol review.
10. Push the updated PR #81 branch targeting `dev`.
11. Send the Sol reviewer the PR URL, branch, base SHA, head SHA, verification evidence, and unresolved live-verification boundaries.
12. Stop before merge until the reviewer explicitly returns `APPROVED`.

## Boundaries To Preserve

- No API keys or secrets in output, commits, tests, or handoff text.
- No live Outscraper requests without approval.
- No hosted Postgres migration application without approval and audit.
- No deployment work unless explicitly requested.
- No edits in the dirty main checkout.
- No lead creation, preview generation, outreach scheduling, or Instantly integration from this shadow Route A path.
