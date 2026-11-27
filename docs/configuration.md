# Configuration Reference

All environment variables consumed by the VacciChain stack. Copy `.env.example` to `.env` and fill in the required values before starting any service.

```bash
cp .env.example .env
```

The backend validates its variables at startup via [Zod](https://zod.dev/). A missing or malformed required variable will print a clear error and exit with code 1 — no cryptic runtime failures.

---

## Startup validation

Configuration is validated **before the HTTP port is bound**. If any check fails the process prints an aggregated report to stderr and exits with code `1`; the server never starts in a half-configured state.

Validation runs in two phases:

1. **Field validation** — each variable is checked against its type/format rule (see the [validation summary](#validation-summary)).
2. **Cross-field validation** — combinations of variables are checked for contradictions (see [cross-field constraints](#cross-field-constraints)).

All failures from both phases are collected and reported together, so a single startup attempt surfaces every problem instead of one at a time.

### Aggregated error format

Each failing check is printed on its own line as `VARIABLE: message`, grouped under a header, followed by a hint:

```
Invalid configuration — 3 problem(s) found:

  HORIZON_URL: must be a valid URL (received "horizon-testnet")
  STELLAR_NETWORK_PASSPHRASE: does not match STELLAR_NETWORK=testnet (expected "Test SDF Network ; September 2015")
  ADMIN_PUBLIC_KEY: does not correspond to ADMIN_SECRET_KEY

Fix the variables above and restart. See docs/configuration.md for details.
```

Cross-field failures name every variable involved so the contradiction is obvious. The process exits with code `1` and no port is bound.

### Cross-field constraints

| Constraint | Rule | Example failure |
|---|---|---|
| Network ↔ Horizon | `HORIZON_URL` host must belong to the network selected by `STELLAR_NETWORK` | `STELLAR_NETWORK=mainnet` with `HORIZON_URL=https://horizon-testnet.stellar.org` |
| Network ↔ Soroban RPC | `SOROBAN_RPC_URL` host must belong to the network selected by `STELLAR_NETWORK` | `STELLAR_NETWORK=testnet` with `SOROBAN_RPC_URL=https://mainnet.sorobanrpc.com` |
| Network ↔ passphrase | `STELLAR_NETWORK_PASSPHRASE` must equal the canonical passphrase for `STELLAR_NETWORK` | `STELLAR_NETWORK=testnet` with the mainnet passphrase |
| Admin key pair | `ADMIN_PUBLIC_KEY` must be the public key derived from `ADMIN_SECRET_KEY` | Public key from a different account |
| Key separation | `SEP10_SERVER_KEY` and `ISSUER_SECRET_KEY` must differ from `ADMIN_SECRET_KEY` | Reusing the admin key as the SEP-10 signer |
| Contract address | `VACCINATIONS_CONTRACT_ID` must be a 56-character `C...` address | `VACCINATIONS_CONTRACT_ID=my-contract` |
| Ports | `PORT` and `ANALYTICS_PORT` must differ | Both set to `4000` |
| Rate limits | `RATE_LIMIT_SEP10` and `RATE_LIMIT_VERIFY` must be positive integers | `RATE_LIMIT_VERIFY=0` |
| Webhook type ↔ secret | `PAGERDUTY_ROUTING_KEY` required when `ALERT_WEBHOOK_TYPE=pagerduty`; `ALERT_EMAIL_TO` required when `ALERT_WEBHOOK_TYPE=email` | `ALERT_WEBHOOK_TYPE=pagerduty` with no routing key |
| Webhook URL | `ALERT_WEBHOOK_URL` must be HTTPS when set | `ALERT_WEBHOOK_URL=http://hooks.example.com` |

### Examples of contradictory configurations

**Wrong network pairing** — mainnet selected but testnet endpoints supplied:

```bash
STELLAR_NETWORK=mainnet
HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
```

**Mismatched admin key pair** — public key does not belong to the secret key:

```bash
ADMIN_SECRET_KEY=SCZANGBA5RLMPI7JMTP2UOF4BIZX4ICOAP7MWKPKZUEZFEKNUMBMFTA
ADMIN_PUBLIC_KEY=GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZWM9CQJKR3BSQNEWVZSR
```

**Webhook type without its secret** — PagerDuty selected but no routing key:

```bash
ALERT_WEBHOOK_TYPE=pagerduty
ALERT_WEBHOOK_URL=https://events.pagerduty.com/v2/enqueue
# PAGERDUTY_ROUTING_KEY is missing
```

**Port collision** — backend and analytics bound to the same port:

```bash
PORT=4000
ANALYTICS_PORT=4000
```

---

## Stellar / Soroban

### `STELLAR_NETWORK`
- Required: yes for deployment and contract invocation tooling (`make deploy`, smoke tests); no for the backend runtime (defaults to `testnet`)
- Default: `testnet` (backend only)
- Allowed values: `testnet` | `mainnet`
- Description: Selects the Stellar network. Controls which network passphrase is used when signing transactions. Must match `HORIZON_URL`, `SOROBAN_RPC_URL`, and `STELLAR_NETWORK_PASSPHRASE`.
- Deployment rule: deployment commands must receive the network **explicitly** (e.g. `make deploy NETWORK=testnet` or `STELLAR_NETWORK=testnet make deploy`). There is no implicit fallback for deployment — omitting the network aborts the command before any transaction is built or signed.
- Example: `STELLAR_NETWORK=testnet`

#### Network-specific configuration validation

Before deploying or invoking the contract, the tooling validates that every network-scoped variable is consistent with the explicitly selected `STELLAR_NETWORK`. A mismatch aborts the command with a non-zero exit code and no transaction is submitted.

| `STELLAR_NETWORK` | Expected `HORIZON_URL` | Expected `SOROBAN_RPC_URL` | Expected `STELLAR_NETWORK_PASSPHRASE` |
|---|---|---|---|
| `testnet` | `https://horizon-testnet.stellar.org` | `https://soroban-testnet.stellar.org` | `Test SDF Network ; September 2015` |
| `mainnet` | `https://horizon.stellar.org` | `https://mainnet.sorobanrpc.com` | `Public Global Stellar Network ; September 2015` |

Validation performed by the deployment tooling:

1. `STELLAR_NETWORK` is set and is one of the allowed values (no default is applied).
2. `HORIZON_URL` and `SOROBAN_RPC_URL` are valid HTTPS URLs and match the selected network's expected host.
3. `STELLAR_NETWORK_PASSPHRASE` exactly matches the selected network's passphrase.
4. `VACCINATIONS_CONTRACT_ID` is a well-formed contract address (56 characters, starts with `C`) and is recorded against the selected network.
5. The deployed contract's on-chain network identity (the network passphrase the contract was deployed under) matches the selected network.
=======

### `HORIZON_URL`
- Required: yes
- Format: valid HTTPS URL
- Description: Horizon REST API endpoint for the chosen network.
- Example (testnet): `HORIZON_URL=https://horizon-testnet.stellar.org`
- Example (mainnet): `HORIZON_URL=https://horizon.stellar.org`

### `SOROBAN_RPC_URL`
- Required: yes
- Format: valid HTTPS URL
- Description: Soroban RPC endpoint used to simulate and submit contract transactions.
- Example (testnet): `SOROBAN_RPC_URL=https://soroban-testnet.stellar.org`
- Example (mainnet): `SOROBAN_RPC_URL=https://mainnet.sorobanrpc.com`

### `STELLAR_NETWORK_PASSPHRASE`
- Required: yes
- Format: non-empty string
- Description: Network passphrase included in every transaction envelope. Must exactly match the target network.
- Example (testnet): `STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015`
- Example (mainnet): `STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015`

### `HORIZON_TIMEOUT_MS`
- Required: no
- Default: `10000`
- Format: positive integer (milliseconds)
- Description: Per-request timeout applied to every Horizon HTTP call. Prevents workers from blocking indefinitely on a slow or unresponsive Horizon endpoint. Exceeding the timeout aborts the request and surfaces a classified `timeout` error.
- Example: `HORIZON_TIMEOUT_MS=10000`

### `SOROBAN_RPC_TIMEOUT_MS`
- Required: no
- Default: `15000`
- Format: positive integer (milliseconds)
- Description: Per-request timeout applied to every Soroban RPC call (simulation, submission, and status polling). Exceeding the timeout aborts the request and surfaces a classified `timeout` error.
- Example: `SOROBAN_RPC_TIMEOUT_MS=15000`

### `SOROBAN_RPC_MAX_RETRIES`
- Required: no
- Default: `3`
- Format: non-negative integer
- Description: Maximum number of retries for Soroban RPC calls. Only idempotent, read-only operations (e.g. `simulateTransaction`, `getTransaction`) are retried. Transaction submission is never retried automatically — a submission that times out is reported as `indeterminate` so callers can reconcile via transaction hash instead of risking a duplicate submission. When retries are exhausted the call fails with a classified error and a structured correlation identifier.
- Example: `SOROBAN_RPC_MAX_RETRIES=3`

### `SOROBAN_RPC_RETRY_BASE_DELAY_MS`
- Required: no
- Default: `250`
- Format: positive integer (milliseconds)
- Description: Base delay for exponential backoff between Soroban RPC retries. The delay for attempt *n* is `SOROBAN_RPC_RETRY_BASE_DELAY_MS * 2^(n-1)`, capped by `SOROBAN_RPC_RETRY_MAX_DELAY_MS`.
- Example: `SOROBAN_RPC_RETRY_BASE_DELAY_MS=250`

### `SOROBAN_RPC_RETRY_MAX_DELAY_MS`
- Required: no
- Default: `4000`
- Format: positive integer (milliseconds)
- Description: Upper bound on the backoff delay between Soroban RPC retries.
- Example: `SOROBAN_RPC_RETRY_MAX_DELAY_MS=4000`

---

## Contract

### `VACCINATIONS_CONTRACT_ID`
- Required: yes
- Format: 56-character Stellar contract address (starts with `C`)
- Description: Deployed address of the VacciChain Soroban contract. Obtained from `make deploy` in the `contracts/` directory. The ID is network-specific — a contract deployed on `testnet` does not exist on `mainnet`. The tooling rejects a contract ID that does not belong to the explicitly selected `STELLAR_NETWORK`.
- Example: `VACCINATIONS_CONTRACT_ID=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`

### `CONTRACT_ARTIFACT_HASH`
- Required: yes for deployment and smoke tests
- Format: 64-character lowercase hex string (SHA-256 of the compiled Wasm artifact)
- Description: Hash of the Wasm artifact that was deployed. `make deploy` records the hash of the uploaded artifact; smoke tests recompute the hash of the local build and compare it against this value to confirm the deployed contract matches the expected artifact. A mismatch fails the smoke test.
- Example: `CONTRACT_ARTIFACT_HASH=9f2c1e7b4a6d8c0e5f3b1a2d4c6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e`

---

## Backend auth

### `ADMIN_SECRET_KEY`
- Required: yes
- Format: 56-character Stellar secret key (starts with `S`)
- Description: Secret key of the account used to sign admin-level contract invocations (e.g. `add_issuer`, `revoke_issuer`). Keep this secret — never commit it.
- Example: `ADMIN_SECRET_KEY=SCZANGBA5RLMPI7JMTP2UOF4BIZX4ICOAP7MWKPKZUEZFEKNUMBMFTA`

### `ADMIN_PUBLIC_KEY`
- Required: yes
- Format: 56-character Stellar public key (starts with `G`)
- Description: Public key corresponding to `ADMIN_SECRET_KEY`. Used by the auth route to assign the `issuer` role when the admin wallet authenticates via SEP-10.
- Example: `ADMIN_PUBLIC_KEY=GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZWM9CQJKR3BSQNEWVZSR`

### `SEP10_SERVER_KEY`
- Required: yes
- Format: 56-character Stellar secret key (starts with `S`)
- Description: Secret key used to sign SEP-10 challenge transactions. Should be a dedicated key, separate from `ADMIN_SECRET_KEY`.
- Example: `SEP10_SERVER_KEY=SBPOVRCGGG65T7FQBV5KCBZ7HNZSZQZQZQZQZQZQZQZQZQZQZQZQZQZ`

### `ISSUER_SECRET_KEY`
- Required: yes
- Format: 56-character Stellar secret key (starts with `S`)
- Description: Secret key used to sign vaccination minting and revocation transactions submitted to the contract. Must correspond to an address authorized as an issuer on-chain.
- Example: `ISSUER_SECRET_KEY=SCZANGBA5RLMPI7JMTP2UOF4BIZX4ICOAP7MWKPKZUEZFEKNUMBMFTA`

### `JWT_SECRET`
- Required: yes
- Format: non-empty string; minimum 32 characters recommended
- Description: Secret used to sign and verify JWTs issued after SEP-10 authentication. Rotate this to invalidate all active sessions.
- Example: `JWT_SECRET=change-me-to-a-long-random-string-in-production`

---

## Backend server

### `PORT`
- Required: no
- Default: `4000`
- Format: positive integer
- Description: TCP port the Express backend listens on.
- Example: `PORT=4000`

### `TRUST_PROXY`
- Required: no
- Default: `false`
- Allowed values: `false` | `true` | `loopback` | `linklocal` | `uniquelocal` | a comma-separated list of IP addresses/CIDR ranges | a non-negative integer (number of trusted hops)
- Description: Value passed to Express `app.set('trust proxy', ...)`. Controls how the client IP is derived from `X-Forwarded-For` / `X-Real-IP`. Must match the deployed load-balancer topology: set `false` when the backend is directly exposed, `1` (or the LB's CIDR) when exactly one trusted proxy sits in front, and so on. When unset or `false`, forwarded headers are ignored and the socket address is used, preventing spoofed headers from bypassing rate limits or corrupting audit attribution.
- Example (single load balancer): `TRUST_PROXY=1`
- Example (known proxy range): `TRUST_PROXY=10.0.0.0/8,192.168.1.10`

---

## Event index persistence

The backend maintains a local event index (SQLite by default) of on-chain vaccination events. The persistence strategy is documented in `docs/persistence-strategy.md`; the variables below select and tune it.

### `DATABASE_PATH`
- Required: no
- Default: `/data/vaccichain.db`
- Format: file path; the parent directory must be writable
- Description: Path to the SQLite database file used for the event index. Ignored when `DATABASE_URL` is set.
- Example: `DATABASE_PATH=/data/vaccichain.db`

### `DATABASE_URL`
- Required: no
- Default: unset (SQLite via `DATABASE_PATH`)
- Format: PostgreSQL connection URL (`postgres://user:pass@host:5432/db`)
- Description: When set, the event index uses the multi-writer PostgreSQL backend instead of SQLite. Required when running more than one backend task against a shared index. See `docs/persistence-strategy.md` for the load and failure analysis and the migration procedure.
- Example: `DATABASE_URL=postgres://vaccichain:secret@db:5432/vaccichain`

### `DATABASE_POOL_SIZE`
- Required: no
- Default: `10`
- Format: positive integer
- Description: Maximum number of pooled connections per backend task when `DATABASE_URL` is set. Size so that `DATABASE_POOL_SIZE × backend task count` stays below the database's `max_connections`.
- Example: `DATABASE_POOL_SIZE=10`

### `DATABASE_BUSY_TIMEOUT_MS`
- Required: no
- Default: `5000`
- Format: positive integer (milliseconds)
- Description: SQLite busy timeout applied to the event index connection. Longer values reduce `SQLITE_BUSY` errors under write contention at the cost of latency.
- Example: `DATABASE_BUSY_TIMEOUT_MS=5000`

### `DATABASE_BACKUP_PATH`
- Required: no
- Default: unset (scheduled backups disabled)
- Format: directory path; must be writable
- Description: Directory where periodic event index backups are written. Backups use SQLite's online backup API (or `pg_dump` for PostgreSQL) and are safe to take while the service is running.
- Example: `DATABASE_BACKUP_PATH=/var/backups/vaccichain`

### `DATABASE_BACKUP_INTERVAL_MINUTES`
- Required: no
- Default: `60`
- Format: positive integer
- Description: How often the event index backup job runs. Only used when `DATABASE_BACKUP_PATH` is set.
- Example: `DATABASE_BACKUP_INTERVAL_MINUTES=60`

---

## Public verification limits

Public verification endpoints (`GET /verify/:wallet`, batch verification) are bounded to protect memory, CPU, and response bandwidth.

### `VERIFY_MAX_RECORDS`
- Required: no
- Default: `100`
- Format: positive integer
- Description: Maximum number of vaccination records returned in a single public record response. When a wallet has more records, the response is truncated and includes pagination metadata (`total`, `returned`, `truncated`, `nextCursor`). Clients page through the remainder with the `cursor` query parameter.
- Example: `VERIFY_MAX_RECORDS=100`

### `VERIFY_MAX_BATCH_SIZE`
- Required: no
- Default: `50`
- Format: positive integer
- Description: Maximum number of wallets accepted in a single batch verification request. Requests above this limit are rejected with HTTP 413 before any lookup work is performed.
- Example: `VERIFY_MAX_BATCH_SIZE=50`

### `VERIFY_MAX_PAGE_SIZE`
- Required: no
- Default: `100`
- Format: positive integer
- Description: Upper bound for the `limit` query parameter on paginated public verification responses. Values above this are clamped to the maximum.
- Example: `VERIFY_MAX_PAGE_SIZE=100`

---

## Batch verification

Controls the size and parallelism of batch verification requests (`POST /verify/batch`). Both values are bounded so a single request cannot overwhelm the backend, the Soroban RPC provider, or the Python worker pool.

### `BATCH_MAX_SIZE`
- Required: no
- Default: `100`
- Format: integer
- Allowed range: `1`–`1000` (values outside the range are rejected at startup)
- Description: Maximum number of items accepted in a single batch verification request. Requests exceeding this limit are rejected with `400` and a structured error; they are not silently truncated.
- Example: `BATCH_MAX_SIZE=100`

### `BATCH_CONCURRENCY`
- Required: no
- Default: `5`
- Format: integer
- Allowed range: `1`–`32` (values outside the range are rejected at startup)
- Description: Maximum number of batch items verified in parallel. Items beyond this are queued. Partial failures are reported per item in the response (`{ index, status, error }`) rather than failing the whole batch.
- Tuning guidance:
  - Keep `BATCH_CONCURRENCY` well below the RPC provider's per-second rate limit.
  - For rate-limited or shared RPC endpoints use `2`–`4`.
  - Do not raise above `16` without load testing — latency degrades and RPC throttling errors increase.
- Example: `BATCH_CONCURRENCY=5`

---

## Rate limiting

Sensitive operations are rate limited per client identity. The client identity is derived from the request using the trusted-proxy configuration below — forwarding headers (`X-Forwarded-For`, `X-Real-IP`) are only honoured when the immediate peer is a trusted proxy, so spoofed headers from untrusted clients are ignored.

### `TRUST_PROXY`
- Required: no
- Default: `false`
- Allowed values: `false` | `true` | positive integer (number of trusted hops) | comma-separated list of trusted proxy IPs/CIDRs
- Description: Controls how the client IP is resolved. When `false`, the socket peer address is always used and forwarding headers are ignored. When set to a number, that many hops from the right of `X-Forwarded-For` are trusted. When set to a list, only requests whose immediate peer matches a listed proxy have forwarding headers honoured.
- Example: `TRUST_PROXY=10.0.0.0/8,172.16.0.0/12`

### `RATE_LIMIT_SEP10`
- Required: no
- Default: `10`
- Format: positive integer
- Description: Maximum SEP-10 challenge requests per client per minute. Protects the challenge endpoint from enumeration and DoS.
- Example: `RATE_LIMIT_SEP10=10`

### `RATE_LIMIT_VERIFY`
- Required: no
- Default: `60`
- Format: positive integer
- Description: Maximum public verification requests (`GET /verify/:wallet`) per client per minute.
- Example: `RATE_LIMIT_VERIFY=60`

### `RATE_LIMIT_ONBOARDING`
- Required: no
- Default: `20`
- Format: positive integer
- Description: Maximum onboarding requests per client per minute.
- Example: `RATE_LIMIT_ONBOARDING=20`

### `RATE_LIMIT_BATCH_VERIFY`
- Required: no
- Default: `10`
- Format: positive integer
- Description: Maximum batch verification requests per client per minute. Batch endpoints are weighted by batch size where applicable.
- Example: `RATE_LIMIT_BATCH_VERIFY=10`

### `RATE_LIMIT_WINDOW_MS`
- Required: no
- Default: `60000`
- Format: positive integer (milliseconds)
- Description: Length of the rate-limit window. All per-operation limits above are expressed per this window.
- Example: `RATE_LIMIT_WINDOW_MS=60000`

### `RATE_LIMIT_STORE`
- Required: no
- Default: `memory`
- Allowed values: `memory` | `redis`
- Description: Backing store for rate-limit counters. Use `memory` for single-instance deployments. Use `redis` when running multiple backend replicas behind a load balancer so limits are enforced across the whole deployment rather than per instance.
- Example: `RATE_LIMIT_STORE=redis`

### `REDIS_URL`
- Required: when `RATE_LIMIT_STORE=redis`
- Format: valid Redis URL (`redis://` or `rediss://`)
- Description: Connection string for the shared rate-limit store. All replicas must point at the same Redis instance.
- Example: `REDIS_URL=redis://redis:6379/0`

### Rate-limit response headers

Every rate-limited response includes standard metadata so clients can back off correctly:

- `RateLimit-Limit` — the configured maximum for the operation in the current window.
- `RateLimit-Remaining` — requests remaining in the current window.
- `RateLimit-Reset` — seconds until the window resets.
- `Retry-After` — seconds to wait before retrying; present on `429 Too Many Requests` responses.

A throttled request returns HTTP `429` with a JSON body of the form `{ "error": "rate_limited", "retryAfter": <seconds> }`.

### Distributed deployment guidance

- Set `TRUST_PROXY` to the exact proxy hops or CIDRs in front of the backend. Never set `TRUST_PROXY=true` on an internet-facing instance without a proxy — it allows clients to spoof their identity via `X-Forwarded-For`.
- When running more than one backend replica, set `RATE_LIMIT_STORE=redis` and a shared `REDIS_URL` so counters are consistent across instances. With `memory`, each replica enforces its own limit, effectively multiplying the allowed rate by the replica count.
- Ensure load balancers preserve the original client address (or append to `X-Forwarded-For`) and that the trusted-proxy list matches the load balancer's egress addresses.

---

## Audit log

### `AUDIT_LOG_PATH`
- Required: no
- Default: `./audit.log` (relative to the backend working directory)
- Format: valid file path; the parent directory must be writable
- Description: Path to the append-only NDJSON audit log file. Each line is a JSON object with `timestamp`, `requestId`, `actor`, `action`, `target`, `result`, and `meta`. Mint, revoke, consent, and administrative changes are always recorded. Never deleted or updated — only appended.
- Example: `AUDIT_LOG_PATH=/var/log/vaccichain/audit.log`

### `AUDIT_LOG_MAX_BYTES`
- Required: no
- Default: `10485760` (10 MiB)
- Format: positive integer (bytes)
- Description: Size at which the current audit log file is rotated. On rotation the active file is renamed with a timestamp suffix and a new file is opened; rotation is atomic with respect to appends.
- Example: `AUDIT_LOG_MAX_BYTES=10485760`

### `AUDIT_LOG_MAX_FILES`
- Required: no
- Default: `10`
- Format: positive integer
- Description: Number of rotated audit log files retained. Older files are deleted once this count is exceeded. Set `0` to retain rotated files indefinitely (not recommended in production).
- Example: `AUDIT_LOG_MAX_FILES=10`

### `AUDIT_LOG_RETENTION_DAYS`
- Required: no
- Default: `90`
- Format: positive integer
- Description: Maximum age (in days) of rotated audit log files. Files older than this are removed by the retention job regardless of `AUDIT_LOG_MAX_FILES`. Set `0` to disable age-based retention.
- Example: `AUDIT_LOG_RETENTION_DAYS=90`

### `AUDIT_LOG_INTEGRITY_KEY`
- Required: no
- Default: unset (hash chaining only)
- Format: non-empty string; minimum 32 characters recommended
- Description: Secret used to compute the HMAC that chains each audit entry to its predecessor, making the log tamper-evident. When unset, entries are still hash-chained but the chain cannot be authenticated. Rotate only together with a documented re-seal procedure (see `docs/audit-log.md`).
- Example: `AUDIT_LOG_INTEGRITY_KEY=change-me-to-a-long-random-string`

### `AUDIT_LOG_VERIFY_ON_START`
- Required: no
- Default: `true`
- Format: boolean (`true` | `false`)
- Description: When enabled, the backend verifies the integrity chain of the active and rotated audit logs at startup and logs a warning (or fails fast, per `AUDIT_LOG_FAIL_ON_INTEGRITY_ERROR`) if a break is detected.
- Example: `AUDIT_LOG_VERIFY_ON_START=true`

### `AUDIT_LOG_FAIL_ON_INTEGRITY_ERROR`
- Required: no
- Default: `false`
- Format: boolean (`true` | `false`)
- Description: When `true`, an integrity verification failure at startup aborts the boot instead of logging a warning. Recommended for production deployments with strict audit requirements.
- Example: `AUDIT_LOG_FAIL_ON_INTEGRITY_ERROR=true`

### `AUDIT_LOG_FAILURE_MODE`
- Required: no
- Default: `fail-closed`
- Allowed values: `fail-closed` | `fail-open`
- Description: Behaviour when an audit entry cannot be written (e.g. disk full, permission error). `fail-closed` rejects the originating mint/revoke/consent/admin request so no action goes unrecorded; `fail-open` allows the action and emits a high-severity alert. `fail-closed` is required for production.
- Example: `AUDIT_LOG_FAILURE_MODE=fail-closed`

---

## Data retention and purge

Retention is enforced by scheduled purge jobs. Each data class has its own retention window; audit and recovery records are protected from deletion.

### `RETENTION_AUDIT_LOG_DAYS`
- Required: no
- Default: `365`
- Format: positive integer (days)
- Description: Retention window for audit log records. Audit records within this window are never purged. Records older than this window may be archived, but the append-only audit log file itself is never truncated in place — see `AUDIT_LOG_PATH`.
- Example: `RETENTION_AUDIT_LOG_DAYS=365`

### `RETENTION_INDEXED_RECORDS_DAYS`
- Required: no
- Default: `180`
- Format: positive integer (days)
- Description: Retention window for off-chain indexed records (e.g. cached vaccination events). Records older than this window are eligible for purge. On-chain data is unaffected.
- Example: `RETENTION_INDEXED_RECORDS_DAYS=180`

### `RETENTION_OPERATIONAL_DATA_DAYS`
- Required: no
- Default: `30`
- Format: positive integer (days)
- Description: Retention window for operational data such as request logs, metrics snapshots, and transient job state. Purely diagnostic — safe to purge aggressively.
- Example: `RETENTION_OPERATIONAL_DATA_DAYS=30`

### `RETENTION_PURGE_SCHEDULE_MINUTES`
- Required: no
- Default: `1440` (once per day)
- Format: positive integer (minutes)
- Description: How often the retention purge job runs. The job deletes only records past their class-specific retention window and skips any record flagged as required for audit or recovery.
- Example: `RETENTION_PURGE_SCHEDULE_MINUTES=1440`

### `RETENTION_PURGE_BATCH_SIZE`
- Required: no
- Default: `500`
- Format: positive integer
- Description: Maximum number of records deleted per batch within a single purge run. Bounds lock time and memory use on large purges.
- Example: `RETENTION_PURGE_BATCH_SIZE=500`

### `RETENTION_DRY_RUN`
- Required: no
- Default: `false`
- Format: boolean (`true` | `false`)
- Description: When `true`, the purge job logs what it would delete without deleting anything. Use to validate retention settings before enabling automated deletion.
- Example: `RETENTION_DRY_RUN=false`

---

## Python analytics service

### `ANALYTICS_PORT`
- Required: no
- Default: `8001`
- Format: positive integer
- Description: TCP port the FastAPI analytics service listens on.
- Example: `ANALYTICS_PORT=8001`

### `BACKEND_URL`
- Required: no (set automatically by Docker Compose)
- Default: `http://backend:4000`
- Format: valid HTTP/HTTPS URL, no trailing slash
- Description: Base URL the analytics service uses to call the backend API. When running outside Docker, point this at the backend host.
- Example: `BACKEND_URL=http://localhost:4000`

---

## Anomaly detection

The Python analytics service runs a periodic job that flags issuers whose mint volume exceeds a configurable threshold and dispatches alerts via webhook.

### `ANOMALY_THRESHOLD`
- Required: no
- Default: `50`
- Format: positive integer
- Description: Number of mints above which an issuer is considered anomalous. The check compares each issuer's total lifetime mint count against this value. Lower values increase sensitivity (more alerts); higher values reduce noise. Start with the default and adjust based on your expected issuer volume.
- Tuning guidance:
  - Testnet / development: set low (e.g. `5`) to exercise the alert path without real data.
  - Production: baseline from 2–4 weeks of normal issuer activity, then set to ~2× the 99th-percentile daily volume per issuer.
- Example: `ANOMALY_THRESHOLD=50`

### `ANOMALY_SCHEDULE_MINUTES`
- Required: no
- Default: `15`
- Format: positive integer
- Description: How often (in minutes) the anomaly detection job runs. The scheduler uses APScheduler with an interval trigger. Shorter intervals catch anomalies faster but increase backend load; longer intervals reduce load but delay detection.
- Tuning guidance:
  - For near-real-time alerting use `5`.
  - For low-traffic deployments `30` or `60` is sufficient.
  - Do not set below `1` — the job itself takes a few seconds.
- Example: `ANOMALY_SCHEDULE_MINUTES=15`

---

## Webhook alerts

When an anomaly is detected the service POSTs a JSON payload to `ALERT_WEBHOOK_URL`. Three payload formats are supported, selected by `ALERT_WEBHOOK_TYPE`.

### `ALERT_WEBHOOK_URL`
- Required: no (alerts are silently skipped when unset)
- Format: valid HTTPS URL
- Description: Endpoint that receives alert POSTs. Must accept `application/json`. Leave empty to disable alerting.
- Slack example URL format: `https://hooks.slack.com/services/<TEAM_ID>/<CHANNEL_ID>/<TOKEN>` (obtain from your Slack app's Incoming Webhooks page)
- Example: `ALERT_WEBHOOK_URL=https://your-webhook-endpoint.example.com/alert`

### `ALERT_WEBHOOK_TYPE`
- Required: no
- Default: `slack`
- Allowed values: `slack` | `pagerduty` | `email`
- Description: Controls the JSON payload shape sent to `ALERT_WEBHOOK_URL`.
- Example: `ALERT_WEBHOOK_TYPE=slack`

### `PAGERDUTY_ROUTING_KEY`
- Required: when `ALERT_WEBHOOK_TYPE=pagerduty`
- Format: 32-character hex string
- Description: PagerDuty Events API v2 integration key. Obtain from your PagerDuty service's "Integrations" tab. Set `ALERT_WEBHOOK_URL` to `https://events.pagerduty.com/v2/enqueue`.
- Example: `PAGERDUTY_ROUTING_KEY=abc123def456abc123def456abc123de`

### `ALERT_EMAIL_TO`
- Required: when `ALERT_WEBHOOK_TYPE=email`
- Format: valid email address
- Description: Recipient address for email alerts. Your `ALERT_WEBHOOK_URL` must point to an HTTP-to-email relay (e.g. a custom endpoint or a service like Mailgun/SendGrid webhooks).
- Example: `ALERT_EMAIL_TO=ops@example.com`

---

### Alert payload formats

**Slack** (`ALERT_WEBHOOK_TYPE=slack`)

```json
{
  "text": "[VacciChain] Anomaly detected — issuer: GABC..., type: high_mint_volume, record_count: 73, timestamp: 2025-01-15T10:30:00+00:00"
}
```

**PagerDuty** (`ALERT_WEBHOOK_TYPE=pagerduty`)

```json
{
  "routing_key": "<PAGERDUTY_ROUTING_KEY>",
  "event_action": "trigger",
  "payload": {
    "summary": "[VacciChain] Anomaly detected — issuer: GABC..., type: high_mint_volume, record_count: 73, timestamp: 2025-01-15T10:30:00+00:00",
    "severity": "warning",
    "source": "vaccichain-analytics",
    "custom_details": {
      "issuer": "GABC...",
      "record_count": 73,
      "timestamp": "2025-01-15T10:30:00+00:00"
    }
  }
}
```

**Email relay** (`ALERT_WEBHOOK_TYPE=email`)

```json
{
  "to": "<ALERT_EMAIL_TO>",
  "subject": "VacciChain Anomaly Alert",
  "body": "[VacciChain] Anomaly detected — issuer: GABC..., type: high_mint_volume, record_count: 73, timestamp: 2025-01-15T10:30:00+00:00"
}
```

---

### Testing alerts in a non-production environment

1. **Use a low threshold** — set `ANOMALY_THRESHOLD=1` so any issuer with more than one mint triggers an alert.

2. **Use a short schedule** — set `ANOMALY_SCHEDULE_MINUTES=1` so you don't wait long.

3. **Slack**: create a free Slack app, add an Incoming Webhook, and paste the URL into `ALERT_WEBHOOK_URL`. Set `ALERT_WEBHOOK_TYPE=slack`.

4. **PagerDuty**: create a free developer account, add a service with the "Events API v2" integration, copy the routing key, and set `ALERT_WEBHOOK_URL=https://events.pagerduty.com/v2/enqueue`.

5. **Local HTTP sink**: run a simple listener (e.g. `python3 -m http.server 9999` or [webhook.site](https://webhook.site)) and point `ALERT_WEBHOOK_URL` at it to inspect raw payloads without sending real notifications.

6. **Trigger manually**: call `GET /analytics/anomalies` on the analytics service — the scheduler calls the same function, so the response confirms what would be flagged.

---

## Deployment and smoke-test requirements

Deployment tooling enforces the following before and after submitting a deployment:

1. **Explicit network** — `STELLAR_NETWORK` must be supplied on the command line or environment; there is no implicit default for deployment commands.
2. **Network-specific configuration** — `HORIZON_URL`, `SOROBAN_RPC_URL`, and `STELLAR_NETWORK_PASSPHRASE` must match the selected network (see the table above).
3. **Contract ID ownership** — the smoke test queries the selected network's RPC for the contract instance and confirms `VACCINATIONS_CONTRACT_ID` exists on that network. A contract ID that resolves on a different network fails the check.
4. **Artifact hash match** — the smoke test recomputes the SHA-256 of the locally built Wasm artifact and compares it with `CONTRACT_ARTIFACT_HASH` (and with the hash recorded at deploy time). Any mismatch fails the smoke test.

Run the smoke test after every deployment:

```bash
make smoke-test NETWORK=testnet
```

The smoke test exits non-zero if the contract ID is not found on the expected network or if the artifact hash does not match.

---

## Validation summary

| Variable | Required | Validated by | Rule |
|---|---|---|---|
| `STELLAR_NETWORK` | yes (deployment) / no (backend) | Zod (backend) + deploy tooling | enum: `testnet` \| `mainnet`; must be explicit for deployment |
| `HORIZON_URL` | yes | Zod (backend) | valid URL |
| `SOROBAN_RPC_URL` | yes | Zod (backend) | valid URL |
| `HORIZON_TIMEOUT_MS` | no | Zod (backend) | positive integer (ms), default 10000 |
| `SOROBAN_RPC_TIMEOUT_MS` | no | Zod (backend) | positive integer (ms), default 15000 |
| `SOROBAN_RPC_MAX_RETRIES` | no | Zod (backend) | non-negative integer, default 3 |
| `SOROBAN_RPC_RETRY_BASE_DELAY_MS` | no | Zod (backend) | positive integer (ms), default 250 |
| `SOROBAN_RPC_RETRY_MAX_DELAY_MS` | no | Zod (backend) | positive integer (ms), default 4000 |
| `STELLAR_NETWORK_PASSPHRASE` | yes | Zod (backend) | non-empty string |
| `VACCINATIONS_CONTRACT_ID` | yes | Zod (backend) + deploy tooling | non-empty string; 56-char contract address; must belong to selected network |
| `CONTRACT_ARTIFACT_HASH` | yes (deployment) | deploy tooling / smoke test | 64-char hex SHA-256 of deployed Wasm artifact |
| `ADMIN_SECRET_KEY` | yes | Zod (backend) | non-empty string |
| `ADMIN_PUBLIC_KEY` | yes | runtime | valid Stellar public key format |
| `SEP10_SERVER_KEY` | yes | Zod (backend) | non-empty string |
| `ISSUER_SECRET_KEY` | yes | runtime | valid Stellar secret key format |
| `JWT_SECRET` | yes | Zod (backend) | non-empty string |
| `PORT` | no | Zod (backend) | positive integer, default 4000 |
| `BATCH_MAX_SIZE` | no | Zod (backend) | integer 1–1000, default 100 |
| `BATCH_CONCURRENCY` | no | Zod (backend) | integer 1–32, default 5 |
| `ALLOWED_ORIGINS` | no | Zod (backend) | comma-separated URLs, default `http://localhost:3000` |
| `SOROBAN_FEE` | no | Zod (backend) | positive integer (stroops), default 100 |
| `SOROBAN_TIP` | no | Zod (backend) | non-negative integer (stroops), default 0 |
| `BODY_LIMIT` | no | Zod (backend) | size string, default `10kb` |
| `EVENT_POLL_INTERVAL_MS` | no | Zod (backend) | positive integer (ms), default 15000 |
| `TRUST_PROXY` | no | Zod (backend) | `false` \| `true` \| named range \| CIDR list \| hop count, default `false` |
| `DATABASE_PATH` | no | Zod (backend) | file path, default `/data/vaccichain.db` |
| `TRUST_PROXY` | no | Zod (backend) | `false` \| `true` \| hop count \| proxy IP/CIDR list, default `false` |
| `RATE_LIMIT_SEP10` | no | Zod (backend) | positive integer, default 10 |
| `RATE_LIMIT_VERIFY` | no | Zod (backend) | positive integer, default 60 |
| `RATE_LIMIT_ONBOARDING` | no | Zod (backend) | positive integer, default 20 |
| `RATE_LIMIT_BATCH_VERIFY` | no | Zod (backend) | positive integer, default 10 |
| `RATE_LIMIT_WINDOW_MS` | no | Zod (backend) | positive integer (ms), default 60000 |
| `RATE_LIMIT_STORE` | no | Zod (backend) | enum: `memory` \| `redis`, default `memory` |
| `REDIS_URL` | when store=redis | Zod (backend) | valid `redis://` or `rediss://` URL |
| `AUDIT_LOG_PATH` | no | runtime | writable path, default `./audit.log` |
| `RETENTION_AUDIT_LOG_DAYS` | no | Zod (backend) | positive integer (days), default 365 |
| `RETENTION_INDEXED_RECORDS_DAYS` | no | Zod (backend) | positive integer (days), default 180 |
| `RETENTION_OPERATIONAL_DATA_DAYS` | no | Zod (backend) | positive integer (days), default 30 |
| `RETENTION_PURGE_SCHEDULE_MINUTES` | no | Zod (backend) | positive integer (minutes), default 1440 |
| `RETENTION_PURGE_BATCH_SIZE` | no | Zod (backend) | positive integer, default 500 |
| `RETENTION_DRY_RUN` | no | Zod (backend) | boolean, default `false` |
| `ANALYTICS_PORT` | no | runtime | positive integer, default 8001 |
| `BACKEND_URL` | no | runtime | valid URL, default set by Compose |
| `LOG_LEVEL` | no | runtime | Python logging level, default `INFO` |
| `ANOMALY_THRESHOLD` | no | runtime | positive integer, default 50 |
| `ANOMALY_SCHEDULE_MINUTES` | no | runtime | positive integer, default 15 |
| `ALERT_WEBHOOK_URL` | no | runtime | valid HTTPS URL; alerts disabled if unset |
| `ALERT_WEBHOOK_TYPE` | no | runtime | enum: `slack` \| `pagerduty` \| `email`, default `slack` |
| `PAGERDUTY_ROUTING_KEY` | when type=pagerduty | runtime | 32-char hex string |
| `ALERT_EMAIL_TO` | when type=email | runtime | valid email address |
| `EGRESS_ALLOWLIST` | no | runtime | comma-separated DNS names |
| `INTERNAL_API_ALLOWLIST` | no | runtime | comma-separated internal DNS names |
| `NAT_GATEWAY_ENABLED` | no | runtime | boolean, default `true` |
| `AUTOSCALING_ENABLED` | no | runtime | boolean, default `false` |
| `AUTOSCALING_MIN_TASKS` | no | runtime | positive integer, default 1 |
| `AUTOSCALING_MAX_TASKS` | no | runtime | positive integer `>=` min, default 4 |
| `AUTOSCALING_TARGET_CPU_PERCENT` | no | runtime | integer 1–100, default 70 |
| `AUTOSCALING_SCALE_OUT_COOLDOWN_SECONDS` | no | runtime | positive integer, default 60 |
| `AUTOSCALING_SCALE_IN_COOLDOWN_SECONDS` | no | runtime | positive integer, default 300 |
| `SINGLE_WRITER_MODE` | no | runtime | boolean, default `true` |
