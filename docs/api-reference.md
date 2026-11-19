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
- 403: issuer not authorized
- 409: duplicate record detected
- 422: patient consent absent or revoked (see Consent & Allowlist Semantics)

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
