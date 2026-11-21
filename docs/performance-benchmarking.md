# Performance Benchmarking

VacciChain includes automated performance benchmarking to detect regressions in API response time and contract gas usage.

## Overview

- **Backend API benchmarks** run on every push/PR using `autocannon`
- **Contract gas benchmarks** measure function execution costs
- **Regression detection** alerts if response time increases >20% vs baseline
- **Results stored** as CI artifacts for 30 days

## Running Benchmarks Locally

### Prerequisites

```bash
npm install -g autocannon
```

### Backend Benchmarks

```bash
# Start backend
cd backend && npm run dev

# In another terminal, run benchmarks
./benchmark.sh backend
```

Results are saved to `benchmark-results/` with timestamps.

### Contract Benchmarks

```bash
./benchmark.sh contract
```

Measures gas usage for each contract function.

### All Benchmarks

```bash
./benchmark.sh all
```

## CI Integration

Benchmarks run automatically on:
- Every push to `main`
- Every pull request to `main`

### Viewing Results

1. **GitHub Actions**: Go to the workflow run → "Performance Benchmarking" job
2. **Artifacts**: Download benchmark results from the "Artifacts" section
3. **Summary**: Check the job summary for regression alerts

## Interpreting Results

### Backend Benchmarks

```
Req/Sec: Requests per second (higher is better)
Latency: Response time in milliseconds (lower is better)
Throughput: Bytes per second
```

Example output:
```
Req/Sec: 1,234.5
Latency: 8.1ms
Throughput: 456 kB/s
```

### Contract Gas Benchmarks

Gas usage is measured per function. Lower gas = cheaper transactions.

```
mint_vaccination: 12,345 instructions
verify_vaccination: 5,678 instructions
```

### Batch Verification Resource Tests

Batch verification is bounded by an explicit per-invocation limit. The maximum
batch size is **`MAX_BATCH_SIZE`** (defined in the contract source). This limit
is documented in the contract and validated **before** any expensive storage
access, so over-limit requests are rejected cheaply without touching persistent
state.

The resource tests cover:

- **Maximum batch size**: a batch of exactly `MAX_BATCH_SIZE` entries is
  accepted and completes within the per-invocation resource budget.
- **Mixed results**: a batch containing a mix of valid and invalid entries
  returns per-entry results without aborting the whole batch.
- **Over-limit rejection**: a batch of `MAX_BATCH_SIZE + 1` entries is rejected
  before storage access, keeping resource usage bounded.

Run the batch verification resource tests with:

```bash
# From the contracts directory
cargo test batch_verification
```

To see instruction/resource counts for the batch tests:

```bash
cargo test batch_verification -- --nocapture
```

#### Interpreting Batch Results

- **Accepted at max size**: the maximum-size batch should pass; if it fails,
  either the limit or the resource budget needs review.
- **Mixed batch**: each entry should report its own result; a single invalid
  entry must not fail the entire batch.
- **Over-limit rejection**: an over-limit batch must be rejected up front. If
  it reaches storage access, the pre-validation guard is missing or misplaced.
- **Resource usage**: compare reported instruction counts against the baseline;
  a large increase at the maximum batch size signals a regression.

## Regression Thresholds

- **Response time**: Alert if >20% slower than baseline
- **Gas usage**: No automatic alert (informational only)

To adjust thresholds, edit `.github/workflows/benchmark.yml`.

## Baseline Management

Baselines are stored in `backend/benchmarks/` and updated on each merge to `main`.

To manually update baseline:

```bash
./benchmark.sh backend
cp benchmark-results/health_*.txt backend/benchmarks/health-benchmark.txt
cp benchmark-results/verify_*.txt backend/benchmarks/verify-benchmark.txt
git add backend/benchmarks/
git commit -m "chore: update performance baselines"
```

## Troubleshooting

**"Backend not running on port 4000"**
- Start the backend: `cd backend && npm run dev`

**"autocannon not found"**
- Install globally: `npm install -g autocannon`

**Benchmarks timing out**
- Increase `-d` (duration) in `benchmark.sh`
- Check backend logs for errors

## References

- [autocannon](https://github.com/mcollina/autocannon) - HTTP benchmarking tool
- [Cargo bench](https://doc.rust-lang.org/cargo/commands/cargo-bench.html) - Rust benchmarking
