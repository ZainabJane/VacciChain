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

## Batch verification concurrency

Batch verification (analytics) fans out per-item work to the backend, the RPC
provider, and the Python worker pool. To keep large batches from overwhelming any
of these, both the batch size and the parallelism are bounded and configurable.

### Configuration

| Variable | Default | Allowed range | Purpose |
|---|---|---|---|
| `BATCH_SIZE` | 100 | 1–1000 | Maximum number of items accepted in a single batch request |
| `BATCH_CONCURRENCY` | 4 | 1–16 | Maximum number of items processed in parallel within a batch |

Requests exceeding `BATCH_SIZE` are rejected with a validation error rather than
silently truncated. `BATCH_CONCURRENCY` is clamped to the documented range at
startup; out-of-range values are logged and replaced with the nearest bound.

### Recommended values

| Scenario | `BATCH_SIZE` | `BATCH_CONCURRENCY` |
|---|---|---|
| Default / shared host | 100 | 4 |
| Backend memory-constrained (near 256 MB limit) | 50 | 2 |
| RPC provider rate-limited | 100 | 2–4 |
| Dedicated host with headroom | 250 | 8 |

Keep `BATCH_SIZE × BATCH_CONCURRENCY` in mind: the effective in-flight item count
is bounded by `BATCH_CONCURRENCY`, but each in-flight item may hold an XDR buffer
(see the `backend` memory basis above). Raising concurrency multiplies peak memory.

### Tuning `BATCH_CONCURRENCY`

1. Start at the default (4) and run a representative batch.
2. Watch backend memory (`docker stats backend`) and RPC error rates. If memory
   approaches the 256 MB limit or you see OOM kills, halve concurrency.
3. If latency is dominated by waiting on the RPC provider and error rates are
   clean, increase concurrency one step at a time up to 16, re-profiling each time.
4. Partial failures are reported per item: a failed item yields an error result
   for that item only, and the rest of the batch completes. A batch response is
   therefore a mix of successes and per-item errors, never an all-or-nothing abort.

Load tests should confirm stable latency as batch size grows and that partial
failures surface a clear per-item error result.

## Adjusting limits

If you observe legitimate OOM kills under normal load, increase the memory limit
in `docker-compose.yml` in 64 MB increments and re-profile. Do not remove limits
entirely — use `reservations` to guarantee a floor and `limits` to cap the ceiling.

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
=======
