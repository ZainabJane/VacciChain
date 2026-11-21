# VaccinationRecord Migration Guide

This document outlines the migration path for `VaccinationRecord` schema changes in the VacciChain contract.

## Current Schema (Version 1)

```rust
pub struct VaccinationRecord {
    pub token_id: u64,
    pub patient: Address,
    pub vaccine_name: String,
    pub date_administered: String,
    pub issuer: Address,
    pub timestamp: u64,
    pub schema_version: u32, // Added in #47
    pub revoked: bool,
    pub dose_number: u32,
    pub dose_series: u32,
}
```

## Privacy Field Policy

The on-chain schema is deliberately minimized to avoid embedding personally identifying
information (PII) or clinically sensitive data in immutable public contract state. Every field
is classified as follows:

| Field | Classification | Rationale |
| --- | --- | --- |
| `token_id` | Identifier (non-PII) | Opaque token reference; not derived from patient identity. |
| `patient` | Pseudonymous identifier | Stellar `Address`; linkable to the holder but not a name or contact detail. |
| `vaccine_name` | Minimal clinical detail | Required to verify the credential; no lot numbers, reactions, or diagnoses. |
| `date_administered` | Minimal clinical detail | Coarse administration date only; no time-of-day or location. |
| `issuer` | Public identifier | Issuing authority address; already public by design. |
| `timestamp` | Metadata | Ledger timestamp of record creation. |
| `schema_version` | Metadata | Schema evolution marker. |
| `revoked` | Status flag | Revocation state; no reason or clinical justification stored. |
| `dose_number` | Minimal clinical detail | Dose ordinal within a series; no batch or product details. |
| `dose_series` | Minimal clinical detail | Series identifier; no manufacturer or clinical notes. |

**Excluded fields (must never be added):** patient names, contact data (email, phone,
address), government/national ID numbers, dates of birth, free-text clinical notes,
adverse-event details, diagnoses, and any field that could re-identify a patient when
combined with off-chain data.

### Residual Linkability Risks

Even with the minimized schema, the following residual risks are documented and accepted:

-   **Address linkability:** The `patient` address is stable across records, so all
    credentials held by the same address are correlatable on-chain.
-   **Issuer + date correlation:** Combining `issuer`, `date_administered`, and
    `vaccine_name` may narrow the set of individuals for a small issuer population.
-   **Dose series patterns:** `dose_number`/`dose_series` reveal vaccination cadence,
    which may be sensitive in aggregate.
-   **Off-chain joins:** Any off-chain mapping of `token_id` or `patient` to identity
    re-identifies the record; such mappings must be access-controlled and never published.

Any proposed schema change must be reviewed against this policy before implementation.
=======

## Strategy for Schema Evolution

### 1. Adding Optional Fields
To add new fields without breaking existing records, use `Option<T>`. Soroban will deserialize missing fields as `None`.

### 2. Privacy Constraints on Schema Changes
No future schema version may add PII or unnecessary clinical fields. All additions must be
justified against the Privacy Field Policy above and pass privacy review. When in doubt,
store the data off-chain and keep only an opaque reference or hash on-chain.

### 3. Breaking Changes (Major Version Bump)
For breaking changes (e.g., removing fields or changing types):
1.  Define a new struct (e.g., `VaccinationRecordV2`).
2.  Update the `DataKey::Token` to store an `enum` wrapper:
    ```rust
    #[contracttype]
    pub enum VaccinationRecord {
        V1(VaccinationRecordV1),
        V2(VaccinationRecordV2),
    }
    ```
3.  Implement a "Lazy Migration" in `verify_vaccination`:
    -   When reading a record, check its version.
    -   If it's an old version, optionally migrate it to the latest version in storage when it's next accessed.

### 4. Graceful Handling in `verify_vaccination`
The `verify_vaccination` function should continue to support older versions by:
-   Using a common trait or converting older records to the latest internal representation before returning them to the caller.
-   Ignoring records that cannot be parsed if they are considered "corrupt" or from a version no longer supported.
