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

## References

- [autocannon](https://github.com/mcollina/autocannon) - HTTP benchmarking tool
- [Cargo bench](https://doc.rust-lang.org/cargo/commands/cargo-bench.html) - Rust benchmarking
