# Container Resource Limits

## Rationale

Limits are set at roughly **2× the observed idle/steady-state peak** for memory and
**realistic burst ceiling** for CPU. This gives each service room to handle traffic
spikes while ensuring a runaway container cannot starve its neighbours on the host.

## Per-service breakdown

| Service | CPU limit | Memory limit | Basis |
|---|---|---|---|
| `frontend` | 0.05 | 32 MB | nginx static file serving; no dynamic computation |
| `backend` | 0.75 | 256 MB | Node.js heap ~80–100 MB at rest; XDR buffer bursts during Soroban calls |
| `python-service` | 0.50 | 128 MB | FastAPI/uvicorn baseline ~60 MB; async httpx fan-out to Horizon |

## OOM kill detection

Docker's `json-file` logging driver captures kernel OOM kill messages.
To monitor in real time:

```bash
# Stream OOM events from all containers
docker events --filter event=oom

# Check if a container was OOM-killed (exit code 137)
docker inspect <container_name> --format '{{.State.OOMKilled}}'
```

To alert on OOM kills in CI/CD or production, pipe `docker events` to your
observability stack (e.g. Datadog, Prometheus `container_oom_events_total`,
or a simple shell watcher):

```bash
docker events --filter event=oom --format '{{.Actor.Attributes.name}}' | \
  while read name; do
    echo "[ALERT] OOM kill: $name at $(date -u +%FT%TZ)"
  done
```

## Adjusting limits

If you observe legitimate OOM kills under normal load, increase the memory limit
in `docker-compose.yml` in 64 MB increments and re-profile. Do not remove limits
entirely — use `reservations` to guarantee a floor and `limits` to cap the ceiling.

## ECS task autoscaling

Each service runs as an ECS service with Application Auto Scaling target-tracking
policies. Scaling is driven by measured load, but every service is bounded by
minimum/maximum task counts and a monthly cost ceiling so a traffic spike cannot
exhaust the host or the budget.

### Scaling metrics

| Service | Primary metric | Target | Secondary metric | Target |
|---|---|---|---|---|
| `frontend` | `ALBRequestCountPerTarget` | 800 req/min/task | `ECSServiceAverageCPUUtilization` | 60% |
| `backend` | `ECSServiceAverageCPUUtilization` | 65% | `ALBRequestCountPerTarget` | 300 req/min/task |
| `python-service` | `ECSServiceAverageCPUUtilization` | 60% | `ALBRequestCountPerTarget` | 200 req/min/task |

### Capacity bounds, cooldowns, and cost limits

| Service | Min tasks | Max tasks | Scale-out cooldown | Scale-in cooldown | Monthly cost limit |
|---|---|---|---|---|---|
| `frontend` | 2 | 6 | 60 s | 300 s | $120 |
| `backend` | 2 | 8 | 90 s | 300 s | $480 |
| `python-service` | 1 | 4 | 90 s | 600 s | $240 |

Scale-in cooldowns are deliberately longer than scale-out cooldowns so that
short dips in load do not cause flapping. The maximum task counts are chosen so
that the aggregate connection pool stays within the backend/database concurrency
limits documented below.

### Backend and database concurrency guardrails

Autoscaling must never push shared persistence past its safe concurrency:

- **Database connection pool:** each `backend` task opens at most 10 pooled
  connections. With `MaxCapacity = 8`, the worst case is 80 connections, below
  the PostgreSQL `max_connections = 100` ceiling (leaving headroom for
  migrations and admin sessions).
- **`python-service` fan-out:** each task caps concurrent Horizon requests at 20;
  at `MaxCapacity = 4` this is 80 in-flight requests, within the Horizon rate
  limit budget.
- **Shared writes:** scaling events must not trigger schema changes or bulk
  backfills. All migrations run as one-off ECS tasks, never as part of a
  scaling action.

If a service needs a higher `MaxCapacity`, re-check the connection math above and
raise the database ceiling (or add PgBouncer) in the same change.

### Cost limits

Monthly cost limits are enforced with an AWS Budgets alarm per service. When a
budget threshold (80% of the limit) is crossed, an alert fires and the
`MaxCapacity` for that service is reduced to its `MinCapacity` via a scheduled
action until the budget is reviewed. Cost limits assume `us-east-1` on-demand
pricing and are reviewed quarterly.

### Load test and alerting

The load test in `tests/load/` ramps traffic against a staging stack and asserts:

1. Task count scales out within one cooldown window and scales back in after the
   load stops.
2. CloudWatch alarms fire for high CPU, high request count, and budget
   thresholds.
3. Row counts and checksums in shared tables are unchanged after the run, proving
   scaling does not corrupt persistence.

Run it with:

```bash
k6 run tests/load/autoscaling.js
```

Alarms route to the on-call channel via the same SNS topic used for OOM alerts.

## Soroban contract storage lifecycle

Container limits above do not bound on-chain state. Soroban persistent entries
(vaccination histories, issuer records) are rented storage: each entry carries a
TTL measured in ledgers, and rent is charged on write and on TTL extension.

### Storage-size estimates

| Entry type | Approx. size | Expected volume | Notes |
|---|---|---|---|
| Vaccination record | ~200–400 B | 1 per dose per patient | Grows linearly with doses; never overwritten |
| Patient index entry | ~100–200 B | 1 per patient | Maps patient ID → record keys |
| Issuer record | ~300–500 B | 1 per issuer | Small, near-static set |
| Issuer revocation entry | ~100 B | 1 per revoked credential | Append-only for audit |

Rent implications: persistent entries are billed per ledger of TTL retained, so
cost scales with `entry_size × TTL_ledgers × entry_count`. Long-lived vaccination
histories dominate cost; issuer records are negligible by comparison.

### TTL extension assumptions

- Persistent entries are extended on write and on read-triggered bumps, targeting
  a TTL comfortably longer than the expected audit retention window.
- TTL extension is treated as best-effort: a failed extension must not corrupt
  state, and reads of expired entries must return a recoverable "not found"
  rather than panicking.
- Authorization checks must never fail open when required state is absent or
  expired; missing entries are treated as deny.

### Retention, compaction, and archival

- Records are append-only for audit purposes; compaction never deletes or mutates
  historical vaccination or revocation entries.
- Archival is achieved by indexing (off-chain index of record keys) and by
  extending TTLs for entries still within the audit window, rather than by
  removing entries.
- Any future compaction must preserve the ability to prove historical state and
  must be documented and approved before implementation.
