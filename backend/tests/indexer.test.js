const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  initDb,
  upsertEvents,
  queryEvents,
  getLatestLedger,
  getCheckpoint,
  setCheckpoint,
  withTransaction,
  getSchemaVersion,
  runMigrations,
} = require('../src/indexer/db');
const {
  parseEvent,
  stopPoller,
  pollOnce,
  backoffDelay,
  MAX_BACKOFF_MS,
} = require('../src/indexer/poller');
const { vaccinationRecordFactory } = require('./factories');


const tmpDb = path.join(os.tmpdir(), `vaccichain-test-${Date.now()}.db`);

beforeAll(async () => {
  await initDb(tmpDb);
});

afterAll(() => {
  stopPoller();
  if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
});

describe('db — upsertEvents / queryEvents', () => {
  const record = vaccinationRecordFactory({ vaccine_name: 'COVID-19', issuer_address: 'GISSUER1' });
  const sample = [
    {
      id: 'evt-001',
      event_type: 'VaccinationMinted',
      ledger: 100,
      timestamp: 1700000000,
      contract_id: 'CABC',
      payload: { vaccine_name: record.vaccine_name, issuer: record.issuer_address },
    },
    {
      id: 'evt-002',
      event_type: 'IssuerAdded',
      ledger: 101,
      timestamp: 1700000060,
      contract_id: 'CABC',
      payload: { issuer: 'GISSUER2' },
    },
  ];


  it('stores events and returns them', () => {
    upsertEvents(sample);
    const results = queryEvents();
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('deduplicates on re-insert', () => {
    upsertEvents(sample); // insert same events again
    const results = queryEvents({ event_type: 'VaccinationMinted' });
    const ids = results.map((e) => e.id);
    expect(ids.filter((id) => id === 'evt-001').length).toBe(1);
  });

  it('filters by event_type', () => {
    const minted = queryEvents({ event_type: 'VaccinationMinted' });
    expect(minted.every((e) => e.event_type === 'VaccinationMinted')).toBe(true);

    const added = queryEvents({ event_type: 'IssuerAdded' });
    expect(added.every((e) => e.event_type === 'IssuerAdded')).toBe(true);
  });

  it('deserialises payload back to object', () => {
    const [evt] = queryEvents({ event_type: 'VaccinationMinted' });
    expect(typeof evt.payload).toBe('object');
    expect(evt.payload.vaccine_name).toBe(record.vaccine_name);

  });

  it('getLatestLedger returns highest ledger', () => {
    expect(getLatestLedger()).toBeGreaterThanOrEqual(101);
  });

  it('respects limit and offset', () => {
    const first = queryEvents({ limit: 1, offset: 0 });
    const second = queryEvents({ limit: 1, offset: 1 });
    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    expect(first[0].id).not.toBe(second[0].id);
  });
});

describe('poller — parseEvent', () => {
  it('maps minted topic to VaccinationMinted', () => {
    const raw = {
      id: 'raw-001',
      topic: [{ value: { toString: () => 'minted' } }],
      ledger: 200,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      contractId: 'CABC',
      value: { vaccine_name: 'Flu' },
    };
    const parsed = parseEvent(raw);
    expect(parsed).not.toBeNull();
    expect(parsed.event_type).toBe('VaccinationMinted');
    expect(parsed.ledger).toBe(200);
  });

  it('maps iss_add topic to IssuerAdded', () => {
    const raw = {
      id: 'raw-002',
      topic: [{ value: { toString: () => 'iss_add' } }],
      ledger: 201,
      ledgerClosedAt: '2024-01-01T00:01:00Z',
      contractId: 'CABC',
      value: {},
    };
    expect(parseEvent(raw).event_type).toBe('IssuerAdded');
  });

  it('maps iss_rev topic to IssuerRevoked', () => {
    const raw = {
      id: 'raw-003',
      topic: [{ value: { toString: () => 'iss_rev' } }],
      ledger: 202,
      ledgerClosedAt: '2024-01-01T00:02:00Z',
      contractId: 'CABC',
      value: {},
    };
    expect(parseEvent(raw).event_type).toBe('IssuerRevoked');
  });

  it('returns null for unknown topic', () => {
    const raw = {
      id: 'raw-004',
      topic: [{ value: { toString: () => 'unknown_event' } }],
      ledger: 203,
      ledgerClosedAt: '2024-01-01T00:03:00Z',
      contractId: 'CABC',
      value: {},
    };
    expect(parseEvent(raw)).toBeNull();
  });

  it('returns null when topic is missing', () => {
    expect(parseEvent({ id: 'raw-005', ledger: 204 })).toBeNull();
  });
});

describe('poller — resilience', () => {
  const rawEvent = (id, ledger, topic = 'minted') => ({
    id,
    topic: [{ value: { toString: () => topic } }],
    ledger,
    ledgerClosedAt: '2024-01-01T00:00:00Z',
    contractId: 'CABC',
    value: { vaccine_name: 'Flu' },
  });

  it('uses bounded exponential backoff', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => backoffDelay(attempt));
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
    delays.forEach((d) => {
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    });
  });

  it('retries repeated RPC failures and does not advance the checkpoint', async () => {
    const start = getCheckpoint();
    let calls = 0;
    const fetchEvents = jest.fn(async () => {
      calls += 1;
      throw new Error('transient RPC failure');
    });

    const result = await pollOnce({ fetchEvents, maxRetries: 3, baseDelayMs: 1 });

    expect(fetchEvents).toHaveBeenCalledTimes(3);
    expect(calls).toBe(3);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(getCheckpoint()).toBe(start);
  });

  it('succeeds after transient failures and advances the checkpoint', async () => {
    const start = getCheckpoint();
    let calls = 0;
    const fetchEvents = jest.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient RPC failure');
      return [rawEvent('evt-retry-1', start + 1)];
    });

    const result = await pollOnce({ fetchEvents, maxRetries: 5, baseDelayMs: 1 });

    expect(result.ok).toBe(true);
    expect(fetchEvents).toHaveBeenCalledTimes(3);
    expect(getCheckpoint()).toBe(start + 1);
  });

  it('deduplicates duplicate event delivery', async () => {
    const start = getCheckpoint();
    const events = [rawEvent('evt-dup-1', start + 1), rawEvent('evt-dup-1', start + 1)];
    const fetchEvents = jest.fn(async () => events);

    const result = await pollOnce({ fetchEvents, maxRetries: 1, baseDelayMs: 1 });

    expect(result.ok).toBe(true);
    const stored = queryEvents().filter((e) => e.id === 'evt-dup-1');
    expect(stored.length).toBe(1);
    expect(getCheckpoint()).toBe(start + 1);
  });

  it('quarantines malformed payloads without advancing the checkpoint', async () => {
    const start = getCheckpoint();
    const malformed = {
      id: 'evt-bad-1',
      topic: [{ value: { toString: () => 'minted' } }],
      ledger: start + 1,
      ledgerClosedAt: 'not-a-date',
      contractId: 'CABC',
      value: null,
    };
    const fetchEvents = jest.fn(async () => [malformed]);

    const result = await pollOnce({ fetchEvents, maxRetries: 1, baseDelayMs: 1 });

    expect(result.ok).toBe(false);
    expect(result.quarantined).toBeGreaterThanOrEqual(1);
    expect(getCheckpoint()).toBe(start);
    expect(queryEvents().filter((e) => e.id === 'evt-bad-1').length).toBe(0);
  });

  it('recovers the checkpoint from the database after restart', async () => {
    const start = getCheckpoint();
    const fetchEvents = jest.fn(async () => [rawEvent('evt-restart-1', start + 1)]);
    await pollOnce({ fetchEvents, maxRetries: 1, baseDelayMs: 1 });
    expect(getCheckpoint()).toBe(start + 1);

    // Simulate a restart: a fresh poller must resume from the persisted checkpoint.
    const resumed = jest.fn(async (fromLedger) => {
      expect(fromLedger).toBe(start + 1);
      return [];
    });
    const result = await pollOnce({ fetchEvents: resumed, maxRetries: 1, baseDelayMs: 1 });
    expect(result.ok).toBe(true);
    expect(resumed).toHaveBeenCalledTimes(1);
  });
});

