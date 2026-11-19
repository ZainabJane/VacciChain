import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const responseTime = new Trend('response_time');
const successCount = new Counter('success_count');
const p95ResponseTime = new Trend('p95_response_time');

// Batch verification metrics
const batchLatency = new Trend('batch_latency');
const batchItemLatency = new Trend('batch_item_latency');
const batchPartialFailure = new Rate('batch_partial_failure');
const batchItemErrors = new Counter('batch_item_errors');
const batchItemsProcessed = new Counter('batch_items_processed');
const batchConcurrency = new Gauge('batch_concurrency');

// Configuration
const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const DURATION = __ENV.DURATION || '60s';
const VUS = __ENV.VUS || 100;
const RAMP_UP = __ENV.RAMP_UP || '10s';

// Bounded batch configuration (documented limits: batch size 1-100, parallelism 1-10)
const BATCH_SIZE = clampInt(__ENV.BATCH_SIZE, 20, 1, 100);
const BATCH_PARALLELISM = clampInt(__ENV.BATCH_PARALLELISM, 5, 1, 10);
const BATCH_ITERATIONS = clampInt(__ENV.BATCH_ITERATIONS, 10, 1, 1000);
const BATCH_PARTIAL_FAILURE_RATIO = clampFloat(__ENV.BATCH_PARTIAL_FAILURE_RATIO, 0.2, 0, 1);

function clampInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  const n = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, n));
}

function clampFloat(value, fallback, min, max) {
  const parsed = parseFloat(value);
  const n = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, n));
}

// Test wallets (valid Stellar addresses for testing)
const TEST_WALLETS = [
  'GBRPYHIL2CI3WHZDTOOQFC6EB4RBMPUTKXWDAUUJQHTITE4K3B6Rrytm',
  'GBBD47UZQ5UARKHTX4V2HA2KYRMF2ZSXBK6D5I4VRVHBT5RMJJWUBTQ',
  'GCZST3XVCDTUJ76ZAV2HA2KYRMF2ZSXBK6D5I4VRVHBT5RMJJWUBTQ',
  'GDZST3XVCDTUJ76ZAV2HA2KYRMF2ZSXBK6D5I4VRVHBT5RMJJWUBTQ',
  'GEZST3XVCDTUJ76ZAV2HA2KYRMF2ZSXBK6D5I4VRVHBT5RMJJWUBTQ',
];

export const options = {
  stages: [
    { duration: RAMP_UP, target: VUS },
    { duration: DURATION, target: VUS },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    'http_req_duration': ['p(95)<500', 'p(99)<1000'],
    'errors': ['rate<0.01'],
    // Batch latency must stay stable under bounded concurrency
    'batch_latency': ['p(95)<2000', 'p(99)<4000'],
    'batch_item_latency': ['p(95)<500', 'p(99)<1000'],
    // Partial failures must be reported per item, not as whole-batch errors
    'batch_partial_failure': ['rate<0.5'],
  },
  scenarios: {
    verify: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '10s', target: 0 },
      ],
      exec: 'verifyScenario',
    },
    batch_verification: {
      executor: 'constant-vus',
      vus: Math.min(VUS, BATCH_PARALLELISM * 2),
      duration: DURATION,
      exec: 'batchVerificationScenario',
      tags: { scenario: 'batch_verification' },
    },
  },
};

