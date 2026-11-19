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

## Contract Deployment: Idempotent Deploy / Upgrade / No-Op Semantics

Contract deployment is managed by the deployment workflow (see `.github/workflows/`). The workflow is **idempotent**: re-running it against an already-deployed contract will never silently create a second production contract. Instead, every run resolves to exactly one of three paths — **deploy**, **upgrade**, or **no-op** — based on the recorded deployment state and the requested action.

### Deployment Manifest Format

The workflow reads and writes a deployment manifest that records the authoritative state of each deployed contract. The manifest is checked into the repository (or stored as a workflow artifact) and is the single source of truth for "what is currently deployed where."

```json
{
  "network": "testnet",
  "contracts": {
    "vaccination_record": {
      "contract_id": "CABC...XYZ",
      "wasm_hash": "9f2c...e41a",
      "schema_version": 1,
      "deployed_at_ledger": 123456,
      "deployed_at": "2024-01-01T00:00:00Z",
      "deployed_by": "github-actions[bot]"
    }
  }
}
```

Manifest fields:

| Field | Description |
| --- | --- |
| `network` | Target network (`testnet`, `futurenet`, `mainnet`). One manifest per network. |
| `contracts.<name>.contract_id` | The deployed contract address. Present only after a successful deploy. |
| `contracts.<name>.wasm_hash` | Hash of the WASM currently deployed. Used to detect whether an upgrade is needed. |
| `contracts.<name>.schema_version` | The `VaccinationRecord` schema version the deployed contract understands. |
| `contracts.<name>.deployed_at_ledger` | Ledger sequence of the last deploy/upgrade. |
| `contracts.<name>.deployed_at` | Timestamp of the last deploy/upgrade. |
| `contracts.<name>.deployed_by` | Actor that performed the last deploy/upgrade. |

### Path Resolution

On each run the workflow compares the manifest entry for the target contract against the WASM being built:

1.  **No-op** — A `contract_id` exists in the manifest **and** its recorded `wasm_hash` matches the hash of the newly built WASM. The workflow performs no on-chain action and reports success. This is the default outcome for re-runs of a completed deployment.
2.  **Upgrade** — A `contract_id` exists in the manifest **but** its recorded `wasm_hash` differs from the newly built WASM. The workflow invokes the contract's upgrade entry point against the **existing** `contract_id` and then updates the manifest's `wasm_hash`, `schema_version`, `deployed_at_ledger`, `deployed_at`, and `deployed_by`.
3.  **Deploy** — No `contract_id` exists in the manifest for the target contract. The workflow deploys a new contract, records the resulting `contract_id` and `wasm_hash` in the manifest, and commits the updated manifest.

### Explicit Target Contract for Upgrades

Upgrades **must** name an explicit target contract. The workflow refuses to run an upgrade unless the target `contract_id` is supplied (via the manifest entry or an explicit `target_contract` input) and matches the manifest. This prevents an upgrade from accidentally being applied to the wrong contract, and prevents an ambiguous state from being resolved by guessing.

If the manifest records a `contract_id` but the requested action is `deploy`, the workflow fails fast rather than deploying a second contract. To intentionally deploy a fresh contract, the operator must first remove the manifest entry (or bump the contract name) in a reviewed change.

### Preventing a Second Production Contract on Re-Run

The following invariants guarantee that re-running a completed deployment cannot silently create an unintended second production contract:

-   **Manifest is authoritative.** The workflow always reads the manifest before deciding which path to take. A `contract_id` present in the manifest forces the run into the **upgrade** or **no-op** path — never **deploy**.
-   **Hash-based no-op detection.** Re-running with an unchanged WASM resolves to **no-op**, so no on-chain transaction is submitted.
-   **Deploy requires an empty slot.** The **deploy** path is only reachable when the manifest has no `contract_id` for the target contract. Any attempt to deploy over an existing entry fails the run.
-   **Manifest is updated atomically with the on-chain action.** The manifest is written only after the deploy/upgrade transaction is confirmed, and the updated manifest is committed as part of the same workflow run. A failed or interrupted run leaves the manifest unchanged, so the next run re-evaluates from a consistent state.
-   **Production networks require explicit confirmation.** For `mainnet`, the workflow requires an explicit `confirm: true` input and a matching `target_contract` for upgrades, so an accidental re-run cannot mutate production state without an intentional signal.