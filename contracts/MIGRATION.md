# VaccinationRecord Migration Guide

This document outlines the migration path for `VaccinationRecord` schema changes in the VacciChain contract, the versioned event schemas emitted by the contract, and the authorization rules governing contract upgrades.

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

## Versioned Event Schemas

Every state-changing action emits an event whose name, fields, and version are part of the contract's public interface. Indexers must be able to interpret events emitted before and after an upgrade without misclassifying payloads.

### Event Naming and Versioning Rules

-   Event names are stable and never reused for a different payload shape.
-   Every event payload includes a `version: u32` field as its first data element. The version is bumped whenever the payload shape changes.
-   Additive changes (new trailing fields) bump the minor version and keep the event name; indexers must tolerate unknown trailing fields.
-   Breaking changes (removed fields, changed types, reordered fields) require a new event name suffixed with the major version (e.g. `record_issued_v2`) and the old event is deprecated but still emitted for at least one upgrade cycle.
-   Topics are `(event_name, version)` so indexers can filter by version without decoding the payload.

### Event Catalogue (Version 1)

| Event name | Emitted by | Fields (in order) |
| --- | --- | --- |
| `record_issued` | `issue_vaccination` | `version: u32`, `token_id: u64`, `patient: Address`, `issuer: Address`, `schema_version: u32` |
| `record_verified` | `verify_vaccination` | `version: u32`, `token_id: u64`, `verifier: Address`, `valid: bool` |
| `record_revoked` | `revoke_vaccination` | `version: u32`, `token_id: u64`, `issuer: Address` |
| `record_migrated` | lazy migration path | `version: u32`, `token_id: u64`, `from_schema: u32`, `to_schema: u32` |
| `contract_upgraded` | `upgrade` | `version: u32`, `from_wasm_hash: BytesN<32>`, `to_wasm_hash: BytesN<32>`, `proposer: Address` |

### Indexer Guidance

1.  Decode the `version` field first and dispatch to the matching payload parser. Never infer the version from field count alone.
2.  Keep parsers for every previously published event version; do not delete old parsers when a new version ships.
3.  Treat unknown trailing fields as forward-compatible additions and ignore them.
4.  If an event name is unknown, record it as `unclassified` rather than dropping it, so operators can detect indexer lag after an upgrade.
5.  Fixtures under `contracts/fixtures/events/` contain one serialized sample per event version; contract tests assert emitted events match these fixtures byte-for-byte.

## Upgrade Authorization and Compatibility

### Authorized Upgrade Process

1.  **Proposer:** Only the address stored under `DataKey::Admin` may call `upgrade`. The proposal must include the new WASM hash and a changelog entry describing state and event changes.
2.  **Approval:** Upgrades require approval from the configured approver set (multisig). A single admin signature is insufficient once approvers are configured.
3.  **Artifact review:** The new WASM must be reviewed for storage layout compatibility, event schema changes, and migration code before approval. The review record is referenced in the upgrade proposal.
4.  **Execution:** On approval, the contract emits `contract_upgraded` and runs any registered migration entrypoint before accepting new state changes.

### Rollback Limitations

-   Rollback to a previous WASM hash is permitted only if no storage migration has run; migrations are not automatically reversible.
-   If a migration has run, rollback requires a forward-fix upgrade with an explicit reverse migration and a new approval.
-   The `contract_upgraded` event history is the authoritative record of which WASM hash was active at any point.

### State Compatibility Across Supported Upgrades

-   Supported upgrade paths are documented per release; skipping more than one major schema version requires an explicit migration.
-   Storage keys are never repurposed. Deprecated keys remain readable until a major version removes them with a documented migration.
-   Tests must verify that unauthorized callers cannot upgrade, and that state written before an upgrade remains valid and readable after each supported upgrade path.

## Supported Schema Changes and Migration Fixtures

Every supported schema change must ship with a fixture-based migration test that
replays prior on-chain state and asserts that records are neither misread,
dropped, nor locked. Fixtures live in `contracts/test_fixtures/migrations/`.

| Change | From → To | Fixture | Test |
| --- | --- | --- | --- |
| Add `schema_version` field | V0 (no version) → V1 | `v0_to_v1_records.json` | `test_migration_v0_to_v1` |
| Add optional fields (`Option<T>`) | V1 → V1 (additive) | `v1_additive_fields.json` | `test_migration_v1_additive_fields` |
| Wrap records in versioned enum | V1 → V2 | `v1_to_v2_enum.json` | `test_migration_v1_to_v2_enum` |
| Change field type (breaking) | V2 → V3 | `v2_to_v3_type_change.json` | `test_migration_v2_to_v3_type_change` |

Each fixture contains:
-   `schema_version`: the version the records were written with.
-   `records`: serialized `DataKey::Token` entries as stored on-chain.
-   `expected`: the records as they must be readable after migration.

The migration tests must verify, for every fixture:
1.  All prior records remain readable (no dropped records).
2.  Field values are preserved exactly (no misread records).
3.  Records remain writable/updatable after migration (no locked records).
4.  Re-running the migration is idempotent.

## Unsupported Upgrade Paths

An upgrade path is unsupported when the stored `schema_version` is greater than
the version the new contract understands, or when a record cannot be deserialized
into any known version.

### Safe-failure behavior
-   The contract must **fail closed**: reads of unparseable or future-version
    records return an error (`Error::UnsupportedSchemaVersion`) rather than
    silently returning empty or default data.
-   No destructive writes may occur during a failed migration; existing storage
    entries are left untouched.
-   The contract version is not bumped, so the prior WASM remains a valid
    rollback target.

### Recovery plan
1.  **Rollback:** Upgrade the contract back to the prior WASM version. Because
    the failed migration performed no destructive writes, the prior version can
    read all existing records.
2.  **Re-run migration:** After fixing the migration logic, redeploy the new
    WASM and re-run the migration. Migrations must be idempotent so a partial
    prior attempt is safe to repeat.
3.  **Verify records:** Run the fixture-based migration tests against a snapshot
    of the affected state and confirm all records are readable, correct, and
    writable before resuming normal operation.
