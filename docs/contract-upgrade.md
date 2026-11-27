# Contract Upgrade Procedure

VacciChain uses Soroban's native WASM upgrade mechanism. The contract's storage and address remain unchanged — only the executable code is replaced.

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

- [ ] New WASM built from a tagged, reviewed commit
- [ ] Upgrade tested end-to-end on testnet
- [ ] `schema_version` checked against the new WASM's expected version
- [ ] Migration test for the prior-state fixture passes (if schema changed)
- [ ] Prior release WASM hash recorded for rollback
- [ ] Admin key used from a hardware wallet or secure key management system
- [ ] `upgraded` event confirmed on-chain after execution
- [ ] Existing records spot-checked via `verify_vaccination` post-upgrade
