# Configuration Reference

All environment variables consumed by the VacciChain stack. Copy `.env.example` to `.env` and fill in the required values before starting any service.

```bash
cp .env.example .env
```

The backend validates its variables at startup via [Zod](https://zod.dev/). A missing or malformed required variable will print a clear error and exit with code 1 — no cryptic runtime failures.

---

## Stellar / Soroban

### `STELLAR_NETWORK`
- Required: yes for deployment and contract invocation tooling (`make deploy`, smoke tests); no for the backend runtime (defaults to `testnet`)
- Default: `testnet` (backend only)
- Allowed values: `testnet` | `mainnet`
- Description: Selects the Stellar network. Controls which network passphrase is used when signing transactions. Must match `HORIZON_URL`, `SOROBAN_RPC_URL`, and `STELLAR_NETWORK_PASSPHRASE`.
- Deployment rule: deployment commands must receive the network **explicitly** (e.g. `make deploy NETWORK=testnet` or `STELLAR_NETWORK=testnet make deploy`). There is no implicit fallback for deployment — omitting the network aborts the command before any transaction is built or signed.
- Example: `STELLAR_NETWORK=testnet`

#### Network-specific configuration validation

Before deploying or invoking the contract, the tooling validates that every network-scoped variable is consistent with the explicitly selected `STELLAR_NETWORK`. A mismatch aborts the command with a non-zero exit code and no transaction is submitted.

| `STELLAR_NETWORK` | Expected `HORIZON_URL` | Expected `SOROBAN_RPC_URL` | Expected `STELLAR_NETWORK_PASSPHRASE` |
|---|---|---|---|
| `testnet` | `https://horizon-testnet.stellar.org` | `https://soroban-testnet.stellar.org` | `Test SDF Network ; September 2015` |
| `mainnet` | `https://horizon.stellar.org` | `https://mainnet.sorobanrpc.com` | `Public Global Stellar Network ; September 2015` |

Validation performed by the deployment tooling:

1. `STELLAR_NETWORK` is set and is one of the allowed values (no default is applied).
2. `HORIZON_URL` and `SOROBAN_RPC_URL` are valid HTTPS URLs and match the selected network's expected host.
3. `STELLAR_NETWORK_PASSPHRASE` exactly matches the selected network's passphrase.
4. `VACCINATIONS_CONTRACT_ID` is a well-formed contract address (56 characters, starts with `C`) and is recorded against the selected network.
5. The deployed contract's on-chain network identity (the network passphrase the contract was deployed under) matches the selected network.
=======

### `HORIZON_URL`
- Required: yes
- Format: valid HTTPS URL
- Description: Horizon REST API endpoint for the chosen network.
- Example (testnet): `HORIZON_URL=https://horizon-testnet.stellar.org`
- Example (mainnet): `HORIZON_URL=https://horizon.stellar.org`

### `SOROBAN_RPC_URL`
- Required: yes
- Format: valid HTTPS URL
- Description: Soroban RPC endpoint used to simulate and submit contract transactions.
- Example (testnet): `SOROBAN_RPC_URL=https://soroban-testnet.stellar.org`
- Example (mainnet): `SOROBAN_RPC_URL=https://mainnet.sorobanrpc.com`

### `STELLAR_NETWORK_PASSPHRASE`
- Required: yes
- Format: non-empty string
- Description: Network passphrase included in every transaction envelope. Must exactly match the target network.
- Example (testnet): `STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015`
- Example (mainnet): `STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015`

---

## Contract

### `VACCINATIONS_CONTRACT_ID`
- Required: yes
- Format: 56-character Stellar contract address (starts with `C`)
- Description: Deployed address of the VacciChain Soroban contract. Obtained from `make deploy` in the `contracts/` directory. The ID is network-specific — a contract deployed on `testnet` does not exist on `mainnet`. The tooling rejects a contract ID that does not belong to the explicitly selected `STELLAR_NETWORK`.
- Example: `VACCINATIONS_CONTRACT_ID=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`

### `CONTRACT_ARTIFACT_HASH`
- Required: yes for deployment and smoke tests
- Format: 64-character lowercase hex string (SHA-256 of the compiled Wasm artifact)
- Description: Hash of the Wasm artifact that was deployed. `make deploy` records the hash of the uploaded artifact; smoke tests recompute the hash of the local build and compare it against this value to confirm the deployed contract matches the expected artifact. A mismatch fails the smoke test.
- Example: `CONTRACT_ARTIFACT_HASH=9f2c1e7b4a6d8c0e5f3b1a2d4c6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e`

---

## Backend auth

### `ADMIN_SECRET_KEY`
- Required: yes
- Format: 56-character Stellar secret key (starts with `S`)
- Description: Secret key of the account used to sign admin-level contract invocations (e.g. `add_issuer`, `revoke_issuer`). Keep this secret — never commit it.
- Example: `ADMIN_SECRET_KEY=SCZANGBA5RLMPI7JMTP2UOF4BIZX4ICOAP7MWKPKZUEZFEKNUMBMFTA`

### `ADMIN_PUBLIC_KEY`
- Required: yes
- Format: 56-character Stellar public key (starts with `G`)
- Description: Public key corresponding to `ADMIN_SECRET_KEY`. Used by the auth route to assign the `issuer` role when the admin wallet authenticates via SEP-10.
- Example: `ADMIN_PUBLIC_KEY=GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZWM9CQJKR3BSQNEWVZSR`

### `SEP10_SERVER_KEY`
- Required: yes
- Format: 56-character Stellar secret key (starts with `S`)
- Description: Secret key used to sign SEP-10 challenge transactions. Should be a dedicated key, separate from `ADMIN_SECRET_KEY`.
- Example: `SEP10_SERVER_KEY=SBPOVRCGGG65T7FQBV5KCBZ7HNZSZQZQZQZQZQZQZQZQZQZQZQZQZQZ`

### `ISSUER_SECRET_KEY`
- Required: yes
- Format: 56-character Stellar secret key (starts with `S`)
- Description: Secret key used to sign vaccination minting and revocation transactions submitted to the contract. Must correspond to an address authorized as an issuer on-chain.
- Example: `ISSUER_SECRET_KEY=SCZANGBA5RLMPI7JMTP2UOF4BIZX4ICOAP7MWKPKZUEZFEKNUMBMFTA`

### `JWT_SECRET`
- Required: yes
- Format: non-empty string; minimum 32 characters recommended
- Description: Secret used to sign and verify JWTs issued after SEP-10 authentication. Rotate this to invalidate all active sessions.
- Example: `JWT_SECRET=change-me-to-a-long-random-string-in-production`

---

## Backend server

### `PORT`
- Required: no
- Default: `4000`
- Format: positive integer
- Description: TCP port the Express backend listens on.
- Example: `PORT=4000`

---

## Rate limiting

### `RATE_LIMIT_SEP10`
- Required: no
- Default: `10`
- Format: positive integer
- Description: Maximum SEP-10 challenge requests per IP per minute. Protects the challenge endpoint from enumeration and DoS.
- Example: `RATE_LIMIT_SEP10=10`

### `RATE_LIMIT_VERIFY`
- Required: no
- Default: `60`
- Format: positive integer
- Description: Maximum public verification requests (`GET /verify/:wallet`) per IP per minute.
- Example: `RATE_LIMIT_VERIFY=60`

---

## Audit log

### `AUDIT_LOG_PATH`
- Required: no
- Default: `./audit.log` (relative to the backend working directory)
- Format: valid file path; the parent directory must be writable
- Description: Path to the append-only NDJSON audit log file. Each line is a JSON object with `timestamp`, `actor`, `action`, `target`, `result`, and `meta`. Never deleted or updated — only appended.
- Example: `AUDIT_LOG_PATH=/var/log/vaccichain/audit.log`

---

## Python analytics service

### `ANALYTICS_PORT`
- Required: no
- Default: `8001`
- Format: positive integer
- Description: TCP port the FastAPI analytics service listens on.
- Example: `ANALYTICS_PORT=8001`

### `BACKEND_URL`
- Required: no (set automatically by Docker Compose)
- Default: `http://backend:4000`
- Format: valid HTTP/HTTPS URL, no trailing slash
- Description: Base URL the analytics service uses to call the backend API. When running outside Docker, point this at the backend host.
- Example: `BACKEND_URL=http://localhost:4000`

---

## Anomaly detection

The Python analytics service runs a periodic job that flags issuers whose mint volume exceeds a configurable threshold and dispatches alerts via webhook.

### `ANOMALY_THRESHOLD`
- Required: no
- Default: `50`
- Format: positive integer
- Description: Number of mints above which an issuer is considered anomalous. The check compares each issuer's total lifetime mint count against this value. Lower values increase sensitivity (more alerts); higher values reduce noise. Start with the default and adjust based on your expected issuer volume.
- Tuning guidance:
  - Testnet / development: set low (e.g. `5`) to exercise the alert path without real data.
  - Production: baseline from 2–4 weeks of normal issuer activity, then set to ~2× the 99th-percentile daily volume per issuer.
- Example: `ANOMALY_THRESHOLD=50`

### `ANOMALY_SCHEDULE_MINUTES`
- Required: no
- Default: `15`
- Format: positive integer
- Description: How often (in minutes) the anomaly detection job runs. The scheduler uses APScheduler with an interval trigger. Shorter intervals catch anomalies faster but increase backend load; longer intervals reduce load but delay detection.
- Tuning guidance:
  - For near-real-time alerting use `5`.
  - For low-traffic deployments `30` or `60` is sufficient.
  - Do not set below `1` — the job itself takes a few seconds.
- Example: `ANOMALY_SCHEDULE_MINUTES=15`

---

## Webhook alerts

When an anomaly is detected the service POSTs a JSON payload to `ALERT_WEBHOOK_URL`. Three payload formats are supported, selected by `ALERT_WEBHOOK_TYPE`.

### `ALERT_WEBHOOK_URL`
- Required: no (alerts are silently skipped when unset)
- Format: valid HTTPS URL
- Description: Endpoint that receives alert POSTs. Must accept `application/json`. Leave empty to disable alerting.
- Slack example URL format: `https://hooks.slack.com/services/<TEAM_ID>/<CHANNEL_ID>/<TOKEN>` (obtain from your Slack app's Incoming Webhooks page)
- Example: `ALERT_WEBHOOK_URL=https://your-webhook-endpoint.example.com/alert`

### `ALERT_WEBHOOK_TYPE`
- Required: no
- Default: `slack`
- Allowed values: `slack` | `pagerduty` | `email`
- Description: Controls the JSON payload shape sent to `ALERT_WEBHOOK_URL`.
- Example: `ALERT_WEBHOOK_TYPE=slack`

### `PAGERDUTY_ROUTING_KEY`
- Required: when `ALERT_WEBHOOK_TYPE=pagerduty`
- Format: 32-character hex string
- Description: PagerDuty Events API v2 integration key. Obtain from your PagerDuty service's "Integrations" tab. Set `ALERT_WEBHOOK_URL` to `https://events.pagerduty.com/v2/enqueue`.
- Example: `PAGERDUTY_ROUTING_KEY=abc123def456abc123def456abc123de`

### `ALERT_EMAIL_TO`
- Required: when `ALERT_WEBHOOK_TYPE=email`
- Format: valid email address
- Description: Recipient address for email alerts. Your `ALERT_WEBHOOK_URL` must point to an HTTP-to-email relay (e.g. a custom endpoint or a service like Mailgun/SendGrid webhooks).
- Example: `ALERT_EMAIL_TO=ops@example.com`

---

### Alert payload formats

**Slack** (`ALERT_WEBHOOK_TYPE=slack`)

```json
{
  "text": "[VacciChain] Anomaly detected — issuer: GABC..., type: high_mint_volume, record_count: 73, timestamp: 2025-01-15T10:30:00+00:00"
}
```

**PagerDuty** (`ALERT_WEBHOOK_TYPE=pagerduty`)

```json
{
  "routing_key": "<PAGERDUTY_ROUTING_KEY>",
  "event_action": "trigger",
  "payload": {
    "summary": "[VacciChain] Anomaly detected — issuer: GABC..., type: high_mint_volume, record_count: 73, timestamp: 2025-01-15T10:30:00+00:00",
    "severity": "warning",
    "source": "vaccichain-analytics",
    "custom_details": {
      "issuer": "GABC...",
      "record_count": 73,
      "timestamp": "2025-01-15T10:30:00+00:00"
    }
  }
}
```

**Email relay** (`ALERT_WEBHOOK_TYPE=email`)

```json
{
  "to": "<ALERT_EMAIL_TO>",
  "subject": "VacciChain Anomaly Alert",
  "body": "[VacciChain] Anomaly detected — issuer: GABC..., type: high_mint_volume, record_count: 73, timestamp: 2025-01-15T10:30:00+00:00"
}
```

---

### Testing alerts in a non-production environment

1. **Use a low threshold** — set `ANOMALY_THRESHOLD=1` so any issuer with more than one mint triggers an alert.

2. **Use a short schedule** — set `ANOMALY_SCHEDULE_MINUTES=1` so you don't wait long.

3. **Slack**: create a free Slack app, add an Incoming Webhook, and paste the URL into `ALERT_WEBHOOK_URL`. Set `ALERT_WEBHOOK_TYPE=slack`.

4. **PagerDuty**: create a free developer account, add a service with the "Events API v2" integration, copy the routing key, and set `ALERT_WEBHOOK_URL=https://events.pagerduty.com/v2/enqueue`.

5. **Local HTTP sink**: run a simple listener (e.g. `python3 -m http.server 9999` or [webhook.site](https://webhook.site)) and point `ALERT_WEBHOOK_URL` at it to inspect raw payloads without sending real notifications.

6. **Trigger manually**: call `GET /analytics/anomalies` on the analytics service — the scheduler calls the same function, so the response confirms what would be flagged.

---

## Deployment and smoke-test requirements

Deployment tooling enforces the following before and after submitting a deployment:

1. **Explicit network** — `STELLAR_NETWORK` must be supplied on the command line or environment; there is no implicit default for deployment commands.
2. **Network-specific configuration** — `HORIZON_URL`, `SOROBAN_RPC_URL`, and `STELLAR_NETWORK_PASSPHRASE` must match the selected network (see the table above).
3. **Contract ID ownership** — the smoke test queries the selected network's RPC for the contract instance and confirms `VACCINATIONS_CONTRACT_ID` exists on that network. A contract ID that resolves on a different network fails the check.
4. **Artifact hash match** — the smoke test recomputes the SHA-256 of the locally built Wasm artifact and compares it with `CONTRACT_ARTIFACT_HASH` (and with the hash recorded at deploy time). Any mismatch fails the smoke test.

Run the smoke test after every deployment:

```bash
make smoke-test NETWORK=testnet
```

The smoke test exits non-zero if the contract ID is not found on the expected network or if the artifact hash does not match.

---

## Validation summary

| Variable | Required | Validated by | Rule |
|---|---|---|---|
| `STELLAR_NETWORK` | yes (deployment) / no (backend) | Zod (backend) + deploy tooling | enum: `testnet` \| `mainnet`; must be explicit for deployment |
| `HORIZON_URL` | yes | Zod (backend) | valid URL |
| `SOROBAN_RPC_URL` | yes | Zod (backend) | valid URL |
| `SOROBAN_RPC_MAX_RETRIES` | no | Zod (backend) | non-negative integer, default 3 |
| `STELLAR_NETWORK_PASSPHRASE` | yes | Zod (backend) | non-empty string |
| `VACCINATIONS_CONTRACT_ID` | yes | Zod (backend) + deploy tooling | non-empty string; 56-char contract address; must belong to selected network |
| `CONTRACT_ARTIFACT_HASH` | yes (deployment) | deploy tooling / smoke test | 64-char hex SHA-256 of deployed Wasm artifact |
| `ADMIN_SECRET_KEY` | yes | Zod (backend) | non-empty string |
| `ADMIN_PUBLIC_KEY` | yes | runtime | valid Stellar public key format |
| `SEP10_SERVER_KEY` | yes | Zod (backend) | non-empty string |
| `ISSUER_SECRET_KEY` | yes | runtime | valid Stellar secret key format |
| `JWT_SECRET` | yes | Zod (backend) | non-empty string |
| `PORT` | no | Zod (backend) | positive integer, default 4000 |
| `ALLOWED_ORIGINS` | no | Zod (backend) | comma-separated URLs, default `http://localhost:3000` |
| `SOROBAN_FEE` | no | Zod (backend) | positive integer (stroops), default 100 |
| `SOROBAN_TIP` | no | Zod (backend) | non-negative integer (stroops), default 0 |
| `BODY_LIMIT` | no | Zod (backend) | size string, default `10kb` |
| `EVENT_POLL_INTERVAL_MS` | no | Zod (backend) | positive integer (ms), default 15000 |
| `DATABASE_PATH` | no | Zod (backend) | file path, default `/data/vaccichain.db` |
| `RATE_LIMIT_SEP10` | no | runtime | parsed as integer, default 10 |
| `RATE_LIMIT_VERIFY` | no | runtime | parsed as integer, default 60 |
| `AUDIT_LOG_PATH` | no | runtime | writable path, default `./audit.log` |
| `ANALYTICS_PORT` | no | runtime | positive integer, default 8001 |
| `BACKEND_URL` | no | runtime | valid URL, default set by Compose |
| `LOG_LEVEL` | no | runtime | Python logging level, default `INFO` |
| `ANOMALY_THRESHOLD` | no | runtime | positive integer, default 50 |
| `ANOMALY_SCHEDULE_MINUTES` | no | runtime | positive integer, default 15 |
| `ALERT_WEBHOOK_URL` | no | runtime | valid HTTPS URL; alerts disabled if unset |
| `ALERT_WEBHOOK_TYPE` | no | runtime | enum: `slack` \| `pagerduty` \| `email`, default `slack` |
| `PAGERDUTY_ROUTING_KEY` | when type=pagerduty | runtime | 32-char hex string |
| `ALERT_EMAIL_TO` | when type=email | runtime | valid email address |
