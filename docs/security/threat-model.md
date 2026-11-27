# VacciChain Threat Model

**Version:** 1.0  
**Date:** 2026-04-28  
**Status:** Active — must be reviewed and updated before mainnet launch  
**Scope:** Soroban smart contract, Node.js backend API, React frontend, Python analytics service

---

## 1. Assets

| Asset | Location | Sensitivity |
|---|---|---|
| Vaccination records (soulbound NFTs) | On-chain (Soroban contract storage) | High — medical data |
| Patient wallet addresses | On-chain + backend indexer DB | Medium — pseudonymous but linkable |
| Admin secret key (`ADMIN_SECRET_KEY`) | Backend environment / secrets manager | Critical — controls issuer list and contract upgrades |
| Issuer secret key (`ISSUER_SECRET_KEY`) | Backend environment / secrets manager | High — signs all mint/revoke transactions |
| SEP-10 server key (`SEP10_SERVER_KEY`) | Backend environment | High — signs auth challenges |
| JWT secret (`JWT_SECRET`) | Backend environment | High — forging it grants arbitrary role claims |
| Verifier API keys | Backend SQLite DB (`api_keys` table) | Medium — grants bulk verification access |
| SEP-10 nonces | In-memory nonce store | Medium — single-use; expiry limits window |
| Audit log (`audit.log`) | Backend filesystem | Medium — append-only NDJSON with hash chaining (tamper-evident); contains wallet + action history |
| Backend indexer SQLite DB | Backend filesystem | Medium — indexed on-chain events cache |
| Contract WASM / upgrade path | On-chain deployer | Critical — malicious upgrade replaces all logic |

---

## 2. Threat Actors

| Actor | Access | Motivation |
|---|---|---|
| External attacker | Public endpoints, on-chain read | Forge records, DoS, data harvest |
| Malicious patient | Valid patient JWT, own wallet | Access other patients' data, spam registration |
| Malicious issuer | Valid issuer JWT + on-chain issuer key | Mint fraudulent records, spam, extort patients |
| Compromised backend | Holds `ADMIN_SECRET_KEY`, `ISSUER_SECRET_KEY`, `JWT_SECRET` | Full system takeover |
| Rogue admin | Holds admin key | Add malicious issuers, upgrade contract to backdoor |
| Malicious verifier | Valid API key | Bulk harvest patient vaccination status |
| Supply-chain attacker | npm / pip / cargo dependency | Inject malicious code into build artifacts |
| Insider (healthcare provider) | Physical access to issuer credentials | Mint records for unvaccinated patients |

---

## 3. Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────────┐
│  UNTRUSTED (public internet)                                        │
│                                                                     │
│   Browser / Freighter wallet          Third-party verifiers         │
│         │                                      │                    │
└─────────┼──────────────────────────────────────┼────────────────────┘
          │ HTTPS                                 │ HTTPS + X-API-Key
┌─────────▼──────────────────────────────────────▼────────────────────┐
│  SEMI-TRUSTED (backend perimeter — Docker internal network)         │
│                                                                     │
│   Node.js Express API (port 4000)                                   │
│   Python FastAPI analytics (port 8001)  ──────► backend:4000        │
│                                                                     │
│   Both services hold secret keys and must be treated as high-value  │
│   targets. Compromise here = compromise of all off-chain controls.  │
└─────────────────────────────────────────────────────────────────────┘
          │ Soroban RPC / Horizon
