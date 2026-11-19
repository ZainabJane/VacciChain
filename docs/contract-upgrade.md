# Contract Upgrade Procedure

VacciChain uses Soroban's native WASM upgrade mechanism. The contract's storage and address remain unchanged — only the executable code is replaced.

> **CI-driven deployments.** Contract-path pushes no longer deploy a fresh contract by default. The deployment workflow classifies each run as **deploy**, **upgrade**, or **no-op** (see [CI deploy/upgrade/no-op decision](#ci-deployupgradeno-op-decision) below). Manual steps in this document are for break-glass situations only.

## CI deploy/upgrade/no-op decision

The `contracts-deploy` workflow inspects the deployment manifest and the pushed changes, then takes exactly one path:

| Path | When | Effect |
| --- | --- | --- |
| **deploy** | No manifest entry exists for the target network, or the manifest explicitly marks the contract as `absent` | Uploads WASM and instantiates a **new** contract, then records its ID in the manifest |
| **upgrade** | A manifest entry exists for the target network **and** `target_contract` is provided | Uploads the new WASM and invokes `upgrade(new_wasm_hash)` on the **existing** contract |
| **no-op** | The computed WASM hash matches the hash recorded in the manifest for the target network | Nothing is uploaded or invoked; the run exits successfully |

The workflow fails fast (no deploy, no upgrade) when:

- A manifest entry exists but `target_contract` is **not** supplied — upgrades require an explicit target.
- `target_contract` is supplied but does not match the manifest entry for that network.
- The manifest is missing or unreadable for a network that already has a recorded contract.

### Required input: `target_contract`

Upgrades **must** pass the existing contract ID explicitly:

```yaml
# .github/workflows/contracts-deploy.yml (excerpt)
on:
  workflow_dispatch:
    inputs:
      target_contract:
        description: "Existing contract ID to upgrade (required for upgrades)"
        required: false
        type: string
```

- `target_contract` is **required** whenever the manifest shows an existing deployment for the selected network.
- It is **ignored** on the deploy path (a new contract is created and its ID recorded).
- The workflow refuses to run an upgrade if `target_contract` is empty, so a re-run can never silently create a second production contract.

### Deployment manifest

The workflow reads and writes `deployments/<network>.json`, which is committed back to the repository (or stored as a workflow artifact plus a protected branch commit):

```json
{
  "network": "testnet",
  "contract_id": "C...",
  "wasm_hash": "abc123...",
  "deployed_at": "2025-01-01T00:00:00Z",
  "deployed_by": "ci"
}
```

- The manifest is the **single source of truth** for "does a contract already exist on this network?".
- Before any deploy, the workflow checks the manifest. If an entry exists, the run is classified as **upgrade** (with `target_contract`) or **no-op** (matching hash) — never **deploy**.
- After a successful deploy or upgrade, the manifest is updated with the new `wasm_hash` (and `contract_id` on first deploy) so subsequent re-runs become no-ops.
- Re-running a completed deployment is therefore idempotent: the hash matches and the run is a no-op.

### Policy gate for production upgrades

Production (`mainnet`) upgrades are gated:

- The workflow requires approval from the `production-contracts` GitHub Environment before the upgrade step executes.
- The approval request includes the `target_contract`, the current manifest `wasm_hash`, and the new `wasm_hash` for review.
- Upgrades without approval are blocked; the job fails without touching the network.
- Testnet upgrades run automatically after the testnet smoke tests pass.
=======

## How it works

The `upgrade(new_wasm_hash)` function:
1. Requires auth from the stored admin address.
2. Calls `env.deployer().update_current_contract_wasm(new_wasm_hash)`.
3. Emits a `ContractUpgraded { new_wasm_hash, admin, timestamp }` event.

All existing storage (patient records, issuers, admin) is preserved across upgrades.

---

## Manual step-by-step (break-glass only)

Prefer the CI workflow above. Use these steps only when CI is unavailable and you have explicit approval.

### 1. Build the new WASM

```bash
cd contracts
make build
# outputs: target/wasm32-unknown-unknown/release/vacci_chain.wasm
```

### 2. Upload the WASM to the network (testnet first)

```bash
soroban contract upload \
  --wasm target/wasm32-unknown-unknown/release/vacci_chain.wasm \
  --source <ADMIN_SECRET_KEY> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"
# Outputs: <NEW_WASM_HASH>
```

### 3. Invoke the upgrade function

```bash
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_SECRET_KEY> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- upgrade \
  --new_wasm_hash <NEW_WASM_HASH>
```

### 4. Verify the upgrade

Confirm the `upgraded` event was emitted:

```bash
soroban events \
  --id <CONTRACT_ID> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"
```

Check that the event contains the expected `new_wasm_hash`, `admin`, and `timestamp`.

### 5. Smoke-test on testnet

Run a `verify_vaccination` call and a test mint against the upgraded contract before proceeding to mainnet.

### 6. Update the deployment manifest

Record the new `wasm_hash` (and `contract_id` if this was a first deploy) in `deployments/<network>.json` so future CI runs classify correctly as **upgrade** or **no-op** rather than **deploy**.

### 7. Repeat on mainnet

Replace the RPC URL and network passphrase:

```bash
--rpc-url https://soroban-mainnet.stellar.org
--network-passphrase "Public Global Stellar Network ; September 2015"
```

---

## Security checklist

- [ ] New WASM built from a tagged, reviewed commit
- [ ] Upgrade tested end-to-end on testnet
- [ ] Admin key used from a hardware wallet or secure key management system
- [ ] `upgraded` event confirmed on-chain after execution
- [ ] Existing records spot-checked via `verify_vaccination` post-upgrade
- [ ] `target_contract` matched the manifest entry for the network
- [ ] Deployment manifest updated with the new `wasm_hash`
- [ ] Production upgrade approved via the `production-contracts` environment gate