export function verifyScenario() {
  group('Verify Vaccination Endpoint', () => {
    const wallet = TEST_WALLETS[Math.floor(Math.random() * TEST_WALLETS.length)];
    const url = `${BASE_URL}/verify/${wallet}`;

    const params = {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${__ENV.JWT_TOKEN || 'test-token'}`,
      },
      timeout: '10s',
    };

    const response = http.get(url, params);

    // Record response time
    responseTime.add(response.timings.duration);
    p95ResponseTime.add(response.timings.duration);

    // Check response
    const success = check(response, {
      'status is 200 or 401': (r) => r.status === 200 || r.status === 401,
      'response time < 500ms': (r) => r.timings.duration < 500,
      'response has wallet field': (r) => r.body.includes('wallet'),
    });

    if (success) {
      successCount.add(1);
    } else {
      errorRate.add(1);
    }

    // Small delay between requests
    sleep(0.1);
  });
}

// Batch verification scenario: sends bounded batches and validates per-item results.
export function batchVerificationScenario() {
  group('Batch Verification Endpoint', () => {
    const url = `${BASE_URL}/verify/batch`;

    const params = {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${__ENV.JWT_TOKEN || 'test-token'}`,
      },
      timeout: '30s',
    };

    // Build a bounded batch; inject a deterministic subset of invalid wallets
    // so partial failures are exercised without exceeding the documented limits.
    const wallets = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const shouldFail = (i / BATCH_SIZE) < BATCH_PARTIAL_FAILURE_RATIO;
      wallets.push(shouldFail ? `INVALID_WALLET_${i}` : TEST_WALLETS[i % TEST_WALLETS.length]);
    }

    batchConcurrency.add(BATCH_PARALLELISM);

    for (let iteration = 0; iteration < BATCH_ITERATIONS; iteration++) {
      const payload = JSON.stringify({
        wallets,
        parallelism: BATCH_PARALLELISM,
      });

      const start = Date.now();
      const response = http.post(url, payload, params);
      const elapsed = Date.now() - start;

      batchLatency.add(elapsed);

      const ok = check(response, {
        'batch status is 200': (r) => r.status === 200,
        'batch response is JSON': (r) => {
          try {
            JSON.parse(r.body);
            return true;
          } catch (e) {
            return false;
          }
        },
      });

      if (!ok) {
        errorRate.add(1);
        continue;
      }

      let body;
      try {
        body = JSON.parse(response.body);
      } catch (e) {
        errorRate.add(1);
        continue;
      }

      const results = Array.isArray(body.results) ? body.results : [];
      const expectedCount = wallets.length;

      // Every submitted item must have a corresponding per-item result.
      const perItemComplete = check(results, {
        'per-item results returned for every wallet': (r) => r.length === expectedCount,
        'each result has wallet and status': (r) =>
          r.every((item) => item && typeof item.wallet === 'string' && typeof item.status === 'string'),
      });

      if (!perItemComplete) {
        errorRate.add(1);
      }

      let itemErrors = 0;
      for (const item of results) {
        batchItemsProcessed.add(1);
        if (item.latencyMs !== undefined) {
          batchItemLatency.add(item.latencyMs);
        }
        if (item.status !== 'verified' && item.status !== 'not_found') {
          itemErrors++;
          batchItemErrors.add(1);
        }
      }

      const hasPartialFailure = itemErrors > 0 && itemErrors < results.length;
      batchPartialFailure.add(hasPartialFailure ? 1 : 0);

      // A partial failure must not fail the whole batch.
      check(response, {
        'partial failures do not fail the whole batch': (r) => r.status === 200,
      });

      sleep(0.1);
    }
  });
}

export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'summary.json': JSON.stringify(data),
  };
}

function textSummary(data, options) {
  const indent = options.indent || '';
  const colors = options.enableColors || false;

  let summary = '\n=== Load Test Summary ===\n';
  summary += `Total Requests: ${data.metrics.http_reqs?.value || 0}\n`;
  summary += `Errors: ${data.metrics.errors?.value || 0}\n`;
  summary += `Success Rate: ${((1 - (data.metrics.errors?.value || 0) / (data.metrics.http_reqs?.value || 1)) * 100).toFixed(2)}%\n`;

  if (data.metrics.batch_latency) {
    const batch = data.metrics.batch_latency;
    summary += `\nBatch Verification:\n`;
    summary += `  Batch Size: ${BATCH_SIZE} (max 100)\n`;
    summary += `  Parallelism: ${BATCH_PARALLELISM} (max 10)\n`;
    summary += `  Items Processed: ${data.metrics.batch_items_processed?.value || 0}\n`;
    summary += `  Item Errors: ${data.metrics.batch_item_errors?.value || 0}\n`;
    summary += `  Partial Failure Rate: ${((data.metrics.batch_partial_failure?.value || 0) * 100).toFixed(2)}%\n`;
    summary += `  Batch P95: ${batch.stats?.p(95)?.toFixed(2) || 'N/A'}ms\n`;
    summary += `  Batch P99: ${batch.stats?.p(99)?.toFixed(2) || 'N/A'}ms\n`;
  }

  if (data.metrics.batch_item_latency) {
    const item = data.metrics.batch_item_latency;
    summary += `  Item P95: ${item.stats?.p(95)?.toFixed(2) || 'N/A'}ms\n`;
    summary += `  Item P99: ${item.stats?.p(99)?.toFixed(2) || 'N/A'}ms\n`;
  }

  if (data.metrics.http_req_duration) {
    const duration = data.metrics.http_req_duration;
    summary += `\nResponse Times:\n`;
    summary += `  Min: ${duration.stats?.min?.toFixed(2) || 'N/A'}ms\n`;
    summary += `  Max: ${duration.stats?.max?.toFixed(2) || 'N/A'}ms\n`;
    summary += `  Avg: ${duration.stats?.avg?.toFixed(2) || 'N/A'}ms\n`;
    summary += `  P95: ${duration.stats?.p(95)?.toFixed(2) || 'N/A'}ms\n`;
    summary += `  P99: ${duration.stats?.p(99)?.toFixed(2) || 'N/A'}ms\n`;
  }

  return summary;
}