┌─────────▼───────────────────────────────────────────────────────────┐
│  TRUSTED (Stellar network — on-chain enforcement)                   │
│                                                                     │
│   Soroban smart contract                                            │
│   • Issuer allowlist enforced at contract level                     │
│   • Patient allowlist enforced at contract level                    │
│   • Soulbound: transfer() always reverts                            │
│   • Admin two-step transfer with 24-hour expiry                     │
│                                                                     │
│   No backend path can override contract-level rules.                │
└─────────────────────────────────────────────────────────────────────┘
```

Key boundary: **on-chain vs. off-chain**. The contract is the source of truth. The backend is a convenience layer — it can be compromised without forging on-chain records, but it can mint fraudulent records if `ISSUER_SECRET_KEY` is leaked.

---

## 4. STRIDE Analysis

### 4.1 Soroban Smart Contract

| ID | STRIDE | Threat | Mitigation | Residual Risk |
|---|---|---|---|---|
| C-S1 | Spoofing | Attacker impersonates an authorized issuer to call `mint_vaccination` | `issuer.require_auth()` in `mint.rs`; issuer must sign the invocation with their private key | Low — requires key compromise |
| C-S2 | Spoofing | Attacker impersonates admin to call `add_issuer` or `upgrade` | `admin.require_auth()` on every admin function | Low — requires admin key compromise |
| C-T1 | Tampering | Attacker modifies a vaccination record after minting | Records stored in persistent contract storage; no update path exists — only `revoke_vaccination` (marks revoked, never deletes) | None |
| C-T2 | Tampering | Malicious contract upgrade replaces all logic | `upgrade()` requires admin auth + emits `upgraded` event; two-step admin transfer limits key handoff risk | Medium — admin key compromise enables this |
| C-T3 | Tampering | Revocation scope ambiguity — verifiers disagree on whether revocation affects a single record, the whole wallet, or the issuer's permission | Revocation is defined as **record-scoped and irreversible**: `revoke_vaccination` marks exactly one record revoked (never deletes, never cascades to other records or to the wallet), emits `VaccinationRevoked` with the record id, and `verify_vaccination` returns per-record status. Issuer permission is revoked only via the separate `remove_issuer` path. Contract and API specs must state this scope explicitly | Medium — until specs are formalized, integrators may over-interpret revocation |
| C-T4 | Tampering | Duplicate-record detection bypassed via formatting variants (case, whitespace, unicode normalization, vaccine-name aliases) or concurrent mint calls | Duplicate key definition (patient wallet + normalized vaccine code + dose number) must be documented and normalized identically in API and contract; contract-level uniqueness check is authoritative and atomic within a single invocation | Medium — normalization rules not yet formalized across layers |
| C-T5 | Tampering | Invalid issuer lifecycle transition (e.g., re-adding a removed issuer, handoff to a non-admin) leaves stale or escalated permissions | Issuer state machine (active → removed → re-added) and admin handoff transitions must be explicitly enumerated; disallowed transitions revert; repeated operations have defined idempotent-or-error semantics and emit events | Medium — state machine tests pending |
| C-R1 | Repudiation | Issuer denies minting a record | All mint/revoke/issuer-add/admin actions emit on-chain events (`VaccinationMinted`, `VaccinationRevoked`, `IssuerAdded`, etc.) | Low |
| C-R2 | Repudiation | Admin denies initiating a key rotation or recovery | Recovery/rotation proposals, acceptances, cancellations, and expiries must emit events and be recorded in the audit log | Medium — recovery flow not yet implemented |
| C-I1 | Information Disclosure | Patient vaccination history exposed to anyone | `verify_vaccination` is intentionally public (by design — verifiers need it); wallet addresses are pseudonymous | Medium — acceptable by design; patients should be aware |
| C-D1 | Denial of Service | Spam `register_patient` or `batch_verify` to exhaust contract storage / compute | `batch_verify` capped at 100 wallets; per-patient record limit (50) enforced in `mint.rs` | Low |
| C-D2 | Denial of Service | Attacker fills issuer list to degrade `get_all_issuers` pagination | Only admin can add issuers | Low |
| C-E1 | Elevation of Privilege | Non-admin calls `add_issuer` or `upgrade` | `admin.require_auth()` enforced; Soroban auth model rejects mismatched signers | None |
| C-E2 | Elevation of Privilege | Soulbound bypass — transfer NFT to another wallet | `transfer()` always returns `SoulboundToken` (error 15); no alternative transfer path. Full operation-by-operation enforcement matrix in §4.5 | Low — see §4.5 for residual integration paths |
| C-E3 | Elevation of Privilege | Double-initialization to replace admin | `AlreadyInitialized` check on `initialize()` | None |
| C-D3 | Denial of Service | Oversized vaccine names, metadata, issuer lists, or patient histories exhaust Soroban CPU/memory/ledger-entry limits | Every public argument and stored collection has a documented maximum enforced before any write; boundary tests cover zero, max, and max+1 (§4.7) | Low |

### 4.2 Backend API (Node.js / Express)

| ID | STRIDE | Threat | Mitigation | Residual Risk |
|---|---|---|---|---|
| B-S1 | Spoofing | Attacker replays a captured SEP-10 signed transaction to obtain a JWT | Nonces are single-use (`nonceStore.consume`); challenges expire after 5 minutes (tx `setTimeout(300)`) | Low |
| B-S2 | Spoofing | Attacker forges a JWT to claim `issuer` role | JWTs signed with `JWT_SECRET` (HS256); `authMiddleware` validates `sub`, `role`, `wallet`, `exp` claims | Low — depends on `JWT_SECRET` secrecy |
| B-S3 | Spoofing | Attacker submits a crafted SEP-10 transaction with a fake server signature | `verifyChallenge` checks server signature against `SEP10_SERVER_KEY` before accepting | Low |
| B-T1 | Tampering | Attacker injects malicious wallet address into `/vaccination/issue` body | `wallet.js` middleware validates Stellar public key format (starts with `G`, 56 chars); Soroban contract re-validates | Low |
| B-T2 | Tampering | Attacker tampers with audit log to hide actions | Audit log is append-only NDJSON; no delete endpoint exists | Medium — filesystem access enables tampering; use write-once storage in production |
| B-R1 | Repudiation | Issuer denies calling `/vaccination/issue` | `auditLog.js` middleware records every mutating request with wallet, role, endpoint, timestamp, and response status | Low |
| B-I1 | Information Disclosure | Secret keys leaked via error responses or logs | `config.js` validates env vars at startup; logger uses structured JSON (no raw error stack to client); request/error log serializers redact sensitive headers (`Authorization`, `X-API-Key`, cookies) and payload fields (`secret`, `secretKey`, `signedTx`, `jwt`, `apiKey`), and health endpoints omit internal detail (issue #58) | Low — redaction covered by automated tests asserting representative secrets never appear in emitted log records |
| B-I2 | Information Disclosure | CORS misconfiguration exposes API to arbitrary origins | CORS configured in `app.js`; verify allowed origins are restricted in production | Medium — confirm production CORS allowlist |
| B-D1 | Denial of Service | Flood `/auth/sep10` to exhaust Horizon account sequence numbers | Rate limiters on auth, public verification, onboarding, and batch verification use a trusted client identity resolver: `req.ip` is only trusted when the request comes from a configured trusted proxy (`TRUSTED_PROXIES` / Express `trust proxy`), otherwise the socket address is used. Responses include documented `Retry-After` and `RateLimit-*` headers (issue #55) | Low — spoofed `X-Forwarded-For` from untrusted peers is ignored; covered by tests |
| B-D2 | Denial of Service | Oversized request body crashes the parser | `body-limit` middleware enforced (tested in `body-limit.test.js`) | Low |
| B-D4 | Denial of Service | Unbounded record histories or batch inputs exhaust memory, CPU, or response bandwidth | Public record responses are paginated/truncated to a documented maximum; batch requests are capped at a documented maximum size and rejected above it; boundary behavior tested at, below, and above each limit | Low |
| B-D3 | Denial of Service | Soroban RPC unavailability blocks all minting | `withRetry` in `soroban.js` retries with exponential backoff up to `SOROBAN_RPC_MAX_RETRIES` | Medium — no circuit breaker; prolonged RPC outage blocks all writes |
| B-D4 | Denial of Service | Distributed deployment bypasses per-IP limits because each instance counts independently | Per-instance in-memory counters; document that multi-instance deployments must front the API with a shared limiter (e.g., nginx `limit_req` or Redis-backed store) | Medium — single-instance limits only; see OR-10 |
| B-T3 | Tampering | Corrupt or inaccessible indexer DB silently replaced with an empty database, hiding data loss | Startup and readiness checks validate schema version, required tables, and DB accessibility; corruption raises an actionable operator alert and fails fast instead of initializing an empty replacement (issue #63) | Low |
| B-T4 | Tampering | Ambiguous or offset-bearing vaccination dates shift across time zones, misrepresenting record dates | API schema documents date-only (`YYYY-MM-DD`, interpreted as UTC calendar date) versus timestamp (RFC 3339 with explicit offset, normalized to UTC) fields and rejects ambiguous values (issue #64) | Low |
| B-E1 | Elevation of Privilege | Patient JWT used to call issuer-only `/vaccination/issue` | `issuerMiddleware` checks `req.user.role === 'issuer'` after `authMiddleware` | Low |
| B-E2 | Elevation of Privilege | Verifier API key used to call authenticated patient/issuer routes | Verifier routes use `verifierApiKey` middleware, not JWT; separate middleware chains | Low |
| B-E3 | Elevation of Privilege | `ADMIN_SECRET_KEY` used for `register_patient` on behalf of patient | `register_patient` calls `patient.require_auth()` on-chain — backend cannot satisfy this with admin key alone. **Frontend must build an unsigned tx and have the patient sign via Freighter before mainnet.** | **High — must fix before mainnet** |

### 4.3 Frontend (React / Freighter)

| ID | STRIDE | Threat | Mitigation | Residual Risk |
|---|---|---|---|---|
| F-S1 | Spoofing | Phishing site mimics VacciChain to steal wallet signatures | Freighter shows the domain before signing; users must verify the URL | Medium — user education required |
| F-S2 | Spoofing | XSS injects script to exfiltrate JWT from localStorage | JWTs should be stored in `httpOnly` cookies, not localStorage; review current storage mechanism | **High — verify JWT storage before mainnet** |
| F-T1 | Tampering | Attacker intercepts API responses to display false vaccination status | HTTPS in transit; on-chain verification is the authoritative source — `VerifyPage` calls `/verify/:wallet` which reads from contract | Low |
| F-I1 | Information Disclosure | Patient's wallet address exposed in browser history via URL params | Verify page uses wallet address in URL — acceptable for public verification; no private data in URL | Low |
| F-D1 | Denial of Service | Freighter extension unavailable blocks all wallet operations | `FreighterBanner` component warns users when extension is not detected | Low |
| F-E1 | Elevation of Privilege | Frontend bypasses issuer check to call mint endpoint | Backend `issuerMiddleware` enforces role server-side; frontend check is UI-only | None |

### 4.4 Python Analytics Service

| ID | STRIDE | Threat | Mitigation | Residual Risk |
|---|---|---|---|---|
| A-S1 | Spoofing | Unauthenticated caller accesses analytics endpoints | `/analytics/*` endpoints currently have no auth; `_bearer` variable is defined but not applied as a dependency in routes | **High — add auth before production** |
| A-T1 | Tampering | Attacker sends crafted event data to skew analytics | Analytics reads from backend `/events` endpoint (read-only); no write path into analytics | Low |
| A-I1 | Information Disclosure | Bulk harvest of issuer activity and anomaly data | No rate limiting on analytics endpoints; no auth (see A-S1) | High — blocked by fixing A-S1 |
| A-D1 | Denial of Service | Flood `/batch/verify` with 100-wallet requests to amplify load on backend | Batch capped at 100 wallets per request (documented limit; oversized batches rejected); no rate limit on the analytics service itself | Medium — add rate limiting |
| A-E1 | Elevation of Privilege | Analytics service calls backend with elevated privileges | Analytics only calls public `/verify/:wallet` and `/events`; no JWT or admin key used | Low |

### 4.5 Soulbound Enforcement Matrix (issue #75)

The soulbound guarantee is that **no public entry point can change the owner of an existing vaccination token**. The table below enumerates every public operation that could plausibly alter ownership, directly or through an integration path, and records the enforcement and the negative test that proves it.

| Operation | Ownership effect if unguarded | Enforcement | Negative test (must fail, no storage mutation, no event) |
|---|---|---|---|
| `transfer(from, to, token_id)` | Reassigns token to `to` | Always reverts with `SoulboundToken` (error 15) before any storage read/write | `test_transfer_reverts_soulbound` — asserts error 15, owner unchanged, no `Transfer` event |
| `transfer_from(spender, from, to, token_id)` | Reassigns token via allowance | Not implemented; any invocation fails with `UnknownFunction`/unsupported entry point | `test_transfer_from_unsupported` — asserts invocation fails, owner unchanged, no events |
| `approve` / `set_approval_for_all` | Grants a third party the right to move the token | Not implemented; no allowance storage key exists | `test_approve_unsupported` — asserts failure, no allowance entry created, no `Approval` event |
| `allowance(owner, spender)` | Leaks or implies transferability | Not implemented; returns nothing / unsupported | `test_allowance_unsupported` — asserts no allowance is ever non-zero |
| `clawback(from, token_id)` | Moves or destroys a token held by a patient | Not implemented; revocation is the only lifecycle action and it never changes `owner` | `test_clawback_unsupported` — asserts failure, owner unchanged, no events |
| `burn(token_id)` | Destroys token, enabling re-mint to a different wallet | Not implemented; `revoke_vaccination` only flips `revoked = true` and retains `owner` | `test_burn_unsupported` and `test_revoke_keeps_owner` — owner unchanged, record still present |
| `mint_vaccination` (re-mint to a new wallet for an existing record) | Duplicate/alternate ownership of the same vaccination | Requires `issuer.require_auth()`; per-patient record cap (50) enforced; duplicate record id rejected | `test_mint_duplicate_rejected` — asserts failure, original owner unchanged, no second `VaccinationMinted` event |
| `revoke_vaccination` then re-mint | Reassigns a revoked record to another wallet | Revoked records are terminal for that record id; re-mint with the same id fails | `test_remint_after_revoke_rejected` — asserts failure, storage unchanged, no events |
| `upgrade(new_wasm)` | Replaces logic with a transferable implementation | `admin.require_auth()`; emits `upgraded`; two-step admin transfer with 24h expiry | `test_upgrade_requires_admin` — non-admin call fails, WASM hash unchanged, no `upgraded` event |
| `set_admin` / `accept_admin` / `transfer_admin` | Rogue admin installs a transfer-enabling implementation | `admin.require_auth()`; pending admin must accept; 24h expiry | `test_admin_transfer_requires_auth`, `test_admin_transfer_expires` — unauthorized calls fail, admin unchanged |
| `add_issuer` / `remove_issuer` | Malicious issuer mints to arbitrary wallets | `admin.require_auth()`; emits `IssuerAdded`/`IssuerRemoved` | `test_add_issuer_requires_admin` — non-admin fails, issuer list unchanged, no event |
| `register_patient` | Registers a wallet the caller does not control | `patient.require_auth()` on-chain | `test_register_patient_requires_patient_auth` — admin-signed call fails, no patient entry created |
| `verify_vaccination` / `batch_verify` | Read-only; must never mutate | Pure read functions; no storage writes | `test_verify_is_read_only` — storage snapshot identical before/after, no events emitted |
| `initialize` (re-init to reset state) | Replaces admin/issuer state | `AlreadyInitialized` check | `test_double_initialize_rejected` — second call fails, admin unchanged |

**Integration paths reviewed:** backend `/vaccination/issue` and `/vaccination/revoke` (issuer-signed only), backend indexer (read-only event replay), Python analytics (read-only `/verify` and `/events`), and frontend Freighter flows (patient-signed `register_patient` only). No off-chain path can invoke a transfer-like operation because none exists on-chain.

**Test invariant:** every negative test above asserts three things — (1) the call fails with the expected error, (2) a storage snapshot taken before and after is byte-identical, and (3) no event is emitted (or, where an event is expected, it is not a misleading ownership event such as `Transfer`/`Approval`).

### 4.6 Privacy Field Classification (issue #76)

On-chain contract state is immutable and publicly readable, so every field is classified before storage. Policy: **no personally identifying information (PII) and no unnecessary clinical detail may be written on-chain.**

| Field | Where stored | Classification | Justification |
|---|---|---|---|
| `owner` (patient wallet `G...`) | On-chain | Pseudonymous identifier — allowed | Required for soulbound ownership; linkable but not directly identifying |
| `record_id` | On-chain | Non-sensitive — allowed | Opaque identifier |
| `vaccine_name` | On-chain | Clinical — allowed, bounded | Needed for verification; must be a standardized code/name, not free-text notes |
| `date_administered` | On-chain | Clinical — allowed | Required for validity checks |
| `issuer` (issuer wallet) | On-chain | Pseudonymous identifier — allowed | Needed for provenance |
| `revoked` / `revoked_at` | On-chain | Non-sensitive — allowed | Lifecycle state |
| Patient name, date of birth, address, phone, email | **Never on-chain** | PII — prohibited | Must live off-chain (if at all) under separate consent and retention policy |
| Free-text clinical notes, adverse-event details, diagnoses | **Never on-chain** | Sensitive clinical — prohibited | Not required for verification; store off-chain only |
| Document/ID numbers, insurance identifiers | **Never on-chain** | PII — prohibited | Not required for verification |

**Residual linkability risks (documented, accepted with mitigations):**
- Wallet addresses are persistent pseudonyms; correlating a wallet across issuers reveals a vaccination history. Mitigation: patients may use distinct wallets per context; verification endpoints return only the minimum fields.
- `date_administered` plus issuer identity can narrow a patient's location/time window. Mitigation: dates are day-granularity only; no timestamps.
- Public `verify_vaccination` enables enumeration of a known wallet's status. Mitigation: rate limiting on backend verification routes; on-chain reads are inherently public and this is accepted by design.
- Event logs (`VaccinationMinted`, etc.) duplicate on-chain fields and are permanently retained. Mitigation: events carry only the same minimized fields listed above.

Privacy review sign-off is required before mainnet (see §6).

### 4.7 Input and Collection Bound Policy (issue #77)

Every public argument and stored collection has a documented maximum, enforced **before** any storage write, to prevent oversized inputs from exceeding Soroban CPU/memory/ledger-entry limits (DoS mitigation, C-D3).

| Input / collection | Maximum | Enforcement point | Boundary tests |
|---|---|---|---|
| `vaccine_name` length | 64 bytes | `mint.rs` validation | zero, 64, 65 |
| record metadata / notes length | 256 bytes | `mint.rs` validation | zero, 256, 257 |
| `batch_verify` wallet count | 100 | `batch_verify` guard | zero, 100, 101 |
| Records per patient | 50 | `mint.rs` per-patient cap | 0, 50, 51 |
| Issuer list size | 100 | `add_issuer` guard | 0, 100, 101 |
| Patient history page size | 50 | pagination guard | 0, 50, 51 |
| Wallet address length | exactly 56 chars, `G` prefix | shared validator | malformed, valid, over-length |

Boundary tests assert that zero and maximum-valid inputs succeed, and one-over-limit inputs fail with a validation error **without mutating storage or emitting events**.

---

## 5. Open Risks (Prioritized)

| ID | Risk | Severity | Owner | Action Required Before Mainnet |
|---|---|---|---|---|
| OR-1 | `register_patient` uses `ADMIN_SECRET_KEY` as placeholder — patient auth not satisfied on-chain | **Critical** | Backend + Frontend | Build unsigned tx in backend, return to frontend for Freighter signing |
| OR-2 | Analytics endpoints have no authentication (`_bearer` defined but not wired) | **High** | Python service | Apply `HTTPBearer` dependency to all analytics routes |
| OR-3 | JWT storage in frontend — if stored in localStorage, vulnerable to XSS | **High** | Frontend | Move to `httpOnly` cookie or confirm current storage is safe |
| OR-4 | Admin key is a single point of failure; compromise enables malicious issuer addition and contract upgrade | **High** | DevOps | Store in hardware wallet or cloud HSM; monitor `iss_add` and `upgraded` events |
| OR-5 | Audit log on local filesystem — writable by process; hash chaining detects tampering but not wholesale replacement | **Medium** | Backend / Infra | Ship to append-only log sink (e.g., Loki, CloudWatch Logs); document and test rotation, retention, integrity verification, and failure handling |
| OR-6 | No rate limiting on Python analytics service | **Medium** | Python service | Add `slowapi` or nginx rate limiting in front of the service |
| OR-7 | CORS allowlist not verified for production — may be open | **Medium** | Backend | Restrict `Access-Control-Allow-Origin` to known frontend domain |
| OR-8 | Soroban RPC outage has no circuit breaker — prolonged outage blocks all writes with no user feedback | **Low** | Backend | Add circuit breaker or health-check endpoint |
| OR-9 | `nonceStore` is in-memory — restarting the backend invalidates all in-flight SEP-10 challenges | **Low** | Backend | Acceptable for single-instance; use Redis-backed store for multi-instance deployments |
| OR-10 | Independent security audit (authorization, storage, lifecycle, upgrade, privacy) not yet complete; scope, pinned revision, WASM hash, and findings must be recorded | **Critical** | Security | Complete audit (issue #73); fix and independently verify all critical/high findings before mainnet approval |
| OR-11 | Soulbound enforcement relies on absence of transfer/approve/clawback/burn entry points — a future upgrade could reintroduce them | **High** | Contracts | Keep §4.5 negative tests in CI; audit any upgrade that adds token operations |
| OR-12 | Residual wallet linkability across issuers (see §4.6) | **Medium** | Architecture | Privacy review sign-off; document patient guidance on wallet separation |
| OR-13 | Rate limits are per-instance and keyed on trusted client identity; behind an untrusted or misconfigured proxy, limits may be bypassed or over-applied | **Medium** | Backend / Infra | Configure `TRUSTED_PROXIES` to match the deployment topology; add shared limiter for multi-instance deployments |
| OR-14 | Log redaction is deny-by-allowlist on known fields — new endpoints may log unredacted payloads | **Medium** | Backend | Extend redaction tests when adding endpoints; review serializers in code review |
| OR-15 | Date/timezone normalization rejects ambiguous input — legacy records with offset-bearing dates may need migration | **Low** | Backend | Backfill historical records to UTC; document accepted formats in API schema |

---

## 6. Mainnet Launch Checklist

- [ ] OR-1: `register_patient` flow uses patient-signed transaction (not admin key)
- [ ] OR-2: Analytics routes protected with JWT or API key auth
- [ ] OR-3: JWT stored in `httpOnly` cookie, not localStorage
- [ ] OR-4: Admin key in HSM or hardware wallet; event monitoring configured
- [ ] OR-5: Audit log shipped to tamper-evident sink; rotation, retention, integrity verification, and failure handling documented and tested
- [ ] OR-6: Rate limiting on analytics service
- [ ] OR-7: CORS restricted to production frontend domain
- [ ] OR-10: Independent audit complete; scope, pinned source revision, WASM hash, and findings recorded; critical/high findings fixed and independently verified
- [ ] OR-11: Soulbound enforcement matrix (§4.5) negative tests green in CI
- [ ] OR-12: Privacy review approves minimized on-chain schema (§4.6) and residual linkability risks documented
- [ ] Input/collection bounds (§4.7) enforced with boundary tests passing
- [ ] OR-13: Trusted proxy configuration verified; shared rate limiter in place for multi-instance deployment
- [ ] OR-14: Log redaction tests cover all request/error serializers
- [ ] Database integrity checks enabled at startup and readiness; operator alerting wired for corruption
- [ ] Date/timezone normalization documented in API schema and historical records backfilled to UTC
- [ ] All secret keys rotated from testnet values
- [ ] `STELLAR_NETWORK` set to `mainnet` with correct `STELLAR_NETWORK_PASSPHRASE`
- [ ] Threat model reviewed and signed off by security reviewer

---

## 7. Review History

| Date | Version | Author | Notes |
|---|---|---|---|
| 2026-04-28 | 1.0 | — | Initial full threat model (issue #112) |
| 2026-04-28 | 1.1 | — | Added soulbound enforcement matrix (§4.5, #75), privacy field classification (§4.6, #76), input/collection bounds (§4.7, #77), audit risk OR-10 (#73) |
| 2026-04-28 | 1.1 | — | Added trusted-proxy rate limiting, log redaction, DB integrity checks, and date/timezone normalization (issues #55, #58, #63, #64) |
| 2026-04-28 | 1.2 | — | Added revocation scope, duplicate detection, issuer lifecycle, and admin recovery/rotation threats (issues #79–#82) |
