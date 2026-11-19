# Contract Upgrade Procedure

VacciChain uses Soroban's native WASM upgrade mechanism. The contract's storage and address remain unchanged — only the executable code is replaced.

## Supported toolchain policy

The contract is built and tested against the following pinned versions. These are declared in `contracts/rust-toolchain.toml`, `contracts/Cargo.toml`, and the CI workflow; CI fails if the local toolchain does not match.

| Component | Supported version | Declared in |
|-----------|-------------------|-------------|
| Rust | pinned stable channel (see `rust-toolchain.toml`) | `contracts/rust-toolchain.toml` |
| `soroban-sdk` | version pinned in `contracts/Cargo.toml` | `contracts/Cargo.toml` |
| Stellar CLI (`soroban`) | version pinned in CI workflow | `.github/workflows/` |

CI verifies the declared toolchain on every push and runs `cargo audit` (or equivalent advisory check) against the locked dependency graph. A failing advisory check blocks merge.

### Dependency upgrade procedure

Any change to Rust, `soroban-sdk`, or the Stellar CLI version must go through a dedicated PR that:

1. **Passes all tests** — unit tests, integration tests, and the full contract test suite must be green.
2. **Compares resources** — record CPU instructions and memory usage for the key entry points (`verify_vaccination`, `mint`, `upgrade`) before and after the bump, and include the comparison in the PR description. Significant regressions must be justified.
3. **Updates release notes** — add an entry to `CHANGELOG.md` describing the version change and any behavioral impact.
4. **Updates this document** — keep the toolchain table above in sync with the pinned versions.

Dependency upgrades are reviewed by at least one maintainer with contracts experience before merge.

## Version-specific behavior and compatibility

The contract exposes a stable public interface. Callers can rely on the following guarantees across upgrades:

- **Function signatures** — public method names and argument types are treated as stable. Removing or renaming a public method, or changing an argument's type, is a breaking change and requires a major version bump plus a migration note in the release notes.
- **Authorization** — the auth model (admin-gated `upgrade`, issuer-gated `mint`, public `verify_vaccination`) is part of the contract's contract. Changes to who may call a method are breaking changes.
- **Error codes** — error variants are stable identifiers. New variants may be added, but existing variants must not be renumbered or repurposed. The backend maps each contract error to a stable API response; see the backend mapping tests for the authoritative mapping.
- **Storage layout** — existing storage keys and value shapes are preserved across upgrades. Any layout change must include a migration path documented in the release notes.
- **Events** — event topics and payload fields are additive-only; existing fields are not removed or reordered.

Behavior that differs between contract versions is documented in `CHANGELOG.md` under the corresponding version heading.

## How it works

The `upgrade(new_wasm_hash)` function:
1. Requires auth from the stored admin address.
2. Calls `env.deployer().update_current_contract_wasm(new_wasm_hash)`.
3. Emits a `ContractUpgraded { new_wasm_hash, admin, timestamp }` event.

All existing storage (patient records, issuers, admin) is preserved across upgrades.

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
- [ ] Upgrade tested end-to-end on testnet
- [ ] Admin key used from a hardware wallet or secure key management system
- [ ] `upgraded` event confirmed on-chain after execution
- [ ] Existing records spot-checked via `verify_vaccination` post-upgrade
- [ ] Toolchain versions in the table above match the pinned files
- [ ] Resource (CPU/memory) comparison recorded in the PR
- [ ] Release notes updated in `CHANGELOG.md`
