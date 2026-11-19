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

## Issuer authorization cache

Issuer authorization decisions are cached to reduce contract lookups. The cache is revocation-aware:

- **TTL:** cached issuer permissions expire after 60 seconds (the documented revocation window). A revoked issuer can therefore mint for at most 60 seconds after revocation.
- **Invalidation on add:** when an issuer is added, the cache entry for that issuer is invalidated immediately so the new permission takes effect without waiting for TTL expiry.
- **Invalidation on revoke:** when an issuer is revoked, the cache entry for that issuer is invalidated immediately, so subsequent mint requests are rejected as soon as the revocation is observed.
- **Consistency guarantee:** revoked issuers cannot mint after the 60-second revocation window has elapsed, even if invalidation events are missed.

---

For full endpoint listings, examples, and error codes, see the `backend/src/routes` implementations and expand this document as needed.
