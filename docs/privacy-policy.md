# VacciChain Privacy Policy & Data Retention

> **Status:** Draft — must be reviewed by a qualified legal/compliance advisor before mainnet launch.
> **Last updated:** 2026-04-28

---

## 1. Overview

VacciChain issues vaccination records as soulbound NFTs on the Stellar blockchain. This document describes what data is collected, where it is stored, how long it is retained, and how data subjects can exercise their rights under GDPR, HIPAA, and equivalent regulations.

---

## 2. Data Stores & Retention Policy

### 2.1 On-Chain Data (Stellar / Soroban)

| Data | Examples |
|---|---|
| Vaccination records | `vaccine_name`, `date_administered`, `issuer`, `patient_address` |
| Issuer registry | Authorized issuer public keys |
| Contract events | Mint, revoke, issuer-add/remove events |

**Retention:** Permanent by design. Blockchain data is immutable and cannot be deleted.

**Compliance note:** Because on-chain data cannot be erased, VacciChain minimises personal data written to the chain. Patient identity is represented only by a Stellar public key (pseudonymous). No names, dates of birth, or contact details are stored on-chain. Issuers must not include additional PII in the `vaccine_name` or other fields.

**Public-chain data is not private.** Everything written to the Stellar/Soroban ledger — including the pseudonymous patient address, `vaccine_name`, `date_administered`, issuer key, and all contract events — is publicly readable by anyone, forever. Pseudonymity is not anonymity: a public key can be correlated with other on-chain activity and, once linked to a person, all associated records become linkable. Patients and issuers must treat on-chain records as public disclosures and must not rely on the chain to keep any data confidential.

**Data subject requests:** Deletion of on-chain records is technically impossible. Issuers may *revoke* a vaccination record (setting its status to revoked), which removes its clinical validity while the pseudonymous record remains on-chain. Patients should be informed of this limitation at enrolment.

---

### 2.2 Audit Logs (`AUDIT_LOG_PATH`, default `./audit.log`)

Audit logs are append-only NDJSON files written by the backend for every state-changing operation (mint, revoke, issuer changes).

| Field | Content |
|---|---|
| `timestamp` | ISO-8601 UTC |
| `action` | e.g. `mint`, `revoke`, `add_issuer` |
| `actor` | Stellar public key of the authenticated caller |
| `patient` | Stellar public key (pseudonymous) |
| `ip` | Caller IP address |

**Retention:** 2 years from the date of the log entry, then purged.

**Purge mechanism:** Run the following command (or schedule it via cron):

```bash
# Purge audit log entries older than 2 years
node backend/scripts/purge_audit_log.mjs --older-than 730
```

See [`backend/scripts/purge_audit_log.mjs`](../backend/scripts/purge_audit_log.mjs) for implementation.

**GDPR / HIPAA:** Audit logs may contain IP addresses (personal data under GDPR). Logs must be stored with access controls (read: security team only). Logs must not be shared with third parties without a lawful basis.

---

### 2.3 Analytics Data (Python Service — in-memory / Horizon queries)

The analytics service (`python-service/`) does not persist data. All analytics are computed on-demand by querying the Stellar Horizon API and the on-chain contract state.

**Retention:** No persistent storage — no retention period applies.

**Note:** If a future version introduces a persistent analytics database, this policy must be updated before deployment.

---

### 2.4 SQLite Indexer Database (`DATABASE_PATH`, default `/data/vaccichain.db`)

The backend indexer caches on-chain events in a local SQLite database to serve fast queries without hitting the RPC on every request.

| Table | Content |
|---|---|
| `events` | Indexed contract events (mirrors on-chain data) |

**Retention:** The indexer database is a cache of public on-chain data. It may be wiped and rebuilt at any time by restarting the backend with an empty `DATABASE_PATH`. No additional personal data is stored beyond what is already on-chain.

**Data subject requests:** Wiping the indexer database does not affect on-chain records. It will be rebuilt automatically on next startup.

---

### 2.5 Consent & Allowlist Records

VacciChain does not maintain a separate consent database. Consent is expressed on-chain through the patient **allowlist** and is enforced by the contract at the issuance boundary. Issuers remain responsible for obtaining and recording informed consent in accordance with applicable law before requesting an issuance.

#### 2.5.1 Allowlist / consent state machine

Each patient address has a consent state that the contract tracks. The table below describes the state transitions and the resulting contract/API behaviour.

| State | How it is reached | Issuance behaviour | Verification behaviour |
|---|---|---|---|
| **Absent** (no entry) | Default for any address that has never been allowlisted | Issuance **rejected** (`Unauthorized` / not allowlisted). No record is written. | No record exists; verification returns "not found". |
| **Granted** | Patient (or their authorised representative) calls the allowlist/consent grant entry point | Issuance **permitted** by an authorised issuer for the allowlisted patient | Record is verifiable by anyone via public verification |
| **Revoked** | Patient calls the revoke/withdraw-consent entry point | Further issuance **rejected**; existing records are not deleted | Existing records remain publicly verifiable (on-chain data is immutable) |
| **Changed** | Consent is re-granted after revocation, or allowlist metadata (e.g. scope/issuer restrictions) is updated | Issuance permitted again under the new terms; previously issued records are unaffected | Previously issued records remain verifiable; new records reflect the new terms |

