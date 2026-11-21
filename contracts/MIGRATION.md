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
}
```

## Strategy for Schema Evolution

### 1. Adding Optional Fields
To add new fields without breaking existing records, use `Option<T>`. Soroban will deserialize missing fields as `None`.

### 2. Breaking Changes (Major Version Bump)
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

### 3. Graceful Handling in `verify_vaccination`
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
