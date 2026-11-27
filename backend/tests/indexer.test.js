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

let retention;
try {
  // Retention/purge module (backlog #53). Optional so this suite still runs
  // if the module has not been wired up yet.
  retention = require('../src/indexer/retention');
} catch (err) {
  retention = null;
}
const describeRetention = retention ? describe : describe.skip;


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

describe('db — integrity and startup checks', () => {
  const { checkDatabaseIntegrity } = require('../src/indexer/db');

  it('reports a valid database as healthy', async () => {
    const result = await checkDatabaseIntegrity(tmpDb);
    expect(result.ok).toBe(true);
    expect(result.schemaVersion).toBeDefined();
    expect(Array.isArray(result.missingTables)).toBe(true);
    expect(result.missingTables.length).toBe(0);
  });

  it('fails closed on a corrupt database without creating a replacement', async () => {
    const corruptPath = path.join(os.tmpdir(), `vaccichain-corrupt-${Date.now()}.db`);
    fs.writeFileSync(corruptPath, 'this is not a sqlite database');
    const sizeBefore = fs.statSync(corruptPath).size;

    const result = await checkDatabaseIntegrity(corruptPath);
    expect(result.ok).toBe(false);
    expect(result.alert).toBeTruthy();
    expect(result.alert).toMatch(/corrupt|integrity|inaccessible/i);

    // Must not silently replace the corrupt file with an empty database
    expect(fs.existsSync(corruptPath)).toBe(true);
    expect(fs.statSync(corruptPath).size).toBe(sizeBefore);
    expect(fs.readFileSync(corruptPath, 'utf8')).toBe('this is not a sqlite database');

    fs.unlinkSync(corruptPath);
  });

  it('fails closed on an inaccessible database path', async () => {
    const inaccessiblePath = path.join(
      os.tmpdir(),
      `vaccichain-missing-dir-${Date.now()}`,
      'nested',
      'db.sqlite'
    );

    const result = await checkDatabaseIntegrity(inaccessiblePath);
    expect(result.ok).toBe(false);
    expect(result.alert).toBeTruthy();
    expect(fs.existsSync(inaccessiblePath)).toBe(false);
  });

  it('detects missing required tables', async () => {
    const emptyPath = path.join(os.tmpdir(), `vaccichain-empty-${Date.now()}.db`);
    const Database = require('better-sqlite3');
    const db = new Database(emptyPath);
    db.close();

    const result = await checkDatabaseIntegrity(emptyPath);
    expect(result.ok).toBe(false);
    expect(result.missingTables.length).toBeGreaterThan(0);
    expect(result.alert).toBeTruthy();

    fs.unlinkSync(emptyPath);
  });
});

describe('versioned event schemas', () => {
  const v1Raw = {
    id: 'raw-v1-001',
    topic: [{ value: { toString: () => 'minted' } }],
    ledger: 300,
    ledgerClosedAt: '2024-02-01T00:00:00Z',
    contractId: 'CABC',
    value: { vaccine_name: 'Flu', issuer: 'GISSUER1' },
  };

  const v2Raw = {
    id: 'raw-v2-001',
    topic: [{ value: { toString: () => 'minted' } }],
    ledger: 301,
    ledgerClosedAt: '2024-02-01T00:01:00Z',
    contractId: 'CABC',
    value: {
      schema_version: 2,
      vaccine_name: 'Flu',
      issuer: 'GISSUER1',
      dose_number: 2,
      metadata: { lot: 'LOT-42' },
    },
  };

  it('maps v1 payloads to VaccinationMinted with schema_version 1', () => {
    const parsed = parseEvent(v1Raw);
    expect(parsed).not.toBeNull();
    expect(parsed.event_type).toBe('VaccinationMinted');
    expect(parsed.payload.schema_version).toBe(1);
    expect(parsed.payload.vaccine_name).toBe('Flu');
  });

  it('maps v2 payloads to VaccinationMinted preserving schema_version 2', () => {
    const parsed = parseEvent(v2Raw);
    expect(parsed).not.toBeNull();
    expect(parsed.event_type).toBe('VaccinationMinted');
    expect(parsed.payload.schema_version).toBe(2);
    expect(parsed.payload.dose_number).toBe(2);
    expect(parsed.payload.metadata.lot).toBe('LOT-42');
  });

  it('does not misclassify v1 and v2 payloads as different event types', () => {
    expect(parseEvent(v1Raw).event_type).toBe(parseEvent(v2Raw).event_type);
  });

  it('stores and retrieves versioned payloads without misclassification', () => {
    const parsedV1 = parseEvent(v1Raw);
    const parsedV2 = parseEvent(v2Raw);
    upsertEvents([parsedV1, parsedV2]);

    const stored = queryEvents({ event_type: 'VaccinationMinted' });
    const byId = new Map(stored.map((e) => [e.id, e]));

    expect(byId.get('raw-v1-001').payload.schema_version).toBe(1);
    expect(byId.get('raw-v2-001').payload.schema_version).toBe(2);
    expect(byId.get('raw-v2-001').payload.dose_number).toBe(2);
    expect(byId.get('raw-v1-001').event_type).toBe('VaccinationMinted');
    expect(byId.get('raw-v2-001').event_type).toBe('VaccinationMinted');
  });
});
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