describe('db — transactional writes', () => {
  it('rolls back all writes on partial failure', () => {
    const before = getLatestLedger();
    expect(() =>
      withTransaction(() => {
        upsertEvents([
          {
            id: 'evt-tx-rollback',
            event_type: 'IssuerAdded',
            ledger: before + 50,
            timestamp: 1700000000,
            contract_id: 'CABC',
            payload: { issuer: 'GROLLBACK' },
          },
        ]);
        setCheckpoint(before + 50);
        throw new Error('partial failure');
      })
    ).toThrow('partial failure');

    expect(queryEvents().filter((e) => e.id === 'evt-tx-rollback').length).toBe(0);
    expect(getCheckpoint()).toBeLessThan(before + 50);
  });

  it('does not lose checkpoints under concurrent updates', async () => {
    const start = getCheckpoint();
    const updates = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() =>
        withTransaction(() => {
          setCheckpoint(start + i + 1);
        })
      )
    );
    await Promise.all(updates);
    expect(getCheckpoint()).toBeGreaterThanOrEqual(start + 1);
    expect(getCheckpoint()).toBeLessThanOrEqual(start + 10);
  });

  it('does not leave partially written records under concurrency', async () => {
    const writes = Array.from({ length: 5 }, (_, i) =>
      Promise.resolve().then(() =>
        withTransaction(() => {
          upsertEvents([
            {
              id: `evt-concurrent-${i}`,
              event_type: 'VaccinationMinted',
              ledger: 500 + i,
              timestamp: 1700000000,
              contract_id: 'CABC',
              payload: { vaccine_name: 'Flu' },
            },
          ]);
        })
      )
    );
    await Promise.all(writes);
    const stored = queryEvents().filter((e) => e.id.startsWith('evt-concurrent-'));
    expect(stored.length).toBe(5);
  });
});

