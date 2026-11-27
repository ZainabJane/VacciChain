# VacciChain Uptime Monitoring

Prometheus + Blackbox Exporter + Alertmanager + Grafana stack for health checks and alerting.

## Services monitored

| Service | Endpoint | Check |
|---|---|---|
| Backend (Node.js) | `http://backend:4000/health` | HTTP 200 + `"status":"ok"` |
| Analytics (FastAPI) | `http://python-service:8001/health` | HTTP 200 + `"status":"ok"` |
| Frontend (nginx) | `http://frontend:80` | HTTP 200 |
| Staging backend | `$STAGING_BACKEND_URL/health` | HTTP 200 + `"status":"ok"` |

## Service-level objectives (SLOs)

Beyond basic availability, the stack tracks the following service-level indicators (SLIs) and objectives. Each objective has an owner, a severity for its alert, and a runbook link.

| SLI | Objective (SLO) | Alert | Severity | Owner | Runbook |
|---|---|---|---|---|---|
| Availability | 99.9% of probes succeed over 30d | `ServiceDown` | critical | Platform On-call | [runbooks/service-down.md](runbooks/service-down.md) |
| Latency (p95) | p95 response < 500ms over 5m | `ServiceSlowResponse` | warning | Backend Team | [runbooks/latency.md](runbooks/latency.md) |
| Error rate | < 1% of requests return 5xx over 5m | `HighErrorRate` | critical | Backend Team | [runbooks/error-rate.md](runbooks/error-rate.md) |
| Poller lag | Poller lag < 60s over 10m | `PollerLagHigh` | warning | Data Team | [runbooks/poller-lag.md](runbooks/poller-lag.md) |
| Data freshness | Latest record < 5m old | `StaleData` | warning | Data Team | [runbooks/data-freshness.md](runbooks/data-freshness.md) |

### Alert rules

| Alert | Condition | Severity | Fires after |
|---|---|---|---|
| `ServiceDown` | `probe_success == 0` | critical | 2 minutes |
| `ServiceSlowResponse` | p95 response > 500ms | warning | 5 minutes |
| `ServiceDegraded` | HTTP 503 | warning | 2 minutes |
| `HighErrorRate` | 5xx rate > 1% | critical | 5 minutes |
| `PollerLagHigh` | poller lag > 60s | warning | 10 minutes |
| `StaleData` | data age > 5m | warning | 5 minutes |

Every alert must carry `owner`, `severity`, and `runbook_url` labels (see `alertmanager.yml` routing and `prometheus/alerts.yml`). Alerts missing any of these labels fail CI validation.

## Failure-injection testing (non-production)

Alerts are validated with controlled failure injection in a non-production environment before being promoted. Never run these against production.

```bash
# Run the full failure-injection suite against the staging stack
./monitoring/scripts/failure-injection.sh --env staging --scenario all

# Run a single scenario (e.g. latency)
./monitoring/scripts/failure-injection.sh --env staging --scenario latency
```

Available scenarios: `down`, `latency`, `error-rate`, `poller-lag`, `stale-data`. Each scenario injects the fault, waits for the expected alert to fire in Alertmanager, asserts the alert labels (`owner`, `severity`, `runbook_url`), then clears the fault and confirms recovery. Results are written to `monitoring/reports/failure-injection-<timestamp>.json`.

## Notification channels

Configure via environment variables before starting:

```bash
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
export PAGERDUTY_ROUTING_KEY=...
export ALERT_EMAIL=ops@example.com
export SMTP_HOST=smtp.example.com
export SMTP_USER=...
export SMTP_PASSWORD=...
```

## Run

```bash
# Start monitoring stack alongside the main app
docker compose -f docker-compose.yml -f monitoring/docker-compose.monitoring.yml up

# Or standalone
cd monitoring
docker compose -f docker-compose.monitoring.yml up
```

## Dashboards

- Grafana: http://localhost:3001 (admin / `$GRAFANA_PASSWORD`)
- Prometheus: http://localhost:9090
- Alertmanager: http://localhost:9093
- Blackbox Exporter: http://localhost:9115
