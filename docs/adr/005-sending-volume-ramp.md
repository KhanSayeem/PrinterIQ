# ADR 005 - Ramp campaign sending volume over six days

**Status:** Accepted
**Date:** August 2026

## Context

The PrinterIQ sending estate is 8 active Prescia mailboxes. Their per-account daily
limits sum to exactly 155. This was verified in the Instantly accounts UI on
2026-08-25.

The mailboxes are warm. A representative account, `murphy@presciaweb.com`, began
warmup on 2026-06-17, over two months before the check, and shows 100% health with
0 messages saved from spam in the prior week.

There are also 10 accounts on `adsiqdigital.com` and `buildpredictiqdigital.com`.
They belong to a different project. They are not PrinterIQ capacity and must not be
counted as capacity when this ADR is revisited.

Warmup being complete is not the same as having a sending history. Across all 8
mailboxes the estate has sent roughly 29 real cold emails in total. Going straight to
155 per day means moving from about 4 per mailbox per day to about 19, a 400%
increase from a sender with almost no volume record.

Monitoring is degraded in two independent ways, and both affect how the ramp can be
supervised.

First, Google's spam rate thresholds are to keep the rate below 0.1% and never reach
0.3%, calculated daily (https://support.google.com/a/answer/14229414). Postmaster
Tools does not guarantee complete data on days when outgoing volume is low. At 155
sends per day spread over 4 domains, that is roughly 39 per domain per day, so the
metric Google actually judges on will most likely not be visible.

Second, open tracking and click tracking are both disabled on the campaigns. That is
deliberate, for deliverability, and it removes the other early signal.

## Decision

Ramp campaign sending from 30 per day to 155 per day over roughly six days at about
50% daily growth, rather than switching to full volume in one step.

| Day | Sends per day |
| --- | --- |
| 1 | 30 |
| 2 | 45 |
| 3 | 68 |
| 4 | 101 |
| 5 | 152 |
| 6 | 155 |

Warmup keeps running alongside the live campaign for the whole ramp.

Because the percentage threshold cannot be used at this volume, the operating rule is
on the absolute count: any spam complaint at all triggers a stop and review.

Halt the ramp and hold or step back a level on any of these:

- any spam complaint
- any meaningful rise in bounces
- any account health score falling below 100%

## Rationale

**Why not switch in one step.** Google's own guidance for new senders is to increase
volume slowly after the first 24 hours, with "a common daily increase of 25% to 100%"
depending on other factors (https://support.google.com/mail/answer/15256272,
verified directly against the page rather than taken from a summary). A 400% jump is
four times the top of that band, from a sender with no volume history to justify it.
About 50% per day sits inside the band Google publishes.

**Why 155 is the right destination.** 19 emails per mailbox per day is conservative.
Instantly, the platform in use, recommends 30 campaign emails per account per day in
its own documentation (https://help.instantly.ai/en/articles/6248612-account-and-campaign-limits,
vendor source). Surveyed vendor recommendations range from 15 to 200 per mailbox per
day. Every one of those vendors prices per mailbox, so they have a commercial
interest in advising customers to add inboxes rather than use the ones they already
have harder. Read the low end of that range with that in mind. No mailbox provider,
Google or Microsoft, publishes a per-mailbox cold email volume figure at all.

**Why the complaint rule is an absolute count.** At 155 sends per day a single spam
complaint is about 0.65%, more than double Google's 0.3% danger line. At 30 per day
it is 3.3%. A percentage threshold is meaningless at this scale, so the trigger is
one complaint, not a ratio.

**Why bounces are watched rather than rate-limited.** No official Google or Microsoft
bounce-rate threshold exists. The commonly cited "under 2%" figure is vendor blog
material, not provider guidance. Addresses should be verified before sending instead
of relying on a rate to warn you after the fact.

## Consequences

- Reaching full volume takes about six days rather than being immediate.
- At 155 per day the estate sends about 4,650 per month.
- The ramp is paced on observed bounces and complaints, not on the calendar, so it
  may take longer than six days.
- Google's bulk sender rules (5,000 or more messages per day to personal Gmail
  accounts, counted per primary domain including subdomains) are not triggered at
  this volume. The all-sender requirements still apply: SPF or DKIM, TLS, valid
  forward and reverse DNS, and a spam rate under 0.30%.
