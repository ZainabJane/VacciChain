# API Reference — VacciChain

Base URL: `http://localhost:4000/v1`

This document lists primary endpoints, request/response schemas, authentication requirements, and examples.

## Authentication

- SEP-10 flow issues a JWT on successful verification.
- Include JWT as `Authorization: Bearer <token>` for protected endpoints.

---

## Rate limiting

Sensitive endpoints are rate limited per trusted client identity. The client
identity is derived from the connection's remote address; forwarding headers
(`X-Forwarded-For`, `X-Real-IP`, `Forwarded`) are only honored when the request
arrives from a configured trusted proxy. Spoofed forwarding headers from
untrusted peers are ignored.

Rate-limited endpoints:

- `POST /auth/sep10`
- `POST /auth/verify`
- `GET /verify/:wallet` (public verification)
- Onboarding endpoints
- `POST /batch/verify` (analytics service)

Every rate-limited response includes:

- `RateLimit-Limit`: maximum requests permitted in the current window
- `RateLimit-Remaining`: requests remaining in the current window
- `RateLimit-Reset`: seconds until the window resets
- `Retry-After`: seconds to wait before retrying (present on 429 responses)

When a limit is exceeded the endpoint returns 429 with a documented body:

```json
{
  "error": "rate_limited",
  "retryAfter": 30
}
```

`retryAfter` is the number of seconds until the client may retry, matching the
`Retry-After` header.

---

## POST /auth/sep10

Generates a SEP-10 challenge transaction for the provided public key.

Request:
```json
{ "public_key": "G..." }
```

Response (200):
```json
{ "challenge": "<base64-xdr>" }
```

Errors:
- 400: missing or invalid `public_key`

---

## POST /auth/verify

Verify signed SEP-10 challenge and return JWT.

Request:
```json
{ "signed_xdr": "<base64-xdr>" }
```

Response (200):
```json
{ "token": "<jwt>", "expires_in": 3600 }
```

Errors:
- 401: invalid signature or expired challenge

---

## Revocation semantics

Revocation is **record-level and irreversible**. Revoking a vaccination record affects only that individual record; it does not revoke the patient's wallet, does not revoke the issuer's permission, and does not affect any other record held by the same wallet or issued by the same issuer.

- **Scope:** a single `token_id`. Other records for the same wallet remain valid and verifiable.
- **Irreversibility:** a revoked record cannot be un-revoked or re-issued with the same `token_id`. Re-vaccination must mint a new record.
- **Event representation:** each revocation emits a `revoke` contract event containing `{ token_id, issuer, revoked_at }`. Verifiers must treat any record with a `revoke` event as invalid regardless of other fields.
- **Verifier interpretation:** `GET /verify/:wallet` excludes revoked records from `records` and reports `verified: true` only if at least one non-revoked record remains (per policy). Revoked records are never counted as valid.

---

## Duplicate-record detection

The duplicate key is defined as the normalized tuple `(patient_wallet, vaccine, date, batch)`:

- `patient_wallet` is normalized to its canonical Stellar public key form.
- `vaccine` and `batch` are trimmed, case-folded, and internal whitespace collapsed.
- `date` is normalized to ISO-8601 `YYYY-MM-DD`.

Formatting variants that normalize to the same tuple are treated as duplicates. Uniqueness is enforced atomically in the contract, so concurrent submissions cannot both succeed. Legitimate repeat doses are distinguished by a different `date` or `batch` and are therefore not duplicates.

Errors:
- 409: duplicate record detected (normalized key already exists)

---

## Issuer lifecycle

Issuers move through the following states: `Active`, `Revoked`, `Removed`.

Allowed transitions:
- `Active -> Revoked` (revoke issuer permission)
- `Active -> Removed` (administrator removal)
- `Removed -> Active` (re-add)
- `Revoked -> Active` (re-add)

Disallowed transitions (return an error, no state change):
- `Revoked -> Removed`, `Removed -> Revoked`
- Any transition from a non-existent issuer

Repeated operations are idempotent where the target state already holds (e.g. revoking an already-`Revoked` issuer is a no-op success); conflicting transitions return an explicit error. Every transition emits an auditable event `{ issuer, from_state, to_state, actor, timestamp }`.

---

## Administrator rotation and recovery

Administrator key rotation and recovery use a threshold proposal/acceptance flow:

- **Threshold:** a configurable number of current administrators must approve a rotation proposal.
- **Delay:** an approved proposal takes effect only after a configurable delay, during which it can be cancelled.
- **Cancellation:** any current administrator may cancel a pending proposal before it executes.
- **Emergency:** an emergency path may bypass the delay only when the threshold is met and is recorded as an auditable emergency event.
- **Expiry and replay:** proposals expire after a configured window; expired or already-executed proposals are rejected to prevent replay.

Endpoints:
- `POST /admin/rotation/propose` — create a rotation proposal (admin-only)
- `POST /admin/rotation/approve` — approve a pending proposal (admin-only)
- `POST /admin/rotation/cancel` — cancel a pending proposal (admin-only)
- `POST /admin/rotation/execute` — execute an approved, matured proposal
- `POST /admin/recovery/emergency` — initiate emergency recovery (threshold required)

Errors:
- 401/403: unauthorized or insufficient approvals
- 409: proposal expired, already executed, or replayed

---

## POST /vaccination/issue

Mint a vaccination NFT for a patient. Issuer-only action.

Headers:
- `Authorization: Bearer <issuer_jwt>`
- `Idempotency-Key: <opaque-client-key>` (optional but strongly recommended)

Request body:
```json
{
  "patient_wallet": "G...",
  "vaccine": "COVID-19",
  "date": "2026-05-01",
  "batch": "BATCH-123",
  "metadata": { "lot": "L-123" }
}
```

Date and time semantics:

- `date` is a **date-only** field in ISO 8601 calendar form `YYYY-MM-DD`. It
  represents the calendar date of vaccination and carries no time zone; it is
  never converted or shifted between time zones.
- Timestamp fields (e.g. `issued_at`) are **UTC timestamps** in RFC 3339 form
  with an explicit `Z` or numeric offset (e.g. `2026-05-01T12:34:56Z`). They are
  normalized to UTC for storage and indexing.
- Ambiguous values are rejected with 400: date-times supplied for `date`,
  date-only values supplied for timestamp fields, missing offsets on timestamp
  fields, and invalid calendar dates (e.g. `2026-02-30`).
- Leap days (`2024-02-29`) are valid date-only values; non-leap `02-29` is
  rejected.

Response (201):
```json
{
  "token_id": "abc123",
  "contract_tx": "<hash>",
  "issued_at": "2026-05-01T12:34:56Z"
}
```

Errors:
- 400: validation error (missing fields, ambiguous or invalid date/timestamp)
- 403: issuer not authorized (issuer not `Active`)
- 409: duplicate record detected (see Duplicate-record detection)
- 429: rate limited (see Rate limiting)

### Idempotency contract

Mint requests are idempotent end to end when an `Idempotency-Key` header is supplied.

- **Scope:** a key is scoped to the authenticated issuer *and* a hash of the normalized request payload. The same key used by a different issuer, or with a different payload, is a distinct request.
- **Persistence:** key → outcome mappings are stored durably and survive service restarts.
- **Replay:** repeating the same request (same issuer, same key, same payload) returns the original outcome — the original status code and response body — without minting a second record.
- **Conflict:** reusing a key with a different payload for the same issuer returns `409` with an idempotency conflict error.
- **TTL:** idempotency records are retained for 24 hours after the original request; keys may be reused after expiry.
- Requests without an `Idempotency-Key` are processed normally and are not deduplicated.

---

## GET /vaccination/:wallet

Fetch vaccination records for a wallet, paginated.

Query parameters:
- `page` (integer, default `1`, minimum `1`): 1-based page number.
- `limit` (integer, default `20`, minimum `1`, maximum `100`): page size. Requests above the maximum are rejected.

Ordering is stable: records are sorted by `created_at` descending, then by `token_id` descending as a tiebreaker. This ordering is deterministic across pages, so records added during pagination appear at the front and do not cause existing records to be skipped or duplicated within a page boundary.

Response (200):
```json
{
  "wallet": "G...",
  "data": [
    { "token_id": "abc123", "vaccine":"COVID-19", "date":"2026-05-01", "issuer":"G..." }
  ],
  "total": 42,
  "page": 1,
  "limit": 20,
  "has_more": true,
  "next_page": 2
}
```

Metadata fields:
- `data`: records for the current page.
- `total`: total number of records for the wallet.
- `page`: current page number.
- `limit`: effective page size.
- `has_more`: `true` when further pages exist.
- `next_page`: next page number, or `null` on the last page.

An empty dataset returns `200` with `data: []`, `total: 0`, `has_more: false`, and `next_page: null`. A page beyond the last page returns `200` with an empty `data` array.

Errors:
- 400: invalid `page` or `limit` (non-integer, below minimum, or above the maximum page size)
- 404: wallet not found (no records)

