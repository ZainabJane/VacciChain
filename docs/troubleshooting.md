# Troubleshooting Guide

This guide documents common VacciChain setup and runtime errors, with exact symptoms, root causes, and solutions.

## Contract Deployment

### 1. `error: failed to parse manifest at `contracts/Cargo.toml`

- Symptom: `cargo build` or `cargo test` fails immediately with a manifest parse error.
- Cause: The Rust `Cargo.toml` file in `contracts/` contains a malformed dependency entry, missing quote, or invalid TOML syntax.
- Solution: Open `contracts/Cargo.toml`, fix the broken line, and rerun `cargo build`. Use `cargo check` to validate before deployment.

### 2. `Soroban RPC error: failed to connect to http://127.0.0.1:9000`

- Symptom: Contract deployment or local tests cannot connect to the Soroban RPC endpoint.
- Cause: The Soroban standalone node or emulator is not running, or it is bound to a different host/port than expected.
- Solution: Start the local RPC server and confirm its address. For example, run the designated Soroban node command, then verify `http://127.0.0.1:9000` is reachable.

### 3. `invalid key format` or `Secret key may not be a valid ED25519 secret key`

- Symptom: Deployment scripts or contract signing fail with a key format validation error.
- Cause: The private key or secret seed is malformed, missing the `S...` prefix, or wrapped in accidental whitespace/newlines.
- Solution: Confirm the key is a valid Stellar secret seed, remove extra whitespace, and place the correct key into the environment variable used by deployment scripts.

### 4. `error: failed to resolve patch for dependency`

- Symptom: The contract build fails during dependency resolution.
- Cause: A patch, workspace member, or local path reference in `contracts/Cargo.toml` is incorrect or missing.
- Solution: Verify all path and git dependencies in `contracts/Cargo.toml` exist and are accessible. Correct any broken relative paths before retrying.

## Backend Startup

### 5. `Error: Cannot find module 'dotenv'`

- Symptom: Backend startup fails before the API starts.
- Cause: Dependencies were not installed in `backend/` or `npm install`/`yarn install` was not run.
- Solution: From `/backend`, run `npm install` and then restart the backend with `npm start` or the standard startup script.

### 6. `Error: ENOENT: no such file or directory, open '.env'`

- Symptom: The backend reports a missing `.env` file when booting.
- Cause: Required runtime environment variables are not configured locally.
- Solution: Copy `env.example` to `.env` in the repo root and update the required backend keys and URLs. Ensure the backend service loads the correct `.env` file.

### 7. `Failed to initialize contract client: invalid network passphrase`

- Symptom: Backend API cannot connect to Stellar/Soroban when invoking contracts.
- Cause: The network passphrase is misconfigured for Testnet/Mainnet, or the wrong RPC network is selected.
- Solution: Confirm `STELLAR_NETWORK_PASSPHRASE` and RPC endpoint values in backend config match the target environment.

### 8. `Error: connect ECONNREFUSED 127.0.0.1:8000`

- Symptom: The backend cannot reach a dependent service such as analytics or Soroban RPC.
- Cause: A local service is not running or is bound to a different port.
- Solution: Start the missing dependency and verify the host:port values in the backend configuration.

## Frontend Build

### 9. `vite v... failed to load js file: /src/main.jsx`

- Symptom: Frontend build fails while resolving a module.
- Cause: A missing file, wrong import path, or inconsistent file extension under `frontend/src`.
- Solution: Confirm the file exists, correct the import paths, and rerun `npm run build` from `frontend/`.

### 10. `SyntaxError: Unexpected token '<'`

- Symptom: Browser or frontend build fails after loading a file as HTML instead of JS.
- Cause: The dev server is serving an HTML error page because the requested asset path is missing or the router is misconfigured.
- Solution: Check the build output path, verify `frontend/vite.config.js` settings, and ensure the asset URL matches the expected route.

### 11. `Error: Cannot find module 'react'`

- Symptom: Frontend fails on startup or during build with a missing dependency.
- Cause: Dependencies were not installed in the frontend package or `node_modules` is stale.
- Solution: From `/frontend`, run `npm install` and then restart the frontend development server.

## Docker and Compose Issues

### 12. `Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?`

- Symptom: Any Docker command fails immediately.
- Cause: Docker is not running or the current user lacks permission to access the Docker socket.
- Solution: Start Docker and confirm your user can access it. On Linux, use `sudo systemctl start docker` or add your user to the `docker` group.

### 13. `Error response from daemon: network vacci-chain_default not found`

- Symptom: `docker-compose up` fails while starting services.
- Cause: The Compose network was removed or not created due to a prior partial teardown.
- Solution: Recreate the compose network by running `docker compose up -d` from the repo root or `docker compose down && docker compose up -d`.

### 14. `Bind for 0.0.0.0:4000 failed: port is already allocated`

- Symptom: A container cannot start because its published port is in use.
- Cause: Another service is already listening on the same host port.
- Solution: Stop the conflicting service or change the published port in `docker-compose.yml`.

### 15. `ERROR: for backend  Cannot start service backend: failed to create endpoint`

- Symptom: Docker Compose reports a container endpoint or networking failure.
- Cause: Docker networking is corrupt, container names conflict, or stale resources remain.
- Solution: Run `docker compose down --volumes --remove-orphans`, then `docker compose up -d`.

### 16. `ERROR: Version in "./docker-compose.yml" is unsupported.`

- Symptom: Compose refuses to parse the YAML file.
- Cause: The installed Docker Compose version is older than the file version in the repo.
- Solution: Upgrade Docker Compose or use the Compose CLI shipped with Docker Desktop / Docker Engine.

