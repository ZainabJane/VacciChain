# Container Resource Limits

> **Scope:** this document covers **container** resource limits (Docker CPU/memory).
> For **contract input and collection bounds** enforced by the Soroban contracts
> themselves, see [Contract input and collection bounds](#contract-input-and-collection-bounds) below.
> For **on-chain storage lifecycle** (rent, TTL, retention), see
> [Soroban contract storage lifecycle](#soroban-contract-storage-lifecycle) below.

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

## Public verification API limits

Public verification endpoints (`/api/verify/:id` and `/api/verify/batch`) are
exposed to untrusted clients, so they enforce hard caps on response size and
work per request. This prevents unbounded record histories or batch inputs from
exhausting memory, CPU, or response bandwidth.

### Single record responses

| Limit | Value | Semantics |
|---|---|---|
| Max records per response | 100 | Records beyond the limit are **truncated**; the response includes `truncated: true` and `nextCursor` |
| Default page size | 20 | Applied when no `limit` query parameter is supplied |
| Max `limit` query parameter | 100 | Values above 100 are clamped to 100 (no error) |
| Max serialized response size | 1 MB | If the page would exceed 1 MB, the page is shortened and `truncated: true` is returned |

Pagination is **cursor-based**: clients pass the opaque `nextCursor` value from
the previous response as the `cursor` query parameter. A response with
`truncated: false` (or no `nextCursor`) marks the end of the history. Cursors are
stable for a given record set; clients must not construct or parse them.

### Batch requests

| Limit | Value | Semantics |
|---|---|---|
| Max items per batch request | 50 | Requests with more items are **rejected** with HTTP 413 and `error: "batch_too_large"` |
| Max request body size | 256 KB | Bodies above this are rejected with HTTP 413 before parsing |
| Max concurrent verifications per batch | 10 | Items are processed in bounded-concurrency chunks; results preserve input order |
| Per-item timeout | 5 s | Timed-out items return `status: "timeout"` in their result slot; the batch continues |

Batch responses are **never silently truncated**: every submitted item receives
exactly one result entry, so `results.length` always equals the number of items
accepted. Oversized batches fail fast rather than being partially processed.

### Boundary behaviour

| Input | Behaviour |
|---|---|
| Below limit (e.g. 99 records, 49 batch items) | Full response, `truncated: false` |
| At limit (exactly 100 records, 50 batch items) | Full response, `truncated: false` |
| Above limit (101+ records) | Truncated page + `nextCursor`; remaining records fetched via pagination |
| Above batch limit (51+ items) | HTTP 413 `batch_too_large`; no items processed |

These limits are covered by boundary tests in the backend test suite
(at, below, and above each threshold).

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
