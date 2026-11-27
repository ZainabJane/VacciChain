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

The WASM must be built from the audited, pinned source revision recorded in the security audit (see [security-audit.md](./security-audit.md)). Do not upgrade from an unreviewed branch or working tree.

```bash
cd contracts
git checkout <AUDITED_COMMIT_SHA>   # pinned, audited revision
make build
# outputs: target/wasm32-unknown-unknown/release/vacci_chain.wasm
```

Record the SHA-256 hash of the built artifact and confirm it matches the audited WASM hash:

```bash
sha256sum target/wasm32-unknown-unknown/release/vacci_chain.wasm
# compare against the audited WASM hash in docs/security-audit.md
```

If the hash does not match the audited artifact, stop — the build is not the audited code.

> **Re-audit required:** Any upgrade that changes contract code after the audit must trigger a re-audit of the changed code (authorization, storage, lifecycle, upgrade, and privacy properties) before mainnet deployment. Record the new findings and pinned revision in [security-audit.md](./security-audit.md).

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

## Schema versioning and unsupported upgrade paths

Every contract version that changes the storage schema must bump the stored
schema version (see `SCHEMA_VERSION` in the contract). Migration tests
(`contracts/vacci-chain/src/migration_tests.rs`) run each supported schema
change against a fixture of prior state, and verify that unsupported upgrade
paths fail safely instead of misreading, dropping, or locking records.

### Detecting an unsupported schema version

Before invoking `upgrade`, read the current on-chain schema version:

```bash
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_SECRET_KEY> \
  --rpc-url <RPC_URL> \
  --network-passphrase "<NETWORK_PASSPHRASE>" \
  -- schema_version
```

Compare the result with the schema version the new WASM expects:

- **Equal** — no migration needed; proceed with the normal upgrade steps.
- **Older, and a migration exists** — supported path; the migration test for
  that fixture must pass before deploying.
- **Older, and no migration exists** — **unsupported**. Do not upgrade.
- **Newer than the new WASM expects** — **unsupported** (downgrade). Do not
  upgrade.

If the new WASM is invoked against an unsupported schema version, it must fail
safely: the entrypoint panics with a `SchemaVersionMismatch` error *before*
writing any storage, so existing records remain intact and readable by the
prior WASM. No partial migration state is persisted.

### Recovery plan for an unsupported upgrade

If an unsupported upgrade is attempted or detected:

1. **Stop.** Do not retry the upgrade or invoke state-mutating functions.
2. **Confirm the failure was safe.** Check that the `upgraded` event was *not*
   emitted and that `schema_version` still returns the prior value. Spot-check
   records with `verify_vaccination`.
3. **Roll back to the prior WASM.** Re-upload the previously deployed WASM
   (kept from the last tagged release) and invoke `upgrade` with its hash:

   ```bash
   soroban contract upload \
     --wasm <PRIOR_RELEASE_WASM> \
     --source <ADMIN_SECRET_KEY> \
     --rpc-url <RPC_URL> \
     --network-passphrase "<NETWORK_PASSPHRASE>"
   # Outputs: <PRIOR_WASM_HASH>

   soroban contract invoke \
     --id <CONTRACT_ID> \
     --source <ADMIN_SECRET_KEY> \
     --rpc-url <RPC_URL> \
     --network-passphrase "<NETWORK_PASSPHRASE>" \
     -- upgrade \
     --new_wasm_hash <PRIOR_WASM_HASH>
   ```

   Because the failed upgrade wrote no storage, the prior WASM reads the
   existing records unchanged.
4. **Re-verify.** Re-run the smoke tests from step 5 and confirm
   `schema_version` matches the prior release.
5. **Fix forward.** Add the missing migration (with a fixture-based test) or
   correct the schema version in the new WASM, then repeat the full procedure
   from step 1 on testnet before touching mainnet.

---

## Security checklist

- [ ] New WASM built from the audited, pinned commit (recorded in `docs/security-audit.md`)
- [ ] Built WASM SHA-256 hash matches the audited WASM hash
- [ ] Any post-audit code change has been re-audited and findings recorded
- [ ] PR approved by at least two maintainers (no self-approval by key holder)
- [ ] Built WASM hash matches the reviewed commit and the uploaded hash
- [ ] Storage migration (if any) documented and backward compatible
- [ ] Upgrade tested end-to-end on testnet
- [ ] Unauthorized upgrade attempt confirmed to fail (see `upgrade_tests.rs`)
- [ ] `schema_version` checked against the new WASM's expected version
- [ ] Migration test for the prior-state fixture passes (if schema changed)
- [ ] Prior release WASM hash recorded for rollback
- [ ] Admin key used from a hardware wallet or secure key management system
- [ ] `upgraded` event confirmed on-chain after execution
- [ ] Existing records spot-checked via `verify_vaccination` post-upgrade
- [ ] Last known-good WASM hash recorded for potential rollback