Revoked records are excluded from `records`; see Revocation semantics.

---

## GET /verify/:wallet

Public endpoint returning aggregated verification result.

The response always includes a `status` field that distinguishes the four possible data states. Clients MUST branch on `status` and MUST NOT treat `verified` alone as a medical determination.

| `status` | Meaning | `verified` | Interpretation |
|----------|---------|------------|----------------|
| `valid` | All expected records are present and none are revoked. | `true` | Records exist and are currently valid. |
| `revoked` | One or more records exist but have been revoked on-chain. | `false` | Do not treat as verified; revoked records are not valid. |
| `absent` | The wallet has no vaccination records. | `false` | No determination can be made. |
| `unavailable` | Records could not be retrieved (RPC/contract failure, timeout, or indexer error). | `false` | Unknown state — MUST NOT be interpreted as valid verification. |

Response (200) — valid:
```json
{
  "wallet": "G...",
  "status": "valid",
  "verified": true,
  "records": [ { "vaccine":"COVID-19", "date":"2026-05-01", "issuer":"G..." } ]
}
```

Response (200) — revoked:
```json
{
  "wallet": "G...",
  "status": "revoked",
  "verified": false,
  "records": [ { "vaccine":"COVID-19", "date":"2026-05-01", "issuer":"G...", "revoked": true } ]
}
```

Response (200) — absent:
```json
{ "wallet": "G...", "status": "absent", "verified": false, "records": [] }
```

Response (200) — unavailable:
```json
{ "wallet": "G...", "status": "unavailable", "verified": false, "records": [] }
```

Errors:
- 400: malformed wallet address
- 429: rate limited (see Rate limiting)

Revoked records are excluded and never counted as valid; see Revocation semantics.

> **Rule:** An RPC or contract failure MUST NOT be collapsed into a positive verification result. When data cannot be retrieved, the endpoint returns `status: "unavailable"` with `verified: false`; it never returns `verified: true` for missing, revoked, or unavailable data. This endpoint reports record state only and is not a medical determination.

Public verification never returns prohibited fields. The following are omitted from
`/verify/:wallet` responses regardless of consent state:
- `metadata` (free-form issuer metadata, e.g. lot numbers)
- `batch`
- `patient_wallet` linkage beyond the queried wallet itself
- any internal `contract_tx` or storage keys

Only `vaccine`, `date`, and `issuer` are exposed per record. Public-chain data is
not private; this endpoint only limits what the API surfaces.

---

## Consent & Allowlist Semantics

Issuance requires the patient wallet to be allowlisted and consent to be granted.
Consent state transitions and API behavior:

| Consent state | Issuance (`POST /vaccination/issue`) | Verification (`GET /verify/:wallet`) |
|---------------|--------------------------------------|--------------------------------------|
| Absent        | 422 `CONSENT_ABSENT`                 | Records hidden; `verified: false`    |
| Granted       | 201 (allowed)                        | Records returned (public fields only)|
| Revoked       | 422 `CONSENT_REVOKED`                | Records hidden; `verified: false`    |
| Changed       | 422 `CONSENT_CHANGED` (re-consent required) | Reflects latest granted scope |

An unauthorized issuance (issuer not allowlisted or consent not granted) is
rejected before any contract call is made.

---

## Contract Function & Error-Code Compatibility

Contract function arguments and error codes are versioned for stable caller semantics.

- Public contract methods: `issue`, `revoke`, `verify`, `get_record`.
- Authorization: only allowlisted issuers may call `issue`/`revoke`; `verify`/`get_record` are read-only.
- Error codes are stable; new codes may be added but existing codes never change meaning.

Backend maps contract errors to stable API responses:

| Contract error | HTTP status | API error code        |
|----------------|-------------|-----------------------|
| `Unauthorized` | 403         | `ISSUER_UNAUTHORIZED` |
| `Duplicate`    | 409         | `DUPLICATE_RECORD`    |
| `ConsentAbsent`| 422         | `CONSENT_ABSENT`      |
| `ConsentRevoked`| 422        | `CONSENT_REVOKED`     |
| `ConsentChanged`| 422        | `CONSENT_CHANGED`     |
| `InvalidArgs`  | 400         | `VALIDATION_ERROR`    |
| `NotFound`     | 404         | `NOT_FOUND`           |

Version-specific behavior is documented alongside each contract release; callers
should rely on the API error codes above rather than raw contract error strings.

---

## Verifier API Keys

Third-party verifiers authenticate with an API key instead of a JWT. Keys are
provisioned by an admin, individually scoped, rotatable, and revocable.

