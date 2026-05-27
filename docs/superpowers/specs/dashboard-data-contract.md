# Dashboard Data Contract

## Principle
The design reference (printeriq-dashboard.html) defines visual layout only.
This document defines data fetching, empty states, and error handling.

## Rules — non-negotiable

1. No hardcoded mock data anywhere in production components.
   Seed data in database/seed.ts is the only acceptable source during dev.

2. Every data fetch has three states: loading, success, empty.
   Loading: show skeleton placeholders matching the component shape.
   Empty: show contextual message telling the user what to do next.
   Error: show what failed and how to fix it. Never show a blank screen.

3. All queries go through Drizzle. Always include tenant_id scope.
   Never query without tenant_id — invoke db-reviewer on every query.

4. Before implementing any screen, verify the required tables and
   columns exist in database/schema.sql. If a required field is missing,
   stop and raise it — do not work around it.

## Screen data sources

### /leads
- Source: leads table
- Query: SELECT with tenant_id filter, status filter, pagination
- Empty: "No leads yet. Import your Apollo CSV to get started."
- Error: "Failed to load leads."

### /pipeline
- Source: leads table, COUNT GROUP BY status
- Empty: "No pipeline data. Import leads first."
- Error: "Failed to load pipeline data."

### /revenue
- Source: payments table (revenue), qualifications table (AI costs)
- Empty payments: "No payments recorded yet."
- Empty AI costs: "No AI spend recorded yet."
- Error: "Failed to load revenue data."

### /leads/[id]
- Source: leads + enrichments + qualifications + conversations + outreach_sends + payments
- All joined by lead_id AND tenant_id
- If lead not found: 404 page — "Lead not found."
- Per-tab empty states defined separately per tab.

## Skeleton loading
Use Tailwind animate-pulse skeleton blocks.
Match the shape of the real component — not a generic spinner.
Leads table skeleton: 8 rows of placeholder bars.
Metric cards skeleton: grey value block same size as the number.

## What to verify before starting each screen
1. Open database/schema.sql — confirm every column you need exists.
2. Open services/dashboard/src/db/ — confirm Drizzle schema matches.
3. Run a test query against the seeded local DB before wiring to the component.
4. Only then build the component.

## Operator Actions (D1 scaffolding, D3 implementation)

Three operator actions live on the lead detail page /leads/[id].
D1 renders the buttons and creates stub Server Actions.
D3 implements the actual logic.

### Add note
- Button: visible on lead detail, disabled until D3
- Stub file: src/app/actions/lead-actions.ts → addNote()
- D3 will: insert conversations row, direction='note', operator_override=true

### Override reply  
- Button: visible on lead detail, disabled until D3
- Stub file: src/app/actions/lead-actions.ts → overrideReply()
- D3 will: insert conversations row, operator_override=true, send via Instantly API

### Pause lead
- Button: visible on lead detail, disabled until D3
- Stub file: src/app/actions/lead-actions.ts → pauseLead()
- D3 will: call Instantly pause_lead API — NOT a direct DB write to outreach_sends

### Rules
- Buttons render in D1 but are visually marked as coming soon or disabled
- Server Action stubs throw 'Not implemented' — never silently fail
- D3 must invoke security-reviewer after implementing any of these actions