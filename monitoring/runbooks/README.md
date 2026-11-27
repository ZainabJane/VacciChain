# SLO Alert Runbooks

This directory contains runbooks for every service-level objective (SLO) alert defined in `monitoring/alerts.yml`. Each alert's `runbook_url` annotation points to the matching section below (or to an individual runbook file in this directory).

## Service-Level Objectives

| SLO | Indicator | Objective | Alert | Severity | Owner |
| --- | --- | --- | --- | --- | --- |
| Latency | p95 request latency | p95 < 500 ms for 99% of 5-min windows | `HighLatency` | warning | Platform Team (`@platform-oncall`) |
| Error rate | 5xx responses / total requests | < 1% over 30 min | `HighErrorRate` | critical | Platform Team (`@platform-oncall`) |
| Poller lag | Seconds behind source | < 60 s for 99% of the time | `PollerLagHigh` | warning | Data Engineering (`@data-oncall`) |
| Data freshness | Age of newest record | < 5 min | `StaleData` | critical | Data Engineering (`@data-oncall`) |

Owners are responsible for keeping thresholds, severities, and these runbooks current. Escalation follows the standard on-call rotation.

---

## HighLatency

- **Meaning:** The p95 request latency SLO is burning budget — p95 latency has exceeded 500 ms for more than 5 minutes.
- **Severity:** warning
- **Owner:** Platform Team (`@platform-oncall`)
- **Investigation:**
  1. Check the latency dashboard for which endpoints/regions are affected.
  2. Correlate with recent deploys, config changes, or traffic spikes.
  3. Inspect downstream dependencies (database, cache, external APIs) for elevated response times.
  4. Review saturation metrics (CPU, memory, connection pools) on affected instances.
- **Remediation:**
  1. If caused by a recent deploy, roll back or scale out.
  2. If a downstream dependency is slow, apply circuit breaking / caching or fail over.
  3. If traffic-driven, scale horizontally and confirm autoscaling is functioning.
  4. If sustained, escalate to the Platform Team lead and open an incident.

## HighErrorRate

- **Meaning:** The error-rate SLO is burning budget — 5xx responses exceed 1% of total requests over 30 minutes.
- **Severity:** critical
- **Owner:** Platform Team (`@platform-oncall`)
- **Investigation:**
  1. Identify the failing endpoints and error codes from logs/traces.
  2. Check for recent deploys, feature-flag changes, or dependency outages.
  3. Verify database and external service health.
  4. Confirm whether errors are client-induced (bad input) or server-side.
- **Remediation:**
  1. Roll back the most recent change if errors started immediately after it.
  2. Fail over or disable the failing dependency path.
  3. If errors are client-induced, add validation and notify API consumers.
  4. Page the on-call lead and open an incident if the rate keeps climbing.

## PollerLagHigh

- **Meaning:** The poller is more than 60 seconds behind the source for over 10 minutes; data ingestion is falling behind.
- **Severity:** warning
- **Owner:** Data Engineering (`@data-oncall`)
- **Investigation:**
  1. Check poller logs for errors, retries, or rate limiting from the source.
  2. Inspect poller throughput and queue depth.
  3. Verify source API health and any upstream rate limits or outages.
  4. Check resource saturation on poller workers.
- **Remediation:**
  1. Scale out poller workers or increase batch size if throughput-bound.
  2. Back off and retry if rate-limited by the source.
  3. Restart stuck workers.
  4. If lag continues to grow, escalate to Data Engineering lead.

## StaleData

- **Meaning:** The data-freshness SLO is breached — the newest record is older than 5 minutes, so consumers may be seeing stale data.
- **Severity:** critical
- **Owner:** Data Engineering (`@data-oncall`)
- **Investigation:**
  1. Confirm whether the poller is running and producing records.
  2. Check for upstream source outages or schema changes.
  3. Inspect pipeline stages (ingest, transform, load) for failures.
  4. Review recent pipeline deploys or config changes.
- **Remediation:**
  1. Restart failed pipeline stages and re-run the affected window.
  2. If the source is down, notify consumers and monitor for recovery.
  3. If a schema change broke ingestion, patch the parser and backfill.
  4. Page the on-call lead and open an incident if freshness is not restored quickly.

---

## Testing Alerts

All SLO alerts are validated with controlled failure injection in a non-production environment before being promoted. See the failure-injection test plan for the procedures used to trigger each alert and verify routing, severity, and runbook links.