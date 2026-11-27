# ADR-052: Production Persistence Strategy for the Event Index

## Status
Proposed

## Context
The event index is currently persisted in a single SQLite database file. Before scaling the backend task count (increasing the number of concurrent workers writing to the index), we must validate that this storage can meet deployment concurrency and durability requirements. This ADR documents a load and failure analysis comparing the current SQLite-based index with a multi-writer database option (PostgreSQL), and records the selected architecture along with its tested guarantees.

### Current storage: SQLite
- Single-file, embedded database accessed by all backend tasks on the same host.
- Write concurrency is serialized: SQLite allows one writer at a time. Concurrent writers either block (busy timeout) or fail with `SQLITE_BUSY`.
- WAL mode improves reader/writer concurrency but does not permit multiple concurrent writers.
- Durability depends on `synchronous` and WAL checkpoint settings; backups require the online backup API or a consistent file copy while quiesced.
- No native network failover; high availability requires external orchestration (shared storage, leader election, or replica promotion).

### Multi-writer option: PostgreSQL
- Client/server architecture supporting many concurrent writers via MVCC and row-level locking.
- Durability via WAL and configurable `synchronous_commit`; point-in-time recovery (PITR) and streaming replication for backups and failover.
- Requires operational overhead: a managed or self-hosted server, connection pooling, and schema migrations.

## Load and Failure Analysis

### Concurrency
- **SQLite:** With N backend tasks writing, effective write throughput is bounded by a single writer. Under sustained multi-task load, lock contention rises and `SQLITE_BUSY` errors appear once busy timeouts are exceeded. Read concurrency scales well in WAL mode.
- **PostgreSQL:** Write throughput scales across tasks through MVCC and row-level locks; contention is limited to conflicting rows. Connection pooling is required to keep connection counts bounded as task count grows.

### Locking
- **SQLite:** Database-level write lock. Long-running write transactions block all other writers. Risk of lock contention grows linearly with task count.
- **PostgreSQL:** Row-level and table-level locks with configurable isolation. Deadlocks are detected and reported; advisory locks are available for coordination.

### Backup
- **SQLite:** Online backup API or WAL-aware file copy; must account for `-wal`/`-shm` files. Restore is a file replacement.
- **PostgreSQL:** `pg_dump`/`pg_basebackup` plus continuous WAL archiving for PITR. Restore is a standard, well-tooled procedure.

### Failover
- **SQLite:** No built-in failover. Recovery relies on host-level redundancy and file integrity; a corrupted file requires restore from backup.
- **PostgreSQL:** Streaming replication with automated or manual promotion; managed offerings provide automated failover.

### Migration
- **SQLite:** Schema changes applied in place; migration tooling must handle single-writer constraints.
- **PostgreSQL:** Standard migration tooling with transactional DDL; migrating existing SQLite data requires an export/import step and validation.

## Decision
Adopt **PostgreSQL** as the production persistence backend for the event index, while retaining SQLite as the supported option for single-node and development deployments. The selected architecture must demonstrate tested guarantees for locking, backup, failover, and migration before backend task count is scaled up.

### Tested guarantees (required before scaling)
- **Locking:** Concurrent multi-task write load test confirms no lost updates and bounded contention under the target task count.
- **Backup:** Documented and rehearsed backup/restore procedure, including PITR, verified by a restore drill.
- **Failover:** Replica promotion procedure documented and exercised in a staging environment.
- **Migration:** SQLite-to-PostgreSQL migration path validated against a representative dataset with row-count and checksum verification.

## Consequences
- Positive: write concurrency scales with task count; mature backup, PITR, and failover tooling; transactional DDL simplifies migrations.
- Negative: added operational overhead (server, pooling, monitoring); increased deployment complexity versus an embedded file.
- Trade-off: SQLite remains for lightweight deployments, so the persistence layer must support both backends behind a common interface.

## Alternatives Considered
- **Keep SQLite only:** Rejected for scaled multi-task deployments due to single-writer serialization and lack of native failover.
- **Other multi-writer databases (e.g., MySQL):** Viable, but PostgreSQL was chosen for its MVCC behavior, PITR tooling, and alignment with existing operational experience.

## Implementation Notes
- Abstract persistence behind a storage interface so SQLite and PostgreSQL backends are interchangeable.
- Use connection pooling for PostgreSQL and configure `synchronous_commit` per durability requirements.
- Gate scaling of backend task count on completion of the locking, backup, failover, and migration tests above.

## References
- Backlog item #52
- Dependencies: #50, #51
- Deployment guide: `docs/deployment.md` (see "Event Index Persistence")
- Related ADRs: `docs/adr/`