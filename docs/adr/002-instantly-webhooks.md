# ADR 002 — Instantly for outreach and reply routing

**Status:** Accepted  
**Date:** May 2026

## Context

PrinterIQ needs to send personalised cold email sequences to ~4,500 leads, receive reply notifications, handle bounces and unsubscribes, and route replies back to the reply agent for AI processing. Options considered: build a custom SMTP sender, use a generic transactional email provider (Resend/Sendgrid), or use a dedicated cold outreach platform (Instantly, Lemlist, Apollo Sequences).

## Decision

Use Instantly (Hypergrowth plan, $97/month) for all cold email sending, inbox rotation, and outbound webhook delivery. Use Resend for transactional email only (welcome emails, operator alerts).

## Rationale

- **Inbox warmup.** Instantly manages inbox warming, rotation across multiple inboxes, and send scheduling — essential for <2% bounce rate. Building this is months of work.
- **Sequence management.** Multi-step sequences (opener → follow-up 1 → follow-up 2 with time delays) are configured in the Instantly UI, not in code. This means no code changes to adjust timing.
- **Webhook delivery.** Instantly fires `reply_received`, `email_bounced`, `lead_unsubscribed` webhooks with the `lead_id` we passed as a custom variable, enabling clean DB matching.
- **Deliverability.** Dedicated domains + warmed inboxes + Instantly's reputation management is the standard approach for cold outreach at this volume.

## Consequences

- Outreach timing and sequence copy are configured in the Instantly UI — code only adds leads to campaigns.
- `instantly_lead_id` is stored in `outreach_sends` — all Instantly operations reference this ID.
- If Instantly's API changes, `services/pipeline/src/clients/instantly_client.py` is the only file to update.
- Resend is kept for transactional email (non-cold) to avoid mixing cold outreach infrastructure with welcome/alert email infrastructure.
