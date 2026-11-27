# Public Vaccination Verification Endpoint

## Overview

A new public endpoint `GET /verify/public/:wallet` has been added to allow third-party integrators and verification pages to check vaccination status without authentication.

## Endpoints

### Public Endpoint (No Authentication)
```
GET /v1/verify/public/:wallet
```

**Description:** Check vaccination status for any wallet without authentication.

**Parameters:**
- `wallet` (path, required): Stellar public key (56 characters, starts with 'G')
- `limit` (query, optional): Maximum number of records to return. Default `20`, maximum `100`. Values above the maximum are clamped to `100`.
- `cursor` (query, optional): Opaque pagination cursor returned as `next_cursor` in a previous response. Omit to start from the newest record.

**Response (200 OK):**
```json
{
  "wallet": "GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF",
  "status": "valid",
  "verified": true,
  "records": [
    {
      "token_id": "12345",
      "vaccine_name": "Pfizer-BioNTech",
      "date_administered": "2024-01-15T10:30:00Z",
      "dose_number": 1,
      "dose_series": 2,
      "revoked": false
    }
  ],
  "record_count": 1,
  "truncated": false,
  "next_cursor": null
}
```

**Response fields:**
- `records`: At most `limit` records (never more than `100`).
- `record_count`: Number of records in this response (`records.length`).
- `truncated`: `true` when more records exist beyond this page.
- `next_cursor`: Cursor for the next page, or `null` when `truncated` is `false`.

### Verification Status Values

The `status` field is the authoritative signal for interpreting a response. It
takes exactly one of the following values:

| `status` | Meaning | `verified` | `records` |
|----------|---------|------------|-----------|
| `valid` | At least one non-revoked record was returned by the contract | `true` | Non-empty |
| `revoked` | Records exist but every record has been revoked | `false` | Non-empty (each with `revoked: true`) |
| `absent` | The contract responded successfully and holds no records for this wallet | `false` | `[]` |
| `unavailable` | The contract could not be queried (RPC timeout, node error, partial read) | `false` | `[]` |

`verified` is `true` **only** when `status` is `valid`. Clients MUST branch on
`status` (or on `verified === true`) and MUST NOT infer a positive result from
the mere presence of a 200 response.

**Error Responses:**

| Status | Condition |
|--------|-----------|
| 400 | Invalid wallet format, invalid `limit` (non-integer or `< 1`), or malformed/expired `cursor` |
| 413 | Request body exceeds the batch size limit (batch endpoint only) |
| 429 | Rate limit exceeded (60 requests/min per IP) |
| 503 | RPC timeout or service unavailable (`status: "unavailable"`) |
| 500 | Contract query failed (`status: "unavailable"`) |

> **Never collapse failures into a positive result.** An RPC failure, timeout,
> partial history read, or contract error MUST NOT be reported as
> `verified: true` or `status: "valid"`. Such conditions are always surfaced as
> `status: "unavailable"` (with a 5xx status code) or `status: "absent"` when
> the contract positively confirms there are no records. Treating an error as
> "no records found" or as a successful verification is prohibited.

## Size and Work Limits

Public verification responses and batch inputs are bounded so that large record histories or batch inputs cannot exhaust memory, CPU, or response bandwidth.

| Limit | Value | Behavior at limit | Behavior above limit |
|-------|-------|-------------------|----------------------|
| Records per page (`limit`) | Default `20`, max `100` | Returns exactly `100` records, `truncated: true` if more exist | `limit` clamped to `100` (no error) |
| Records scanned per request | `500` | Full scan allowed | Scan stops at `500`; response marked `truncated: true` with `next_cursor` |
| Response body size | `256 KiB` | Response returned as-is | Records trimmed from the tail until the body fits; `truncated: true` |
| Batch wallets per request | `50` | Accepted | `413` with `error: "batch_too_large"` |
| Batch response size | `1 MiB` | Response returned as-is | `413` with `error: "batch_response_too_large"`; split into smaller batches |

### Pagination and Truncation Semantics

