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

**Data subject requests:** Deletion of on-chain records is technically impossible. Issuers may *revoke* a vaccination record (setting its status to revoked), which removes its clinical validity while the pseudonymous record remains on-chain. Patients should be informed of this limitation at enrolment.

#### 2.1.1 On-Chain Field Policy (Privacy-Safe Schema)

Every field written to immutable contract state is classified below. The guiding rule: **if a field is not required to verify that a vaccination was administered by an authorized issuer, it does not belong on-chain.** Anything that identifies a person, enables contact, or describes clinical detail beyond the minimum is prohibited.

**Classification legend**

| Class | Meaning |
|---|---|
| **Public-safe** | Non-personal, non-clinical metadata. Safe to publish and index. |
| **Pseudonymous** | Indirectly identifying via a public key. Permitted only where required for verification. |
| **Prohibited** | Must never be written to contract state, events, or calldata. |

**Field-by-field classification**

| Contract field | Class | Rationale |
|---|---|---|
| `patient_address` (Stellar public key) | Pseudonymous | Required to bind the record to the holder. Not a name; linkable only via external correlation (see 2.1.2). |
| `issuer` (authorized issuer public key) | Public-safe | Organizational identifier; issuers are public entities. |
| `vaccine_name` (controlled code, e.g. `COVID19`, `MMR`) | Public-safe | Must be drawn from a fixed allow-list of vaccine codes. Free-text is prohibited. |
| `date_administered` (date only, no time) | Pseudonymous | Coarse date is needed for validity checks; time-of-day is prohibited as it increases correlation risk. |
| `status` (`active` / `revoked`) | Public-safe | Lifecycle flag; no clinical content. |
| `token_id` (sequential) | Pseudonymous | Sequential IDs leak issuance volume and ordering (see 2.1.2). |
| `issuer_registry` entries | Public-safe | Public keys of authorized issuers only. |
| Contract events (`mint`, `revoke`, `issuer_add`, `issuer_remove`) | Pseudonymous | Emit only the fields above; no additional payload. |

**Explicitly prohibited on-chain**

- **Patient names** (given, family, or any component), aliases, or initials.
- **Contact data**: email addresses, phone numbers, postal addresses, messaging handles.
- **Government / national identifiers**: SSN, national ID, passport, insurance or policy numbers.
- **Dates of birth** and any age-revealing field.
- **Unnecessary clinical details**: dose lot numbers, administering clinician identity, clinic/site name, adverse-event notes, diagnoses, allergies, free-text remarks, and any field derived from a medical record beyond the vaccine code and administration date.
- **Free-text fields of any kind** — all string fields must be validated against fixed enumerations or public keys.
- **IP addresses, device identifiers, or geolocation** in events or calldata.

**Enforcement:** Contract entry points must reject any argument outside the allow-listed schema (unknown enum values, malformed keys, over-length strings). Off-chain services must not pass prohibited data into contract calls. Any schema change requires a new privacy review (Section 7).

#### 2.1.2 Residual Linkability Risks

Even with the minimized schema, on-chain data is public and permanent. The following residual risks are accepted and must be documented to data subjects:

| Risk | Description | Mitigation |
|---|---|---|
| **Wallet-to-record correlation** | A `patient_address` links all of that wallet's vaccination records together, and to any other on-chain activity of the same key. If the key is ever linked to a real identity (e.g. by the issuer, an exchange, or voluntary disclosure), all associated records become identifiable. | Patients should use a dedicated wallet for VacciChain; issuers must not publish wallet-to-identity mappings. |
| **Timing correlation** | `date_administered` combined with mint event timestamps can narrow down when and where a person was vaccinated, potentially revealing health status. | Store date only (no time); avoid minting in real time where feasible. |
| **Sequential token IDs** | Monotonic `token_id` values reveal total issuance volume, issuance order, and can be used to infer issuer activity patterns or enumerate records. | Treat IDs as pseudonymous; do not expose mappings between token IDs and identities off-chain. |
| **Issuer linkage** | The `issuer` field reveals which provider administered the vaccine, which in small populations may narrow identity. | Accepted; issuers are public entities and this is required for verification. |
| **Revocation events** | A `revoke` event publicly signals a change in a record's validity, which may imply a health or data-integrity event. | Revocation reason is never recorded on-chain. |

These risks cannot be fully eliminated on a public immutable ledger. They are disclosed to patients at enrolment, and the minimized schema above is the primary control.

#### 2.1.3 Privacy Review Sign-Off

The minimized on-chain schema in 2.1.1 and the residual risk assessment in 2.1.2 have been reviewed and approved under backlog item #76.

| Item | Status |
|---|---|
| Field classification complete (public-safe / pseudonymous / prohibited) | ✅ Approved |
| Patient names, contact data, and unnecessary clinical details excluded | ✅ Approved |
| Residual linkability risks documented | ✅ Approved |
| Schema minimization approved for implementation | ✅ Approved |

> **Reviewer:** Privacy review (backlog #76) · **Date:** 2026-04-28
> Any addition of a new on-chain field, event payload, or free-text value requires re-review and sign-off before deployment.

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

### 2.5 Consent Records

VacciChain does not currently maintain a separate consent database. Patient consent is implicit in the act of providing a Stellar wallet address to an authorized issuer. Issuers are responsible for obtaining and recording informed consent in accordance with applicable law before minting a vaccination record.

**Recommendation:** Issuers should maintain their own consent records for a minimum of 6 years (HIPAA) or as required by local law.

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
| Audit logging | Legitimate interests — security and fraud prevention (Art. 6(1)(f)) |
| On-chain verification | Public interest / official authority (Art. 6(1)(e)) |

---

## 7. Compliance Review Requirement

> ⚠️ **This policy must be reviewed and approved by a qualified legal/compliance advisor before mainnet deployment.** The review should cover GDPR (EU), HIPAA (US), and any jurisdiction-specific health data regulations applicable to the deployment region.

---

## 8. Contact

For data subject requests or compliance enquiries, contact the platform operator at the address provided during onboarding.
