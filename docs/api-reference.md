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

> **Rule:** An RPC or contract failure MUST NOT be collapsed into a positive verification result. When data cannot be retrieved, the endpoint returns `status: "unavailable"` with `verified: false`; it never returns `verified: true` for missing, revoked, or unavailable data. This endpoint reports record state only and is not a medical determination.

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

---

For full endpoint listings, examples, and error codes, see the `backend/src/routes` implementations and expand this document as needed.