**Important:** Revoking consent stops *future* issuance only. It does **not** erase or hide records already written to the public chain. Patients must be told this before granting consent.

#### 2.5.2 API behaviour

- `POST /vaccinations` (issuance) returns `403 Forbidden` (or the contract's `Unauthorized` error mapped to HTTP 403) when the patient is **absent** or **revoked** from the allowlist. No transaction is submitted.
- Issuance by a caller that is not a registered/authorised issuer is rejected regardless of allowlist state.
- `GET /verify/:id` (public verification) is unauthenticated and returns only the public, non-prohibited fields (see §2.5.3). It does not reveal allowlist/consent state.
- Consent grant/revoke operations are state-changing and are recorded in the audit log (§2.2).

#### 2.5.3 Fields omitted from public verification

Public verification deliberately omits fields that are not required to prove a vaccination record's validity. The following are **never** returned by the public verification endpoint:

- Patient name, date of birth, contact details, or any other PII (never stored on-chain).
- Caller IP addresses and audit-log metadata.
- Consent/allowlist state and consent history.
- Internal database identifiers and indexer bookkeeping fields.

Only the pseudonymous patient address, `vaccine_name`, `date_administered`, issuer key, and record status (valid/revoked) are exposed.

**Recommendation:** Issuers should maintain their own consent records for a minimum of 6 years (HIPAA) or as required by local law, in addition to the on-chain allowlist state.

---

### 2.6 SEP-10 Nonces (`nonceStore`)

Short-lived nonces used for replay protection during SEP-10 authentication.

**Retention:** Nonces expire after 5 minutes and are evicted from the in-memory store automatically. No persistent storage.

---

### 2.7 JWT Sessions

JWTs are stateless and short-lived (1 hour). No session store is maintained server-side.

**Retention:** Not applicable — tokens expire automatically.

---

## 3. Off-Chain Data Purge Mechanism

For data subject deletion requests (GDPR Article 17 "right to erasure"):

1. **Audit logs** — run `purge_audit_log.mjs` targeting the subject's public key:
   ```bash
   node backend/scripts/purge_audit_log.mjs --wallet <STELLAR_PUBLIC_KEY>
   ```
2. **Indexer database** — delete rows referencing the subject's public key:
   ```bash
   node backend/scripts/purge_indexer.mjs --wallet <STELLAR_PUBLIC_KEY>
   ```
3. **On-chain records** — cannot be deleted. Inform the data subject that pseudonymous on-chain records are permanent. Offer revocation as an alternative.
4. **Issuer consent records** — handled by the issuing healthcare provider under their own data controller obligations.

All purge operations must be logged in a separate compliance audit trail (outside the main audit log).

---

## 4. Data Controller & Processor Responsibilities

| Role | Party | Obligations |
|---|---|---|
| Data Controller | Healthcare provider / issuer | Obtains patient consent, determines purpose of processing |
| Data Processor | VacciChain platform operator | Processes data on behalf of the controller per this policy |
| Sub-processor | Stellar Foundation (Horizon API) | Provides public blockchain infrastructure |

---

## 5. Security Measures

- Audit logs stored with filesystem permissions restricted to the backend process user.
- Database volume (`vaccichain_db`) not exposed outside the Docker network.
- All API endpoints protected by JWT or verifier API key.
- TLS required in production (enforced at load balancer / reverse proxy level).
- Secrets managed via environment variables; never logged.

---

## 6. Legal Basis for Processing (GDPR)

| Processing activity | Legal basis |
|---|---|
| Issuing vaccination records | Vital interests (Art. 9(2)(c)) or explicit consent (Art. 9(2)(a)) |
| Patient allowlisting / consent grant & revoke | Explicit consent (Art. 9(2)(a)) |
| Audit logging | Legitimate interests — security and fraud prevention (Art. 6(1)(f)) |
| On-chain verification | Public interest / official authority (Art. 6(1)(e)) |

**Note on public-chain disclosure:** Because on-chain records are public and permanent, processing that writes to the chain must be covered by explicit consent that specifically discloses the public, immutable nature of the disclosure. Consent obtained without this disclosure is not sufficient for on-chain issuance.

---

## 7. Compliance Review Requirement

> ⚠️ **This policy must be reviewed and approved by a qualified legal/compliance advisor before mainnet deployment.** The review should cover GDPR (EU), HIPAA (US), and any jurisdiction-specific health data regulations applicable to the deployment region.

---

## 8. Contact

For data subject requests or compliance enquiries, contact the platform operator at the address provided during onboarding.
