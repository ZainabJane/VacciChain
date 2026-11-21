# API Reference — VacciChain

Base URL: `http://localhost:4000/v1`

This document lists primary endpoints, request/response schemas, authentication requirements, and examples.

## Authentication

- SEP-10 flow issues a JWT on successful verification.
- Include JWT as `Authorization: Bearer <token>` for protected endpoints.

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

Response (201):
```json
{
  "token_id": "abc123",
  "contract_tx": "<hash>",
  "issued_at": "2026-05-01T12:34:56Z"
}
```

Errors:
- 400: validation error (missing fields)
- 403: issuer not authorized (issuer not `Active`)
- 409: duplicate record detected (see Duplicate-record detection)

---

## GET /vaccination/:wallet

Fetch all vaccination records for a wallet.

Response (200):
```json
{
  "wallet": "G...",
  "records": [
    { "token_id": "abc123", "vaccine":"COVID-19", "date":"2026-05-01", "issuer":"G..." }
  ]
}
```

Errors:
- 404: wallet not found (no records)

Revoked records are excluded from `records`; see Revocation semantics.

---

## GET /verify/:wallet

Public endpoint returning aggregated verification result.

Response (200):
```json
{
  "wallet": "G...",
  "verified": true,
  "records": [ { "vaccine":"COVID-19", "date":"2026-05-01", "issuer":"G..." } ]
}
```

Errors:
- 400: malformed wallet address

Revoked records are excluded and never counted as valid; see Revocation semantics.

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
Response: `{"results": [{"wallet":"G...","verified":true}]}`

---

For full endpoint listings, examples, and error codes, see the `backend/src/routes` implementations and expand this document as needed.