describe('db — schema migrations', () => {
  it('records a schema version on a clean database', async () => {
    const cleanDb = path.join(os.tmpdir(), `vaccichain-migrate-clean-${Date.now()}.db`);
    try {
      await initDb(cleanDb);
      expect(getSchemaVersion()).toBeGreaterThanOrEqual(1);
    } finally {
      if (fs.existsSync(cleanDb)) fs.unlinkSync(cleanDb);
    }
  });

  it('upgrades from the current deployed schema safely', async () => {
    const upgradeDb = path.join(os.tmpdir(), `vaccichain-migrate-upgrade-${Date.now()}.db`);
    try {
      await initDb(upgradeDb);
      const versionBefore = getSchemaVersion();
      upsertEvents([
        {
          id: 'evt-pre-migration',
          event_type: 'IssuerAdded',
          ledger: 900,
          timestamp: 1700000000,
          contract_id: 'CABC',
          payload: { issuer: 'GPRE' },
        },
      ]);
      runMigrations();
      expect(getSchemaVersion()).toBeGreaterThanOrEqual(versionBefore);
      expect(queryEvents().filter((e) => e.id === 'evt-pre-migration').length).toBe(1);
    } finally {
      if (fs.existsSync(upgradeDb)) fs.unlinkSync(upgradeDb);
    }
  });

  it('rolls back a failed upgrade', async () => {
    const failDb = path.join(os.tmpdir(), `vaccichain-migrate-fail-${Date.now()}.db`);
    try {
      await initDb(failDb);
      const versionBefore = getSchemaVersion();
      expect(() =>
        runMigrations([
          {
            version: versionBefore + 1,
            up: () => {
              throw new Error('migration failed');
            },
          },
        ])
      ).toThrow('migration failed');
      expect(getSchemaVersion()).toBe(versionBefore);
    } finally {
      if (fs.existsSync(failDb)) fs.unlinkSync(failDb);
    }
  });
});

describe('GET /events route', () => {
  const request = require('supertest');
  const app = require('../src/app');

  it('returns events array', async () => {
    const res = await request(app).get('/events');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(typeof res.body.count).toBe('number');
  });

  it('filters by event_type', async () => {
    const res = await request(app).get('/events?event_type=VaccinationMinted');
    expect(res.status).toBe(200);
    res.body.events.forEach((e) => expect(e.event_type).toBe('VaccinationMinted'));
  });

  it('respects limit param', async () => {
    const res = await request(app).get('/events?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeLessThanOrEqual(1);
  });
});
