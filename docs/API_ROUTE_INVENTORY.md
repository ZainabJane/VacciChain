# API Route Inventory — VacciChain (#36)

Documents the canonical path and legacy behavior for every backend endpoint.

## Canonical version

All API endpoints are served exclusively under `/v1/`. The `API-Version: 1`
response header is set on every `/v1` response (see `src/middleware/apiVersion.js`).

## Legacy unversioned behavior

Every legacy unversioned path returns **308 Permanent Redirect** to the
equivalent `/v1/` path with a `Deprecation: true` header. No legacy path is
served by a duplicate handler, so there are no conflicting route mounts.

| Endpoint | Canonical path | Legacy behavior |
|---|---|---|
| SEP-10 challenge | `POST /v1/auth/sep10` | `POST /auth/*` → 308 to `/v1/auth/*` |
| SEP-10 verify | `POST /v1/auth/verify` | `POST /auth/*` → 308 to `/v1/auth/*` |
| Issue vaccination | `POST /v1/vaccination/issue` | `POST /vaccination/*` → 308 to `/v1/vaccination/*` |
| Revoke vaccination | `POST /v1/vaccination/revoke` | `POST /vaccination/*` → 308 to `/v1/vaccination/*` |
| List vaccination records | `GET /v1/vaccination/:wallet` | `GET /vaccination/*` → 308 to `/v1/vaccination/*` |
| Verify status | `GET /v1/verify/:wallet` | `GET /verify/*` → 308 to `/v1/verify/*` |
| Public verify | `GET /v1/verify/public/:wallet` | `GET /verify/*` → 308 to `/v1/verify/*` |
| Patient register | `POST /v1/patient/register` | `POST /patient/*` → 308 to `/v1/patient/*` |
| Consent status | `GET /v1/patient/consent/:wallet` | `GET /patient/*` → 308 to `/v1/patient/*` |
| Record consent | `POST /v1/patient/consent` | `POST /patient/*` → 308 to `/v1/patient/*` |
| Indexed events | `GET /v1/events` | `GET /events` → 308 to `/v1/events` |
| Onboarding apply | `POST /v1/onboarding/apply` | `POST /onboarding/*` → 308 to `/v1/onboarding/*` |
| Onboarding applications | `GET /v1/onboarding/applications` | `GET /onboarding/*` → 308 to `/v1/onboarding/*` |
| Onboarding review | `POST /v1/onboarding/applications/:id/review` | `POST /onboarding/*` → 308 to `/v1/onboarding/*` |
| Analytics rates | `GET /v1/analytics/rates` | `GET /analytics/*` → 308 to `/v1/analytics/*` |
| Analytics issuers | `GET /v1/analytics/issuers` | `GET /analytics/*` → 308 to `/v1/analytics/*` |
| Analytics anomalies | `GET /v1/analytics/anomalies` | `GET /analytics/*` → 308 to `/v1/analytics/*` |

## Unversioned (always available)

- `GET /health` — health check (not versioned).

## Notes

- The legacy redirect is implemented once in `src/app.js` and covers every
  canonical `/v1` route prefix, so no handler is mounted at both a legacy and
  a versioned path.
- The analytics proxy (`/v1/analytics/*`) forwards only the documented paths
  (`/rates`, `/issuers`, `/anomalies`) to the internal analytics service.