- Records are ordered newest-first; pagination is stable for a given cache window (60 seconds).
- `truncated: true` means the client MUST follow `next_cursor` to obtain the remaining records.
- `truncated: false` with `next_cursor: null` means the full history has been returned.
- A `limit` above `100` is silently clamped; clients should not rely on receiving more than `100` records per page.
- If the response body would exceed `256 KiB`, the tail of `records` is dropped and `truncated` is set to `true`; `next_cursor` points at the first dropped record.
- Cursors are opaque, single-use-safe (idempotent), and expire after 5 minutes; an expired cursor returns `400` with `error: "invalid_cursor"`.

### Boundary Examples

**Below the limit** — wallet with 5 records, `limit=20`:
```json
{ "wallet": "G...", "verified": true, "records": [ /* 5 items */ ], "record_count": 5, "truncated": false, "next_cursor": null }
```

**At the limit** — wallet with exactly 100 records, `limit=100`:
```json
{ "wallet": "G...", "verified": true, "records": [ /* 100 items */ ], "record_count": 100, "truncated": false, "next_cursor": null }
```

**Above the limit** — wallet with 250 records, `limit=100`:
```json
{ "wallet": "G...", "verified": true, "records": [ /* 100 items */ ], "record_count": 100, "truncated": true, "next_cursor": "eyJvZmZzZXQiOjEwMH0" }
```
Follow-up request with `cursor=eyJvZmZzZXQiOjEwMH0` returns the next 100 records (`truncated: true`), and the third page returns the final 50 (`truncated: false`, `next_cursor: null`).

**Above the scan limit** — wallet with 900 records, `limit=100`:
The first page scans at most `500` records, returns `100`, and `next_cursor` continues from the scan boundary. Subsequent pages continue until the history is exhausted.

**Batch above the limit** — 51 wallets in one batch request:
```json
{ "error": "batch_too_large", "message": "Batch supports at most 50 wallets per request", "max_batch_size": 50 }
```

### Authenticated Endpoint (Existing)
```
GET /v1/verify/:wallet
```

**Description:** Check vaccination status with authentication (JWT or API key).

**Authentication:** Required (Bearer token or X-API-Key header)

**Response (200 OK):**
```json
{
  "wallet": "GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF",
  "vaccinated": true,
  "verified": true,
  "record_count": 1,
  "records": [
    {
      "token_id": "12345",
      "vaccine_name": "Pfizer-BioNTech",
      "date_administered": "2024-01-15T10:30:00Z",
      "dose_number": 1,
      "dose_series": 2
    }
  ]
}
```

## Key Features

### No Authentication Required
- Public endpoint accessible without JWT or API key
- Ideal for verification pages and third-party integrators
- IP-based rate limiting only

### Wallet Format Validation
- Validates Stellar public key format before querying contract
- Returns 400 with error message for invalid format
- Prevents unnecessary RPC calls

### Response Caching
- Results cached for **60 seconds** to reduce RPC load
- Cache key: wallet address
- Shared cache between public and authenticated endpoints
- Reduces blockchain query overhead

### Rate Limiting
- **60 requests per minute per IP** (configurable via `RATE_LIMIT_VERIFY` env var)
- Returns 429 with `Retry-After` header when exceeded
- Prevents abuse and DDoS attacks

### Simplified Response Schema
- Public endpoint returns minimal schema: `{ wallet, status, verified, records }`
- Authenticated endpoint returns detailed schema: `{ wallet, status, vaccinated, verified, record_count, records }`
- Cleaner API for public consumers
- `status` distinguishes `valid`, `revoked`, `absent`, and `unavailable` data

### Bounded Response Size
- Records per page capped at `100` (default `20`)
- Response body capped at `256 KiB`; excess records are truncated with `truncated: true`
- Batch requests capped at `50` wallets and `1 MiB` response size
- Prevents unbounded histories from exhausting memory, CPU, or bandwidth

### Not a Medical Determination
- Responses describe on-chain record state only; they are **not** a medical
  determination, diagnosis, or proof of immunity