## Terraform Backend and Environment Configuration

### 17. `Error: Failed to get existing workspaces: S3 bucket does not exist`

- Symptom: `terraform init` fails while configuring the S3 backend for an environment.
- Cause: The state bucket named in the backend configuration has not been bootstrapped for that environment, or the bucket name/region is wrong.
- Solution: Follow the bootstrap prerequisites for the target environment (create the state bucket, enable versioning, and apply the correct bucket policy), then confirm `bucket` and `region` in the environment's backend config match. Never point a staging workspace at the production state bucket.

### 18. `Error: error configuring S3 Backend: no valid credential sources for S3 Backend found`

- Symptom: `terraform init` or `terraform plan` fails with a credential error for the backend.
- Cause: The AWS credentials used for state access are missing, expired, or scoped to the wrong account.
- Solution: Authenticate with credentials that have access to the environment's state bucket. Do not commit state credentials or backend secrets; supply them via the environment's standard credential mechanism.

### 19. `Error: Backend configuration changed`

- Symptom: Terraform refuses to proceed because the backend block differs from the initialized state.
- Cause: The backend configuration (bucket, key, region, or workspace) was edited after `terraform init`.
- Solution: Re-run `terraform init -reconfigure` for the intended environment and verify the plan targets the correct account and region before applying.

### 20. `Error: Invalid account ID` or resources planned in the wrong account

- Symptom: A plan proposes changes to resources that belong to another environment.
- Cause: The AWS account, region, or environment-specific variables are not set explicitly and defaulted to production values.
- Solution: Set the account, region, and environment values explicitly for the target environment and confirm them in the plan output. A clean staging plan must not reference production state or account IDs.

## Network Egress for Scheduled Tasks and Polling

### 21. `Task timed out` or `connect ETIMEDOUT` from ECS tasks to Stellar RPC/Horizon

- Symptom: Scheduled tasks and polling workers fail to reach Stellar RPC or Horizon endpoints.
- Cause: The task's private subnets lack a NAT gateway/route to the internet, or the required egress destinations are not allowed by security groups or network ACLs.
- Solution: Confirm the documented egress destinations and DNS resolution are reachable from the task subnets, verify the NAT gateway and route tables, and check security group egress rules. Test connectivity from a task in the same subnet before deploying.

### 22. `getaddrinfo ENOTFOUND` or DNS resolution failures inside tasks

- Symptom: Tasks cannot resolve provider or internal API hostnames.
- Cause: The VPC DNS settings or resolver configuration do not resolve the required names from private subnets.
- Solution: Verify VPC DNS resolution and the documented DNS design for the environment, then retest name resolution from a running task.

### 23. Unexpected access to public or administrative endpoints

- Symptom: Tasks can reach endpoints they should not, or egress is broader than intended.
- Cause: Overly permissive egress rules or missing restrictions on administrative endpoints.
- Solution: Restrict egress to the documented required destinations only, remove broad `0.0.0.0/0` rules where not required, and confirm tasks cannot reach unnecessary public or administrative endpoints.

## ECS Autoscaling and Capacity

### 24. Service does not scale despite rising load

- Symptom: Task count stays at the minimum while queue depth or CPU/memory load increases.
- Cause: Scaling policies, metrics, cooldowns, or min/max counts are misconfigured for the service.
- Solution: Review the documented scaling metrics, minimum/maximum counts, and cooldowns for the service, and confirm the scaling target is attached to the correct ECS service.

### 25. `ThrottlingException` or scale-in/scale-out flapping

- Symptom: Scaling actions fail or the service oscillates between task counts.
- Cause: Cooldowns are too short, or scaling is not bounded by the documented cost limits.
- Solution: Adjust cooldowns and min/max bounds to the documented per-service values, and verify capacity alarms fire as expected during a load test.

### 26. Capacity alarm not firing

- Symptom: Load exceeds thresholds but no alert is raised.
- Cause: Alarm thresholds, dimensions, or notification targets are misconfigured.
- Solution: Confirm the alarm dimensions match the ECS service/cluster and that notifications are routed to the expected target.

## Persistent Storage and Multi-Task Write Safety

### 27. `SQLITE_BUSY: database is locked` or write failures under load

- Symptom: Backend tasks fail writes or report lock contention when more than one task is running.
- Cause: EFS-backed SQLite does not safely support concurrent writers across multiple tasks.
- Solution: Constrain backend writers to a single instance as documented, or use the tested concurrent-access architecture. Do not scale writer tasks beyond the documented limit.

### 28. Split-brain index state or inconsistent query results

- Symptom: Different tasks return conflicting index state, or data appears to diverge after scaling.
- Cause: Multiple tasks are writing to the same SQLite database over EFS, producing split-brain state.
- Solution: Reduce to a single writer task, verify the shared database is intact, and follow the documented recovery procedure before resuming scaled operation.

### 29. Data loss or corruption after task replacement

- Symptom: Records are missing or the database is corrupted after a task is replaced or restarted.
- Cause: Writes were in flight during task replacement, or the persistence layer was not configured for durability.
- Solution: Follow the documented failure and recovery procedure, verify data durability during task replacement, and confirm the deployment architecture matches the tested configuration.

## Quick Hints

- Always run `npm install` in both `backend/` and `frontend/` after pulling updates.
- Use `docker compose logs <service>` to inspect failing service output.
- Validate environment variables before startup: missing or malformed secrets are the most common source of failures.
- If deployment still fails, check the exact error message before applying a generic fix.
