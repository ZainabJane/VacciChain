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

## Contract batch verification limits

Batch verification of contract invocations is capped at **50 entries per
invocation** (`MAX_BATCH_SIZE`). The limit is enforced on-chain in the contract
and mirrored in the backend client so oversized requests fail fast.

### Rationale

- Each entry requires a storage read plus signature/state checks; 50 entries
  keeps a single invocation well within the Soroban CPU instruction budget
  (~2× the observed peak batch of ~25 entries in steady-state traffic).
- It bounds the ledger footprint of a single transaction and prevents one
  caller from monopolising ledger resources during bursts.
- It keeps worst-case verification latency predictable for the backend's
  Soroban call timeout.

### Validation order

The batch size is validated **before any expensive storage access**:

1. The contract reads the batch length from the invocation arguments.
2. If `len > MAX_BATCH_SIZE`, it returns `BatchTooLarge` immediately — no
   storage reads, no per-entry verification, no state writes.
3. Only after the size check passes does it iterate entries, performing
   storage access and verification per entry.

This ordering guarantees that over-limit requests cost only argument
deserialisation, so abusive callers cannot force expensive storage work.

### Resource tests

`contracts/tests/resource_limits.rs` covers:

- **Maximum batch size** — a batch of exactly `MAX_BATCH_SIZE` entries
  verifies successfully and stays within the instruction budget.
- **Mixed results** — a batch containing both valid and invalid entries
  reports per-entry outcomes without aborting the whole batch.
- **Over-limit rejection** — a batch of `MAX_BATCH_SIZE + 1` entries is
  rejected with `BatchTooLarge` and performs no storage access.

## Adjusting limits

If you observe legitimate OOM kills under normal load, increase the memory limit
in `docker-compose.yml` in 64 MB increments and re-profile. Do not remove limits
entirely — use `reservations` to guarantee a floor and `limits` to cap the ceiling.