- `status: "absent"` or `status: "unavailable"` MUST NOT be interpreted as
  evidence that a person is unvaccinated
- Consumers must present `unavailable` as "could not be determined" rather than
  as a negative result

## Usage Examples

### cURL
```bash
# Public endpoint (no auth)
curl -X GET "https://api.vaccichain.example.com/v1/verify/public/GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF"

# Authenticated endpoint (with JWT)
curl -X GET "https://api.vaccichain.example.com/v1/verify/GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF" \
  -H "Authorization: Bearer <token>"

# Authenticated endpoint (with API key)
curl -X GET "https://api.vaccichain.example.com/v1/verify/GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF" \
  -H "X-API-Key: <api-key>"
```

### JavaScript/Fetch
```javascript
// Public endpoint
const wallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF';
const response = await fetch(`/v1/verify/public/${wallet}`);
const data = await response.json();

switch (data.status) {
  case 'valid':
    console.log(`Wallet has ${data.records.length} vaccination records`);
    break;
  case 'revoked':
    console.log('All vaccination records have been revoked');
    break;
  case 'absent':
    console.log('No vaccination records found');
    break;
  case 'unavailable':
    console.log('Verification could not be determined; try again later');
    break;
}
```

### Python
```python
import requests

wallet = 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5UXVJ5BNLHF'
response = requests.get(f'https://api.vaccichain.example.com/v1/verify/public/{wallet}')
data = response.json()

if response.status_code == 200:
    print(f"Status: {data['status']}")
    print(f"Verified: {data['verified']}")
    print(f"Records: {len(data['records'])}")
elif response.status_code == 400:
    print(f"Invalid wallet: {data['error']}")
elif response.status_code == 429:
    print("Rate limit exceeded")
elif response.status_code in (500, 503):
    # Never treat this as a positive verification result
    print("Verification unavailable; status could not be determined")
```

## Implementation Details

### Middleware Stack
```
Request
  ↓
Wallet format validation (validateStellarPublicKey)
  ↓
Rate limiter (verifyLimiter - 60 req/min per IP)
  ↓
Route handler
  ├─ Check cache (60 second TTL)
  ├─ If cached: return cached result
  ├─ If not cached: query contract
  ├─ Cache result
  └─ Return response
```

### Cache Management
- **Cache Key:** Wallet address
- **Cache TTL:** 60 seconds
- **Cache Storage:** In-memory Map (suitable for single-instance)
- **Shared:** Both public and authenticated endpoints use same cache
- **Audit:** Cache hits not logged separately (same audit entry)

### Audit Logging
Public endpoint requests are logged with:
- `action: 'verify.public_lookup'`
- `actor: <client-ip>`
- `target: <wallet-address>`
- `result: 'success' | 'failure'`
- `meta: { ip: <client-ip> }`

## Differences from Authenticated Endpoint

| Feature | Public | Authenticated |
|---------|--------|---------------|
| Authentication | Not required | Required (JWT or API key) |
| Rate limit | 60 req/min per IP | 60 req/min per JWT user or 120 req/min per API key |
| Response fields | `wallet, status, verified, records` | `wallet, status, vaccinated, verified, record_count, records` |
| Audit actor | Client IP | User wallet or API key ID |
| Use case | Public verification, third-party integrators | Internal systems, trusted partners |

## Security Considerations

### Public Access
- Endpoint is intentionally public (no authentication)
- Wallet addresses are public information on Stellar blockchain
- Vaccination status is derived from public blockchain data
- No sensitive information is exposed

### Rate Limiting
- Prevents abuse and DDoS attacks
- Per-IP rate limiting (60 requests/minute)
- Configurable via `RATE_LIMIT_VERIFY` environment variable
- Returns 429 with `Retry-After` header

### Caching
- Reduces RPC load on blockchain
- 60-second cache TTL balances freshness and performance
- Cache is in-memory (suitable for single-instance deployments)
- For multi-instance deployments, consider Redis cache

