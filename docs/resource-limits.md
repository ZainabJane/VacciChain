# Container Resource Limits

> **Scope:** this document covers **container** resource limits (Docker CPU/memory).
> For **contract input and collection bounds** enforced by the Soroban contracts
> themselves, see [Contract input and collection bounds](#contract-input-and-collection-bounds) below.

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

## Contract input and collection bounds

Container limits (above) protect the *host*. The bounds below protect the
*contract*: every public entry point and every stored collection has a
documented maximum so that a single call cannot exceed Soroban CPU/ledger-entry
resource limits. All bounds are enforced with explicit validation that returns a
typed error (`Error::InputTooLong` / `Error::CollectionFull`) rather than
panicking, and are measured in bytes for strings and in element counts for
collections.

### Constants

| Constant | Value | Applies to |
|---|---|---|
| `MAX_VACCINE_NAME_LEN` | 64 bytes | `vaccine_name` argument on record creation/update |
| `MAX_DATE_LEN` | 10 bytes | ISO-8601 `YYYY-MM-DD` date arguments |
| `MAX_ISSUER_NAME_LEN` | 64 bytes | issuer `name` argument |
| `MAX_ISSUER_LICENSE_LEN` | 32 bytes | issuer `license` argument |
| `MAX_ISSUER_COUNTRY_LEN` | 2 bytes | issuer `country` (ISO-3166-1 alpha-2) |
| `MAX_ISSUERS` | 32 | stored issuer list per registry |
| `MAX_PATIENT_RECORDS` | 64 | stored vaccination records per patient |
| `MAX_BATCH_SIZE` | 32 | elements per batch call (bulk record insert / issuer registration) |

### Public arguments

| Argument | Max | Notes |
|---|---|---|
| `vaccine_name` | `MAX_VACCINE_NAME_LEN` (64 B) | UTF-8 byte length, not character count |
| `date` | `MAX_DATE_LEN` (10 B) | must also parse as `YYYY-MM-DD` |
| `issuer.name` | `MAX_ISSUER_NAME_LEN` (64 B) | UTF-8 byte length |
| `issuer.license` | `MAX_ISSUER_LICENSE_LEN` (32 B) | UTF-8 byte length |
| `issuer.country` | `MAX_ISSUER_COUNTRY_LEN` (2 B) | exactly 2 ASCII letters |
| `batch` | `MAX_BATCH_SIZE` (32) | zero-length batches are rejected |

### Stored collections

| Collection | Max | Behaviour at limit |
|---|---|---|
| Issuer list | `MAX_ISSUERS` (32) | further registrations rejected with `CollectionFull` |
| Patient record history | `MAX_PATIENT_RECORDS` (64) | further records rejected with `CollectionFull` |

### Boundary test coverage

Each bound has tests at **zero**, **maximum valid**, and **maximum + 1**:

| Bound | Zero | Max valid | Max + 1 |
|---|---|---|---|
| `vaccine_name` | empty string rejected | 64 B accepted | 65 B rejected |
| `date` | empty string rejected | 10 B (`2024-01-01`) accepted | 11 B rejected |
| `issuer.name` | empty string rejected | 64 B accepted | 65 B rejected |
| `issuer.license` | empty string rejected | 32 B accepted | 33 B rejected |
| `issuer.country` | empty string rejected | 2 B (`US`) accepted | 3 B rejected |
| issuer list | 0 issuers valid | 32 issuers accepted | 33rd rejected |
| patient records | 0 records valid | 64 records accepted | 65th rejected |
| batch | empty batch rejected | 32 elements accepted | 33 elements rejected |

Multi-byte UTF-8 input is tested explicitly to confirm limits are enforced on
byte length, so a 33-character string of 2-byte code points is rejected even
though its character count is under the limit.
