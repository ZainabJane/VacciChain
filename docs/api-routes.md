# API route inventory

The canonical form of every API endpoint is under `/v1`. Handlers are mounted only there.
The unversioned (legacy) form answers `308 Permanent Redirect` to the canonical path,
preserving method, body and query string, with `Deprecation: true` and a
`Link: <...>; rel="successor-version"` header. Both forms send `API-Version: 1`.

`backend/tests/route-inventory.test.js` fails if an endpoint is missing from this table.

| Method | Canonical | Legacy (308) |
| --- | --- | --- |
| POST | `/v1/auth/sep10` | `/auth/sep10` |
| POST | `/v1/auth/verify` | `/auth/verify` |
| POST | `/v1/vaccination/issue` | `/vaccination/issue` |
| POST | `/v1/vaccination/revoke` | `/vaccination/revoke` |
| GET | `/v1/vaccination/:wallet` | `/vaccination/:wallet` |
| GET | `/v1/verify/public/:wallet` | `/verify/public/:wallet` |
| GET | `/v1/verify/:wallet` | `/verify/:wallet` |
| POST | `/v1/admin/issuers` | `/admin/issuers` |
| DELETE | `/v1/admin/issuers/:wallet` | `/admin/issuers/:wallet` |
| GET | `/v1/admin/issuers` | `/admin/issuers` |
| GET | `/v1/admin/audit` | `/admin/audit` |
| POST | `/v1/admin/api-keys` | `/admin/api-keys` |
| GET | `/v1/admin/api-keys` | `/admin/api-keys` |
| DELETE | `/v1/admin/api-keys/:id` | `/admin/api-keys/:id` |
| POST | `/v1/admin/jwt/rotate` | `/admin/jwt/rotate` |
| POST | `/v1/admin/multisig/approve` | `/admin/multisig/approve` |
| GET | `/v1/admin/multisig/proposals/:id` | `/admin/multisig/proposals/:id` |
| POST | `/v1/patient/register` | `/patient/register` |
| GET | `/v1/patient/consent/:wallet` | `/patient/consent/:wallet` |
| POST | `/v1/patient/consent` | `/patient/consent` |
| GET | `/v1/events` | `/events` |
| POST | `/v1/onboarding/apply` | `/onboarding/apply` |
| GET | `/v1/onboarding/applications` | `/onboarding/applications` |
| POST | `/v1/onboarding/applications/:id/review` | `/onboarding/applications/:id/review` |

`/health` and the Swagger UI are infrastructure routes: unversioned, never redirected.
