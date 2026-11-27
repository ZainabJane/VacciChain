# VacciChain Backend

Node.js / Express API that bridges the frontend and the Soroban smart contract.

## Environment Variables

Copy `../.env.example` to `.env` and fill in the required values. The backend validates all variables at startup via Zod and exits with a clear error if anything is missing.

See the root [docs/configuration.md](../docs/configuration.md) for the full reference. The variables specific to this service are summarised below.

### Transaction Fees

All Soroban contract invocations use the fee settings from these two variables:

| Variable | Default | Description |
|---|---|---|
| `SOROBAN_FEE` | `100` | Base fee per operation in **stroops** (1 XLM = 10 000 000 stroops). The Stellar network minimum is 100. |
| `SOROBAN_TIP` | `0` | Inclusion tip in stroops added on top of the base fee. Increase during high-congestion periods to prioritise your transactions. |

**When to raise the fee**

During network congestion, transactions with the minimum fee (100 stroops) may be rejected with `txINSUFFICIENT_FEE`. The backend surfaces this as a clear error:

```
Transaction rejected: fee too low (current: 100 stroops).
Increase SOROBAN_FEE in your environment.
```

A value of `500`–`10000` stroops is sufficient for most congestion events. Monitor the [Stellar network fee stats](https://horizon-testnet.stellar.org/fee_stats) to pick an appropriate value.

## Running

```bash
npm install
npm run dev      # development (nodemon)
npm start        # production
npm test         # Jest test suite
```

## Event Index Persistence

The backend maintains an event index that tracks Soroban contract events. This section documents the production persistence strategy for that index. The full decision record is in [ADR-052: Event Index Persistence Strategy](../docs/adr/052-event-index-persistence.md).

### Load and Failure Analysis

Before scaling the backend task count, the current SQLite-based index was compared against a multi-writer database option (PostgreSQL).

| Concern | SQLite (current) | PostgreSQL (multi-writer) |
|---|---|---|
| Concurrent writers | Single writer at a time; `SQLITE_BUSY` under contention | Multiple concurrent writers via MVCC |
| Read concurrency | WAL mode allows concurrent readers with one writer | Full concurrent reads and writes |
| Durability | `synchronous=FULL` with WAL; fsync per commit | `synchronous=on`; WAL with configurable durability |
| Locking | Database-level write lock; busy-timeout retry | Row-level locks; no global write lock |
| Backup | Online backup API / file copy while quiesced | `pg_dump` / continuous archiving (WAL) |
| Failover | Single node; restore from backup | Streaming replication with automatic failover |
| Migration | Schema migrations applied in-process at startup | Versioned migrations run as a separate step |
| Operational cost | Zero external infrastructure | Managed service or self-hosted cluster |

**Findings:** SQLite comfortably meets current throughput (a single indexer task), but the single-writer constraint becomes a bottleneck once multiple backend tasks write to the index concurrently. The selected architecture keeps SQLite for single-task deployments and supports PostgreSQL as the multi-writer production target, selected via `DATABASE_URL`.

### Tested Behavior

The following behaviors are covered by the test suite (`npm test`):

- **Locking:** busy-timeout retry on `SQLITE_BUSY`; PostgreSQL row-level locking under concurrent writers.
- **Backup:** online backup produces a consistent snapshot while the index is live; restore is verified against a known event set.
- **Failover:** indexer resumes from the last committed cursor after a simulated primary failure.
- **Migration:** schema migrations apply cleanly from an empty database and from the previous schema version, and are idempotent on re-run.

See the ADR for the detailed benchmark numbers and the rationale behind the selected architecture.