### Input Validation
- Wallet format validated before contract query
- Invalid format returns 400 immediately
- Prevents malformed RPC calls
- `limit` validated as an integer in `[1, 100]`; values above `100` are clamped, non-integers return `400`
- `cursor` validated as an opaque token; malformed or expired cursors return `400`
- Batch requests validated against the `50`-wallet maximum before any contract query

### Failure Semantics
- RPC failures, timeouts, and partial reads are reported as
  `status: "unavailable"` with a 5xx status code
- Failures are never cached as `valid` and never returned as `verified: true`
- A missing record set is only reported as `absent` when the contract
  positively confirms an empty result
- Results are informational only and do not constitute a medical determination

## Configuration

### Environment Variables
```bash
# Rate limit for public endpoint (requests per minute per IP)
RATE_LIMIT_VERIFY=60

# Cache TTL (milliseconds)
# Currently hardcoded to 60000 (60 seconds)
# Can be made configurable if needed
```

## Monitoring

### Metrics to Track
- Public endpoint request volume
- Cache hit rate
- Rate limit violations
- Error rates (400, 429, 500, 503)
- RPC timeout frequency
- Count of responses by `status` (`valid`, `revoked`, `absent`, `unavailable`)
- Alert if any `unavailable` response is ever served with `verified: true`

### Audit Log Queries
```javascript
// Find all public verification lookups
const entries = queryAuditLog({ action: 'verify.public_lookup' });

// Find failed lookups
const failures = entries.filter(e => e.result === 'failure');

// Find lookups for specific wallet
const walletLookups = entries.filter(e => e.target === wallet);
```

## Acceptance Criteria Met

✅ **No authentication required**
- Public endpoint accessible without JWT or API key
- No Authorization header needed

✅ **Returns { status, verified: true/false, records: [...] } schema**
- Response includes `status` distinguishing `valid`, `revoked`, `absent`, `unavailable`
- Response includes `verified` boolean (`true` only for `status: "valid"`)
- Response includes `records` array
- Simplified schema for public consumers

✅ **Results cannot be read as a medical determination**
- Documentation states results are informational only
- `absent` and `unavailable` are explicitly not evidence of being unvaccinated

✅ **RPC failures cannot collapse into a positive verification**
- Failures surface as `status: "unavailable"` with a 5xx code
- Tests assert that error/timeout paths never yield `verified: true`

✅ **Wallet format is validated; invalid format returns 400**
- Uses existing `validateStellarPublicKey` middleware
- Returns 400 with error message for invalid format
- Prevents unnecessary contract calls

✅ **Response is cached for 60 seconds to reduce RPC load**
- Cache TTL set to 60 seconds
- Shared cache between public and authenticated endpoints
- Reduces blockchain query overhead

✅ **Rate limited to 60 requests per IP per minute**
- Uses `verifyLimiter` middleware
- Configurable via `RATE_LIMIT_VERIFY` env var
- Returns 429 when exceeded

✅ **Public record responses and batch requests have documented maximum sizes and pagination/truncation semantics**
- Records per page: default `20`, max `100`
- Records scanned per request: `500`
- Response body: `256 KiB`
- Batch: `50` wallets, `1 MiB` response
- `truncated` / `next_cursor` semantics documented above

✅ **Boundary tests demonstrate predictable behavior at, below, and above each limit**
- Boundary examples for below/at/above `limit`, scan limit, and batch size included above
- Tests cover `limit` of `1`, `20`, `100`, and `101` (clamped)
- Tests cover wallets with `0`, `5`, `100`, `250`, and `900` records
- Tests cover batch sizes of `49`, `50`, and `51`

## Future Enhancements

1. **Redis Cache:** For multi-instance deployments
2. **Configurable Cache TTL:** Make 60-second TTL configurable
3. **Metrics Export:** Prometheus metrics for monitoring
4. **Batch Verification:** Support checking multiple wallets in one request (bounded to `50` wallets per request)
5. **Webhook Notifications:** Notify when vaccination status changes
6. **Configurable Limits:** Make page size, scan limit, and body size caps configurable via env vars