describe('persistence strategy — locking, backup, failover, migration', () => {
  const { backupDb, restoreDb, migrateDb, withWriteLock } = require('../src/indexer/db');
  const strategy = require('../src/indexer/persistenceStrategy');

  it('documents a load and failure analysis comparing SQLite with a multi-writer database', () => {
    const analysis = strategy.loadAndFailureAnalysis();
    expect(analysis).toBeDefined();
    expect(analysis.currentStorage).toMatch(/sqlite/i);
    expect(analysis.multiWriterOption).toBeDefined();
    expect(typeof analysis.multiWriterOption.name).toBe('string');
    expect(analysis.multiWriterOption.name.length).toBeGreaterThan(0);
    expect(Array.isArray(analysis.comparison)).toBe(true);
    expect(analysis.comparison.length).toBeGreaterThan(0);
    expect(analysis.selectedArchitecture).toBeDefined();
  });

  it('serialises concurrent writes through the write lock without losing events', async () => {
    const writes = [];
    for (let i = 0; i < 20; i += 1) {
      writes.push(
        withWriteLock(() =>
          upsertEvents([
            {
              id: `lock-${i}`,
              event_type: 'VaccinationMinted',
              ledger: 500 + i,
              timestamp: 1700000000 + i,
              contract_id: 'CABC',
              payload: { seq: i },
            },
          ])
        )
      );
    }
    await Promise.all(writes);
    const stored = queryEvents({ event_type: 'VaccinationMinted' }).filter((e) =>
      e.id.startsWith('lock-')
    );
    expect(stored.length).toBe(20);
  });

  it('backs up and restores the index without data loss', async () => {
    const backupPath = path.join(os.tmpdir(), `vaccichain-backup-${Date.now()}.db`);
    try {
      await backupDb(backupPath);
      expect(fs.existsSync(backupPath)).toBe(true);

      const before = queryEvents().length;
      await restoreDb(backupPath);
      const after = queryEvents().length;
      expect(after).toBe(before);
    } finally {
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    }
  });

  it('recovers from a simulated failover by reopening the database', async () => {
    const failoverPath = path.join(os.tmpdir(), `vaccichain-failover-${Date.now()}.db`);
    try {
      await initDb(failoverPath);
      upsertEvents([
        {
          id: 'failover-001',
          event_type: 'IssuerAdded',
          ledger: 900,
          timestamp: 1700000000,
          contract_id: 'CABC',
          payload: { issuer: 'GISSUER9' },
        },
      ]);
      // Simulate failover: re-initialise against the same file.
      await initDb(failoverPath);
      const recovered = queryEvents({ event_type: 'IssuerAdded' }).filter(
        (e) => e.id === 'failover-001'
      );
      expect(recovered.length).toBe(1);
    } finally {
      await initDb(tmpDb);
      if (fs.existsSync(failoverPath)) fs.unlinkSync(failoverPath);
    }
  });

  it('runs migrations idempotently and reports the schema version', async () => {
    const first = await migrateDb();
    const second = await migrateDb();
    expect(typeof first.version).toBe('number');
    expect(second.version).toBe(first.version);
    expect(second.applied).toBe(0);
  });
});

describe('GET /events route', () => {
  const request = require('supertest');
  const app = require('../src/app');

  it('returns events array', async () => {
    const res = await request(app).get('/v1/events');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(typeof res.body.count).toBe('number');
  });

  it('filters by event_type', async () => {
    const res = await request(app).get('/v1/events?event_type=VaccinationMinted');
    expect(res.status).toBe(200);
    res.body.events.forEach((e) => expect(e.event_type).toBe('VaccinationMinted'));
  });

  it('respects limit param', async () => {
    const res = await request(app).get('/v1/events?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeLessThanOrEqual(1);
  });
});
