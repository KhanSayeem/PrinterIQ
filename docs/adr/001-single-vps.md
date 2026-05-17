# ADR 001 — Single VPS over multiple services

**Status:** Accepted  
**Date:** May 2026

## Context

PrinterIQ Phase 1 is a single-operator pipeline processing ~4,500 leads once, then handling ongoing replies and payments. The alternatives were: multiple managed services (e.g. separate containers/functions per service), or a single VPS running all three services under PM2.

## Decision

Single DigitalOcean VPS (4GB/2vCPU, Sydney) running all three services under PM2.

## Rationale

- **Volume doesn't justify distribution.** 4,500 leads processed once at 5 concurrent workers. Reply volume is < 100/day. This is comfortably within a single 4GB machine's capacity.
- **Playwright requires a real machine.** Playwright headless browser for website enrichment doesn't run well in serverless environments without significant configuration overhead.
- **Cost.** ~$24/month vs. $100–300/month for equivalent managed infrastructure.
- **Operational simplicity.** One box, PM2, git pull, done. No orchestration layer to debug.
- **Data residency.** AU data residency is satisfied by the Sydney VPS + Supabase AP Sydney.

## Consequences

- No horizontal scaling — if lead volume grows 10x, infrastructure must be revisited in Phase 2.
- Single point of failure — PM2 auto-restart mitigates crashes, but hardware failure requires DigitalOcean snapshot restore.
- All deployments are SSH → git pull → pm2 restart — simple and auditable.
