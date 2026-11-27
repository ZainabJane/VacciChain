# ADR-005: Patient Pre-Registration Allowlist

## Status
Accepted

## Context
Any Stellar wallet could receive a vaccination record without consent. An issuer could mint
to an arbitrary or attacker-controlled address, polluting on-chain state and potentially
enabling phishing (e.g. "you have a vaccination record — click here to view it").

Two options were evaluated:

| Option | Description |
|---|---|
| **Open minting** | Issuer can mint to any address; risk accepted and documented |
| **Patient pre-registration** | Patient must authenticate via SEP-10 and self-register before receiving a record |

## Decision
**Patient pre-registration** was chosen.

A patient must call `POST /patient/register` (requires a valid SEP-10 JWT) before any issuer
can mint to their wallet. The backend invokes `register_patient(patient)` on the Soroban
contract, which stores `PatientAllowlist(patient) → true` in persistent storage and emits a
`pat_reg` event. `mint_vaccination` rejects with `PatientNotRegistered` (error 16) if the
patient address is not in the allowlist.

## Consent and Allowlist Semantics

The allowlist entry is the on-chain representation of a patient's explicit consent to
receive records. Consent is modelled as a per-address state machine:

| State | Storage | How reached | Effect on issuance | Effect on verification |
|---|---|---|---|---|
| **Absent** | no `PatientAllowlist(patient)` entry | initial state; never registered | `mint_vaccination` rejects with `PatientNotRegistered` (16); `POST /patient/register` is the only path forward | no records can exist for the address; `GET /vaccination/:wallet` returns an empty list |
| **Granted** | `PatientAllowlist(patient) → true` | `POST /patient/register` (SEP-10 JWT) → `register_patient` → `pat_reg` event | issuance permitted; `mint_vaccination` succeeds | records are returned to the authenticated holder; public verification works as described below |
| **Revoked** | `PatientAllowlist(patient) → false` | `POST /patient/revoke` (SEP-10 JWT) → `revoke_patient` → `pat_rev` event | `mint_vaccination` rejects with `PatientNotRegistered` (16) | already-issued records remain on-chain and remain publicly verifiable; revocation prevents *future* issuance only |
| **Changed** | entry updated in place (`true` → `false` → `true`) | re-registration after revocation | issuance permitted again once re-granted; each transition emits its own event | unchanged; previously issued records are unaffected |

### State transition rules
- `Absent → Granted`: `register_patient` writes `true` and emits `pat_reg`. Idempotent
  re-registration while already granted is a no-op (no duplicate event).
- `Granted → Revoked`: `revoke_patient` writes `false` and emits `pat_rev`. Revocation is
  **not** retroactive — it does not burn or invalidate existing tokens.
- `Revoked → Granted`: re-registration writes `true` again and emits a new `pat_reg`.
- Any other transition (e.g. revoking an absent entry) is rejected by the contract.

### API behaviour
- `POST /patient/register` — requires SEP-10 JWT; the JWT subject must equal the wallet
  being registered. Returns `409` if already granted, `401` without a valid JWT.
- `POST /patient/revoke` — requires SEP-10 JWT; returns `409` if not currently granted.
- `POST /issuer/mint` — returns `403`/`PatientNotRegistered` when the target wallet is
  absent or revoked; the backend surfaces the contract error code verbatim.
- `GET /vaccination/:wallet` — returns an empty list for absent/revoked wallets with no
  records; revocation does not hide records that were already issued.

### Privacy boundary
Consent and allowlisting control **who may issue**, not **who may read**. All data written
to the public Stellar/Soroban chain — including allowlist entries, `pat_reg`/`pat_rev`
events, and issued vaccination tokens — is public and permanent. Allowlisting a patient
does **not** make their records private, and revoking consent does **not** remove data from
the chain. Prohibited fields (e.g. patient name, date of birth, free-text notes) are never
written on-chain; only opaque identifiers and hashes are stored, with the mapping held
off-chain. Public verification therefore reveals only the fields explicitly defined as
public in ADR-002 and never the prohibited fields.

## Consequences

### Positive
- Patients explicitly consent to receiving records before any record is issued.
- Eliminates unsolicited minting to arbitrary or attacker-controlled addresses.
- Enforcement is at the contract level — no backend bypass is possible.
- Audit trail: `pat_reg`/`pat_rev` events are on-chain and indexable, giving a full
  consent history (granted, revoked, re-granted).
- Revocation gives patients a way to stop future issuance without affecting the
  verifiability of records already issued.

### Negative
- Adds one extra step to the patient onboarding flow (authenticate → register → receive record).
- Issuers must coordinate with patients to ensure registration before scheduling a mint.
- Revocation is not retroactive; patients cannot use it to erase already-published data.
- Because the chain is public, allowlist state and consent transitions are themselves
  publicly observable.

## Alternatives Considered

### Open Minting
- **Pros**: Simpler flow, no patient action required before receiving a record.
- **Cons**: Issuers can mint to any address without consent; enables spam/phishing vectors.
- **Rejected**: Risk is not acceptable for a healthcare credential system.

## Implementation Notes
- `contracts/src/storage.rs`: `DataKey::PatientAllowlist(Address)` added.
- `contracts/src/lib.rs`: `register_patient`, `revoke_patient`, `is_patient_registered` functions; `PatientNotRegistered = 16` error.
- `contracts/src/mint.rs`: allowlist check added before minting.
- `contracts/src/events.rs`: `emit_patient_registered`, `emit_patient_revoked` added.
- `backend/src/routes/patient.js`: `POST /patient/register`, `POST /patient/revoke` (SEP-10 JWT required).
- `backend/src/app.js`: `/patient` route mounted.
- Tests: unauthorized issuance (absent/revoked wallet) is rejected with `PatientNotRegistered`; public verification responses are asserted to contain only public fields and none of the prohibited fields.

## References
- Issue #111: Implement wallet address allowlist for patient registration
- ADR-003: SEP-10 Authentication
- ADR-002: Soulbound Token Design
