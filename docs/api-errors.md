# API error responses

Every error from the backend uses one shape (`backend/src/errors.js`):

```json
{
  "error": "Invalid or expired token",
  "code": "TOKEN_INVALID",
  "requestId": "b6f1c3e2-…"
}
```

| Field | Meaning |
| --- | --- |
| `error` | Safe, human-readable message. Kept as a string for backward compatibility. For **5xx it is always `"Internal Server Error"`**: stack traces, RPC payloads and secrets are logged server-side only. |
| `code` | Stable value clients should branch on (see below). |
| `requestId` | Same value as the `X-Request-ID` response header. Quote it when reporting a problem so it can be found in the logs. |
| `details` | Optional field-level validation details. 4xx only. |

## Codes

| Code | HTTP | When |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Request body, params or query failed validation (also malformed JSON). |
| `UNAUTHENTICATED` | 401 | No `Authorization: Bearer …` header. |
| `TOKEN_INVALID` | 401 | Bad signature, expired, wrong `iss`/`aud`/`alg`, retired key, missing claims, or `sub` ≠ `wallet`. |
| `FORBIDDEN` | 403 | Authenticated, but not allowed, e.g. a patient reading another wallet's records, or an issuer revoked on-chain. |
| `NOT_FOUND` | 404 | Resource doesn't exist. |
| `RATE_LIMITED` | 429 | Too many requests. |
| `RPC_ERROR` | 502 | An upstream Stellar/Soroban dependency failed or couldn't be reached. |
| `INTERNAL_ERROR` | 500 | Anything unexpected. |

Errors that reach the global handler (`middleware/errorHandler.js`) are normalized automatically. A thrown `ApiError(status, code, message)` keeps its code, and a plain error with a 4xx `statusCode`/`status` gets the default code for that status.

The authentication and object-authorization middleware (`middleware/auth.js`) respond with this shape directly. Some older route handlers still send `{ error }` without `code`; migrate them with `sendError(req, res, status, code, message)` when you touch them.

## Object-level authorization (#45)

| Caller | `GET /v1/vaccination/{wallet}` and `GET /v1/patient/consent/{wallet}` |
| --- | --- |
| Unauthenticated | 401 `UNAUTHENTICATED` |
| Patient, own wallet | 200 |
| Patient, another wallet | 403 `FORBIDDEN` |
| Issuer (re-verified on the on-chain allowlist on every request) | 200, or 403 if revoked, or 502 `RPC_ERROR` if the allowlist can't be checked |
| Admin | 200 |

`GET /v1/patient/consent/{wallet}` previously needed no authentication; it now requires a JWT under these rules. The caller's wallet always comes from the verified token, never from the request.
