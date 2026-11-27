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
