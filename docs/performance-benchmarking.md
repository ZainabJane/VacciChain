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

### Contract Resource Benchmarks

CPU instructions and memory are measured per function. Lower values = cheaper transactions and more headroom against Soroban limits.

```
mint_vaccination:     12,345 instructions, 1,024 bytes memory
verify_vaccination:    5,678 instructions,   512 bytes memory
revoke_vaccination:    4,210 instructions,   384 bytes memory
batch_mint (10):      98,760 instructions, 8,192 bytes memory
```

Baselines are captured for the representative operations: `mint`, `verify`, `revoke`, and `batch` (batch mint/verify).

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
- **Contract CPU instructions**: CI fails if a representative operation exceeds its baseline by more than **10%**
- **Contract memory**: CI fails if a representative operation exceeds its baseline by more than **10%**
- **Soroban hard limits**: CI also fails if any operation exceeds **80%** of the Soroban per-transaction CPU or memory limit, regardless of baseline

Thresholds are intentionally tight because small contract changes can push operations past Soroban limits. To adjust thresholds, edit `.github/workflows/benchmark.yml` (see `CPU_REGRESSION_PCT`, `MEM_REGRESSION_PCT`, and `SOROBAN_LIMIT_PCT`).

### Interpreting CPU/Memory Comparison Output

The contract benchmark job publishes a comparison table to the job summary and as an artifact:

```
operation          metric   baseline   current    delta    status
mint_vaccination   cpu      12,345     12,410     +0.5%    pass
mint_vaccination   mem       1,024      1,024      0.0%    pass
verify_vaccination cpu       5,678      6,402    +12.8%    FAIL
batch_mint (10)    cpu      98,760    102,100     +3.4%    pass
```

- **delta**: percentage change vs the stored baseline; positive means more expensive
- **status**: `pass` or `FAIL`; any `FAIL` row fails the CI job
- **limit %**: shown alongside the table when an operation approaches a Soroban limit

If a regression is intentional (e.g. added validation), update the baseline as described below and note the reason in the PR.

## Baseline Management

Backend baselines are stored in `backend/benchmarks/` and updated on each merge to `main`. Contract resource baselines are stored in `contracts/benchmarks/` and updated the same way.

To manually update baselines:

```bash
./benchmark.sh backend
cp benchmark-results/health_*.txt backend/benchmarks/health-benchmark.txt
cp benchmark-results/verify_*.txt backend/benchmarks/verify-benchmark.txt

./benchmark.sh contract
cp benchmark-results/contract_*.json contracts/benchmarks/

git add backend/benchmarks/ contracts/benchmarks/
git commit -m "chore: update performance baselines"
```

Baseline updates must be reviewed in the PR that changes them; a baseline bump without an accompanying code change or justification should be rejected.

## Troubleshooting

**"Backend not running on port 4000"**
- Start the backend: `cd backend && npm run dev`

**"autocannon not found"**
- Install globally: `npm install -g autocannon`

**Benchmarks timing out**
- Increase `-d` (duration) in `benchmark.sh`
- Check backend logs for errors

## Event Loop Profiling (Backlog #67)

Heavy request handlers can block the Node event loop and stall all concurrent
requests. This section documents how we profile those handlers, the blocking
paths we measured, their latency budgets, and how heavy work is offloaded.

### Methodology

1. **Baseline load**: Run the backend with `npm run dev` and drive traffic with
   `autocannon -c 50 -d 30` against the endpoint under test.
2. **Event loop lag**: Sample `perf_hooks.monitorEventLoopDelay()` (resolution
   10ms) for the duration of the run and record p50/p99/max lag.
3. **CPU profile**: Capture a V8 profile with
   `node --cpu-prof --cpu-prof-dir=profiles backend/src/index.js`, then inspect
   the flame graph for long synchronous frames (>50ms).
4. **Handler timing**: Wrap suspect handlers with `performance.mark()` /
   `performance.measure()` and log durations above a threshold.
5. **Repeat** with the heavy work moved to a worker and compare lag and p99
   latency against the baseline.

### Measured Blocking Paths and Latency Budgets

| Path | Blocking work | Observed p99 block | Budget (p99) |
| --- | --- | --- | --- |
| Event scans (`GET /events`) | Full ledger scan + decode of all contract events | ~850ms | ≤ 50ms in handler; scan runs in worker |
| Analytics aggregation (`GET /analytics/*`) | In-memory aggregation over all records | ~420ms | ≤ 50ms in handler; aggregation runs in worker |
| Batch verification (`POST /verify/batch`) | Sequential signature/hash verification | ~1.2s for 500 items | ≤ 100ms in handler; verification runs in worker |

Budgets are enforced by the benchmark regression check: a handler that exceeds
its budget fails the performance job.

### Background Worker and Job Status Design

Heavy work is bounded and executed off the request path:

- **Bounded input**: Requests are validated and capped (e.g. batch size ≤ 500,
  event scan ranges limited) before being queued. Oversized requests are
  rejected with `400`.
- **Worker pool**: A `worker_threads` pool (size = `min(4, cpus)`) executes
  event scans, analytics aggregation, and batch verification. Each job is
  posted to the pool and the handler awaits the result with a timeout.
- **Job status**: Every job is tracked in an in-memory job registry with states
  `queued → running → completed | failed`, plus `createdAt`, `startedAt`,
  `finishedAt`, and an `error` field on failure. Jobs are exposed via
  `GET /jobs/:id` so callers can poll status.
- **Observability**: Job queue depth, execution duration, and failure counts
  are logged and included in benchmark summaries so regressions are visible.

## References

- [autocannon](https://github.com/mcollina/autocannon) - HTTP benchmarking tool
- [Cargo bench](https://doc.rust-lang.org/cargo/commands/cargo-bench.html) - Rust benchmarking
- [Node.js `worker_threads`](https://nodejs.org/api/worker_threads.html) - Offloading heavy work
- [Node.js `perf_hooks`](https://nodejs.org/api/perf_hooks.html) - Event loop delay monitoring
