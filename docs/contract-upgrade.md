# Contract Upgrade Procedure

VacciChain uses Soroban's native WASM upgrade mechanism. The contract's storage and address remain unchanged — only the executable code is replaced.

## How it works

The `upgrade(new_wasm_hash)` function:
1. Requires auth from the stored admin address.
2. Calls `env.deployer().update_current_contract_wasm(new_wasm_hash)`.
3. Emits a `ContractUpgraded { new_wasm_hash, admin, timestamp }` event.

All existing storage (patient records, issuers, admin) is preserved across upgrades.

---

## Authorization and approval

Upgrades are gated by the contract's stored admin address. There is no separate
proposer role in the contract: **the admin is the only authorized proposer and
executor of an upgrade.** Any call to `upgrade` that is not authorized by the
stored admin fails with an auth error and leaves contract state untouched
(verified in `upgrade_tests.rs`).

Because the contract enforces a single admin signature, the approval process is
an off-chain governance requirement that must be completed *before* the admin
key is used:

1. **Proposal** — A maintainer opens a PR containing the source changes and a
   completed upgrade checklist. The PR must reference the target release tag.
2. **Approval** — At least two maintainers (one of whom must be a contract
   owner) review and approve the PR. The admin key holder is not permitted to
   self-approve.
3. **Artifact review** — Reviewers verify the built WASM hash matches the
   approved commit (see below) before the hash is submitted on-chain.
4. **Execution** — Only after 1–3 are complete may the admin key holder upload
   and invoke the upgrade.

### Artifact review steps

- Build from the tagged, reviewed commit in a clean environment (`make build`).
- Record the SHA-256 of `vacci_chain.wasm` and the resulting on-chain
  `new_wasm_hash` in the PR.
- Confirm the uploaded WASM hash equals the hash produced from the reviewed
  commit; a mismatch aborts the upgrade.
- Confirm the diff contains no changes to storage keys or data layouts unless a
  migration is explicitly documented (see *Migration responsibilities*).

### Rollback limitations

Soroban's upgrade mechanism is **forward-only**: `update_current_contract_wasm`
replaces the code in place and there is no built-in revert. To roll back you
must perform another upgrade to a previously reviewed WASM hash, which means:

- The previous WASM must still be uploaded and its hash known; keep the last
  known-good hash recorded for every release.
- A rollback is itself an upgrade and requires the same authorization and
  approval steps.
- Rollback cannot undo storage writes made by the faulty version. If the new
  version wrote data in an incompatible layout, a rollback may leave state
  unreadable — this is why migrations must be additive and backward compatible.
- There is no time-lock or automatic rollback; recovery depends on the admin key
  remaining available.

---

## Client compatibility guarantees

- The contract address and all storage keys are stable across upgrades; clients
  do not need to re-point at a new contract ID.
- Existing entry points (`register_issuer`, `mint_vaccination`,
  `verify_vaccination`, etc.) keep their signatures across patch and minor
  upgrades. Removing or changing an entry point signature is a breaking change
  and requires a major version bump plus a client migration note.
- Events keep their topic and data shape for existing event types; new fields
  are only ever appended.
- Clients should tolerate unknown event types and unknown trailing fields so
  that additive changes do not break them.

## Migration responsibilities

- The upgrade author is responsible for any storage migration and must document
  it in the PR, including how old records remain readable.
- Migrations must be additive: never delete or reinterpret existing keys in a
  way that makes previously written records unreadable by the new code.
- Post-upgrade, the author must spot-check existing records via
  `verify_vaccination` and confirm state validity, as covered by the
  state-preservation tests in `upgrade_tests.rs`.

---

## Step-by-step

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

### 6. Repeat on mainnet

Replace the RPC URL and network passphrase:

```bash
--rpc-url https://soroban-mainnet.stellar.org
--network-passphrase "Public Global Stellar Network ; September 2015"
```

---

## Security checklist

- [ ] New WASM built from a tagged, reviewed commit
- [ ] PR approved by at least two maintainers (no self-approval by key holder)
- [ ] Built WASM hash matches the reviewed commit and the uploaded hash
- [ ] Storage migration (if any) documented and backward compatible
- [ ] Upgrade tested end-to-end on testnet
- [ ] Unauthorized upgrade attempt confirmed to fail (see `upgrade_tests.rs`)
- [ ] Admin key used from a hardware wallet or secure key management system
- [ ] `upgraded` event confirmed on-chain after execution
- [ ] Existing records spot-checked via `verify_vaccination` post-upgrade
- [ ] Last known-good WASM hash recorded for potential rollback
