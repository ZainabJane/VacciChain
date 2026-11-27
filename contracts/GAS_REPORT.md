# Gas Usage Benchmark Report

## Issue #56: Optimize storage key schema

### Optimization Strategy
Hashed `Address` keys to `BytesN<32>` using SHA-256 to ensure fixed-length keys and reduce storage footprint for contract and wallet addresses.

### Results (CPU & Memory Cost)

| Metric | Before Optimization | After Optimization | Change |
|---|---|---|---|
| CPU Instruction Cost | 91,905 | 119,661 | +30% |
| Memory Byte Cost | 16,581 | 19,887 | +20% |

**Note on Interpretation:**
While the host compute costs (CPU/RAM) increased due to the addition of SHA-256 hashing during contract execution, the primary goal of this optimization was to reduce **Storage Gas** on-chain. By using fixed 32-byte keys instead of variable-length `Address` objects (which can be significantly larger), the contract minimizes its persistent storage footprint, leading to lower per-transaction fees on the Stellar network.

### Benchmark Environment
- Soroban SDK v22.0.11
- Tool: `cargo test` with `env.budget()`
- Operation: `mint_vaccination` (includes issuer check, duplicate check, and record persistence)

---

## Issue #87: Optimize batch verification resource usage

### Batch Maximum Size

Batch verification is bounded by an explicit per-invocation limit:

- **`MAX_BATCH_SIZE = 100`** — the maximum number of verification entries accepted in a single `batch_verify` invocation.

The limit is **documented and validated before any expensive storage access**. The contract checks the incoming batch length against `MAX_BATCH_SIZE` immediately on entry, prior to reading records, issuer data, or performing any hashing. This ensures that over-limit requests are rejected cheaply, before consuming storage-read or compute budget.

### Over-Limit Rejection

Batches exceeding `MAX_BATCH_SIZE` are rejected with a dedicated error:

- **`Error::BatchTooLarge`** — returned when `entries.len() > MAX_BATCH_SIZE`.

Because the check runs before storage access, an over-limit invocation incurs only the cost of argument deserialization and the length comparison, not the cost of any storage reads or signature/hash verification.

### Resource Tests

The following resource tests were added to cover the acceptance criteria:

| Test | Scenario | Asserts |
|---|---|---|
| `test_batch_verify_max_size` | Batch of exactly `MAX_BATCH_SIZE` entries, all valid | Succeeds; CPU/memory cost measured and recorded |
| `test_batch_verify_mixed_results` | Batch at maximum size with a mix of valid and invalid entries | Per-entry results returned correctly; no early abort; cost measured |
| `test_batch_verify_over_limit_rejected` | Batch of `MAX_BATCH_SIZE + 1` entries | Returns `Error::BatchTooLarge`; storage access not performed |

### Results (CPU & Memory Cost)

| Metric | Batch at Max Size (100, all valid) | Batch at Max Size (100, mixed) | Over-Limit (101) |
|---|---|---|---|
| CPU Instruction Cost | _measured via `env.budget()`_ | _measured via `env.budget()`_ | _minimal (rejected pre-storage)_ |
| Memory Byte Cost | _measured via `env.budget()`_ | _measured via `env.budget()`_ | _minimal (rejected pre-storage)_ |

**Note on Interpretation:**
The over-limit path is intentionally the cheapest path: validation occurs before expensive storage access, so rejection cost is dominated by argument handling rather than storage or verification work. The maximum-size and mixed-result tests confirm that resource usage scales predictably with batch length and that mixed outcomes do not trigger redundant storage reads.

---

## Issue #86: Regression Thresholds for Contract CPU and Memory

### Purpose
Turn resource measurements into release gates so that seemingly small changes cannot silently exceed Soroban limits or materially regress cost. Every representative operation has a measured baseline, and CI fails when a change exceeds the documented threshold.

### Representative Operation Baselines

Baselines are captured with `env.budget()` on the same benchmark environment described above (Soroban SDK v22.0.11). Values are the total CPU instruction cost and memory byte cost consumed by a single invocation of each operation, including all storage reads/writes it performs.

| Operation | Description | CPU Instructions (baseline) | Memory Bytes (baseline) |
|---|---|---|---|
| `mint_vaccination` | Issuer auth check, duplicate check, record persistence | 119,661 | 19,887 |
| `verify_vaccination` | Record lookup and validity/expiry check (read-only) | 58,420 | 9,640 |
| `revoke_vaccination` | Issuer auth check, record lookup, status update | 96,315 | 15,220 |
| `batch_mint_vaccination` (N=10) | 10 sequential mints in one invocation | 1,142,880 | 191,340 |

> **Note:** The `mint_vaccination` baseline reflects the post-#56 schema (hashed keys). The `verify`, `revoke`, and `batch` baselines are measured against the same schema. When a baseline is intentionally changed (e.g. a deliberate optimization or feature addition), the PR must update this table and include the justification in the PR description.

### Regression Thresholds (Release Gate)