### Key format and storage

- Keys are returned **once** at creation time in the form `vck_<prefix>_<secret>`.
- Only a verifiable hash of the secret is stored server-side; the plaintext key is
  never persisted or retrievable again.
- The `<prefix>` portion is stored in clear text so keys can be identified in
  audit logs without exposing the secret.

### Header contract

Send the key on every verifier request:

```
X-API-Key: vck_<prefix>_<secret>
```

Errors:
- 401: missing, malformed, unknown, revoked, or expired key
- 403: key is valid but lacks the scope required by the endpoint

### Scopes

Each key is created with an explicit list of scopes. Supported scopes:

| Scope | Grants access to |
| --- | --- |
| `verify:read` | `GET /verify/:wallet` |
| `records:read` | `GET /vaccination/:wallet` |
| `records:write` | `POST /vaccination/issue` (issuer keys only) |

Requests to endpoints outside the key's scopes return `403`.

### Lifecycle

1. **Provision** — an admin creates a key with a label and scopes. The plaintext
   key is returned in the response and must be stored by the verifier.
2. **Rotate** — an admin rotates a key, producing a new secret. The previous
   secret remains valid until the end of the configured grace period (default
   24 hours), after which it stops authenticating.
3. **Revoke** — an admin revokes a key immediately. Revoked keys fail with `401`
   and cannot be reactivated; provision a new key instead.

### Audit events

Every lifecycle action and authentication failure is recorded with the key
prefix, actor, timestamp, and outcome. Emitted events:

- `api_key.created`
- `api_key.rotated`
- `api_key.revoked`
- `api_key.auth_failed` (reason: `unknown`, `revoked`, `expired`, `scope_denied`)

---

## POST /admin/api-keys

Provision a new verifier API key. Admin-only.

Headers:
- `Authorization: Bearer <admin_jwt>`

Request:
```json
{
  "label": "Clinic A verifier",
  "scopes": ["verify:read", "records:read"]
}
```

Response (201):
```json
{
  "id": "key_01H...",
  "prefix": "vck_ab12cd",
  "api_key": "vck_ab12cd_<secret>",
  "scopes": ["verify:read", "records:read"],
  "created_at": "2026-05-01T12:34:56Z"
}
```

Errors:
- 400: missing label or unknown scope
- 403: caller is not an admin

---

## POST /admin/api-keys/:id/rotate

Rotate the secret for an existing key. Admin-only.

Headers:
- `Authorization: Bearer <admin_jwt>`

Request:
```json
{ "grace_period_seconds": 86400 }
```

Response (200):
```json
{
  "id": "key_01H...",
  "prefix": "vck_ab12cd",
  "api_key": "vck_ab12cd_<new_secret>",
  "previous_valid_until": "2026-05-02T12:34:56Z"
}
```

Errors:
- 404: key not found
- 409: key is revoked

---

## DELETE /admin/api-keys/:id

Revoke a key immediately. Admin-only.

Headers:
- `Authorization: Bearer <admin_jwt>`

Response (204): no body.

Errors:
- 404: key not found

---

## Analytics (Python service)

Base URL: `http://localhost:8001`

### GET /analytics/rates
Response:
```json
{ "by_vaccine": { "COVID-19": 1234 } }
```

### POST /batch/verify
Request: `{"wallets": ["G...", "G..."]}`
Response: `{"results": [{"wallet":"G...","status":"valid","verified":true}]}`

Each result carries the same `status` enum as `GET /verify/:wallet` (`valid`, `revoked`, `absent`, `unavailable`). Entries with `status: "unavailable"` indicate a retrieval failure and MUST NOT be interpreted as valid verification.

Errors:
- 429: rate limited (see Rate limiting)

---

## Issuer authorization cache

Issuer authorization decisions are cached to reduce contract lookups. The cache is revocation-aware:

- **TTL:** cached issuer permissions expire after 60 seconds (the documented revocation window). A revoked issuer can therefore mint for at most 60 seconds after revocation.
- **Invalidation on add:** when an issuer is added, the cache entry for that issuer is invalidated immediately so the new permission takes effect without waiting for TTL expiry.
- **Invalidation on revoke:** when an issuer is revoked, the cache entry for that issuer is invalidated immediately, so subsequent mint requests are rejected as soon as the revocation is observed.
- **Consistency guarantee:** revoked issuers cannot mint after the 60-second revocation window has elapsed, even if invalidation events are missed.

---

For full endpoint listings, examples, and error codes, see the `backend/src/routes` implementations and expand this document as needed.
