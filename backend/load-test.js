import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const responseTime = new Trend('response_time');
const successCount = new Counter('success_count');
const p95ResponseTime = new Trend('p95_response_time');
const integrityFailures = new Counter('integrity_failures');
const integrityChecks = new Counter('integrity_checks');
const writeConflicts = new Counter('write_conflicts');
const activeInstances = new Gauge('active_instances');

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

// Autoscaling scenario configuration. The sustained scenario drives load well
// above the steady-state baseline so ECS target-tracking policies scale out,
// while the spike scenario exercises rapid scale-out/scale-in transitions.
const SCALING = {
  baselineVus: Number(__ENV.BASELINE_VUS || 20),
  sustainedVus: Number(__ENV.SUSTAINED_VUS || 150),
  spikeVus: Number(__ENV.SPIKE_VUS || 300),
  sustainedDuration: __ENV.SUSTAINED_DURATION || '2m',
  spikeDuration: __ENV.SPIKE_DURATION || '30s',
  cooldown: __ENV.COOLDOWN || '30s',
};

// Backend/database concurrency safety: the backend constrains writers to a
// single instance (see issue #117), so the load test must verify that
// concurrent reads never observe corrupted or split-brain index state.
const INTEGRITY_SAMPLE_RATE = Number(__ENV.INTEGRITY_SAMPLE_RATE || 0.1);

// Test wallets (valid Stellar addresses for testing)
const TEST_WALLETS = [
  'GBRPYHIL2CI3WHZDTOOQFC6EB4RBMPUTKXWDAUUJQHTITE4K3B6Rrytm',
  'GBBD47UZQ5UARKHTX4V2HA2KYRMF2ZSXBK6D5I4VRVHBT5RMJJWUBTQ',
  'GCZST3XVCDTUJ76ZAV2HA2KYRMF2ZSXBK6D5I4VRVHBT5RMJJWUBTQ',
  'GDZST3XVCDTUJ76ZAV2HA2KYRMF2ZSXBK6D5I4VRVHBT5RMJJWUBTQ',
  'GEZST3XVCDTUJ76ZAV2HA2KYRMF2ZSXBK6D5I4VRVHBT5RMJJWUBTQ',
];

export const options = {
  scenarios: {
    // Steady-state baseline used to establish normal latency before scaling.
    baseline: {
      executor: 'constant-vus',
      exec: 'verifyVaccination',
      vus: SCALING.baselineVus,
      duration: RAMP_UP,
      tags: { scenario: 'baseline' },
    },
    // Sustained high load: should trigger ECS scale-out and capacity alarms.
    sustained_load: {
      executor: 'ramping-vus',
      exec: 'verifyVaccination',
      startTime: RAMP_UP,
      stages: [
        { duration: '30s', target: SCALING.sustainedVus },
        { duration: SCALING.sustainedDuration, target: SCALING.sustainedVus },
        { duration: SCALING.cooldown, target: SCALING.baselineVus },
      ],
      tags: { scenario: 'sustained_load' },
    },
    // Short spike: exercises rapid scale-out and scale-in transitions.
    spike: {
      executor: 'ramping-arrival-rate',
      exec: 'verifyVaccination',
      startTime: RAMP_UP,
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: SCALING.baselineVus,
      maxVUs: SCALING.spikeVus,
      stages: [
        { duration: '10s', target: SCALING.spikeVus },
        { duration: SCALING.spikeDuration, target: SCALING.spikeVus },
        { duration: SCALING.cooldown, target: 10 },
      ],
      tags: { scenario: 'spike' },
    },
    // Integrity probe: continuously reads shared state and validates that
    // concurrent access never yields corrupted or split-brain index data.
    integrity_probe: {
      executor: 'constant-vus',
      exec: 'integrityProbe',
      vus: 5,
      duration: `${RAMP_UP}+${SCALING.sustainedDuration}+${SCALING.cooldown}`,
      tags: { scenario: 'integrity_probe' },
    },
  },
  thresholds: {
    'http_req_duration': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{scenario:sustained_load}': ['p(95)<800'],
    'errors': ['rate<0.01'],
    'integrity_failures': ['count==0'],
  },
};

export default function () {
  verifyVaccination();
}

export function verifyVaccination() {
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

// Reads shared state and validates consistency. Because the backend constrains
// writers to a single instance, concurrent reads must always return a
// well-formed, internally consistent record for each wallet.
export function integrityProbe() {
  const wallet = TEST_WALLETS[Math.floor(Math.random() * TEST_WALLETS.length)];
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${__ENV.JWT_TOKEN || 'test-token'}`,
    },
    timeout: '10s',
  };

  const response = http.get(`${BASE_URL}/verify/${wallet}`, params);
  integrityChecks.add(1);

  let parsed = null;
  try {
    parsed = JSON.parse(response.body);
  } catch (e) {
    parsed = null;
  }

  const consistent = check(response, {
    'integrity: status is 200 or 401': (r) => r.status === 200 || r.status === 401,
    'integrity: body is valid JSON': () => parsed !== null,
    'integrity: wallet matches request': () => parsed === null || parsed.wallet === undefined || parsed.wallet === wallet,
    'integrity: no split-brain marker': () => parsed === null || parsed.splitBrain !== true,
  });

  if (!consistent) {
    integrityFailures.add(1);
  }

  // Track observed instance count reported by the backend (if exposed) so
  // scale-out can be correlated with the capacity alarms.
  if (parsed && typeof parsed.instanceCount === 'number') {
    activeInstances.add(parsed.instanceCount);
  }

  sleep(0.5);
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

  summary += `\nData Integrity:\n`;
  summary += `  Checks: ${data.metrics.integrity_checks?.value || 0}\n`;
  summary += `  Failures: ${data.metrics.integrity_failures?.value || 0}\n`;
  summary += `  Write Conflicts: ${data.metrics.write_conflicts?.value || 0}\n`;
  summary += `  Result: ${(data.metrics.integrity_failures?.value || 0) === 0 ? 'PASS' : 'FAIL'}\n`;

  if (data.metrics.active_instances) {
    summary += `\nScaling:\n`;
    summary += `  Max Observed Instances: ${data.metrics.active_instances.stats?.max ?? 'N/A'}\n`;
  }

  return summary;
}