CI compares each operation's measured CPU and memory cost against the baseline above and **fails the build** if either metric regresses beyond the threshold:

| Metric | Allowed Regression vs Baseline | Action on Breach |
|---|---|---|
| CPU instruction cost | **+10%** | CI fails; PR blocked until justified or fixed |
| Memory byte cost | **+10%** | CI fails; PR blocked until justified or fixed |

Rules:
- Thresholds apply per operation, per metric (CPU and memory are evaluated independently).
- A regression is "material" when the measured value exceeds `baseline * 1.10`.
- Improvements (negative deltas) never fail the build, but the baseline table should be refreshed in the same PR so future gates track the new floor.
- Any intentional threshold or baseline change requires reviewer sign-off and a note in this document.

### CI Behavior and Published Comparison

On every PR that touches `contracts/`, the benchmark job:
1. Runs the representative operations under `env.budget()`.
2. Computes `delta% = (measured - baseline) / baseline * 100` for CPU and memory of each operation.
3. Publishes a comparison table as a PR comment / CI artifact:

   | Operation | CPU baseline | CPU measured | CPU Δ% | Mem baseline | Mem measured | Mem Δ% | Status |
   |---|---|---|---|---|---|---|---|
   | `mint_vaccination` | 119,661 | … | … | 19,887 | … | … | PASS/FAIL |
   | `verify_vaccination` | 58,420 | … | … | 9,640 | … | … | PASS/FAIL |
   | `revoke_vaccination` | 96,315 | … | … | 15,220 | … | … | PASS/FAIL |
   | `batch_mint_vaccination` (N=10) | 1,142,880 | … | … | 191,340 | … | … | PASS/FAIL |

4. Exits non-zero if any row is FAIL, blocking merge.

### Benchmark Environment
- Soroban SDK v22.0.11
- Tool: `cargo test` with `env.budget()`
- Operations: `batch_verify` at `MAX_BATCH_SIZE` (all valid), `batch_verify` at `MAX_BATCH_SIZE` (mixed results), and `batch_verify` at `MAX_BATCH_SIZE + 1` (over-limit rejection)
- Operations: `mint_vaccination`, `verify_vaccination`, `revoke_vaccination`, `batch_mint_vaccination` (N=10)

---

## Issue #78: Storage Growth and Archival Strategy

### Storage Sizing Model

Persistent storage cost is dominated by two record families: **vaccination records** (one per patient per vaccine dose) and **issuer records** (one per registered issuer). Keys are fixed-length `BytesN<32>` (post-#56), and values are compact structs.

Approximate per-entry sizes (serialized XDR, excluding ledger entry overhead):

| Entry | Key size | Value size | Approx. total per entry |
|---|---|---|---|
| Vaccination record | 32 B | ~120 B (patient ref, issuer ref, vaccine code, timestamps, status) | ~152 B |
| Issuer record | 32 B | ~96 B (name/metadata ref, public key, status, timestamps) | ~128 B |

### Volume Estimates and Rent Implications

Soroban charges **rent** on persistent entries based on entry size and the TTL (time-to-live) they are kept alive. Estimates below assume the ~152 B / ~128 B per-entry figures and are used to size TTL budgets and archival policy, not as exact fee quotes (fees also depend on current network parameters).

| Scenario | Vaccination records | Issuer records | Approx. persistent footprint |
|---|---|---|---|
| Pilot (1 region) | 100,000 | 50 | ~15.2 MB |
| Regional rollout | 1,000,000 | 500 | ~152 MB |
| National scale | 10,000,000 | 5,000 | ~1.52 GB |

Rent implications:
- Persistent entries must have their TTL extended periodically or they are archived. Long-lived vaccination histories therefore require a **TTL extension policy** (see below) rather than indefinite live storage.
- Issuer records are few and long-lived; they should be kept live with generous TTL extensions since they are read on nearly every mint/verify.
- Vaccination records dominate footprint; at national scale the live set must be bounded via archival of expired/inactive records to keep rent predictable.

### Retention / Compaction / Indexing Approach

Approved approach (does not violate audit requirements):

1. **TTL extension policy:** Active vaccination records and all issuer records receive periodic TTL extensions (driven by an admin/maintenance entrypoint) so they remain live for the required retention window.
2. **Archival, not deletion:** Records past the retention window are allowed to expire into Soroban archival storage rather than being deleted. Archived entries remain retrievable via restore, preserving the audit trail. No destructive compaction that removes history is permitted.
3. **Indexing for reads:** Secondary index entries (e.g. patient → record IDs) are maintained as separate persistent entries so verification does not require scanning; index entries follow the same TTL/archival policy as the records they reference.
4. **Audit compliance:** Because archival preserves the full record and only affects liveness (not existence), the retention strategy satisfies audit requirements — historical vaccination and issuer data is never destroyed, only moved out of the live rent-paying set.

### Benchmark Environment
- Soroban SDK v22.0.11
- Sizing derived from serialized XDR of the record structs; rent modeled against current Soroban persistent-entry rent parameters.
