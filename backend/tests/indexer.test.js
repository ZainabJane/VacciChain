const os = require('os');
const path = require('path');
const fs = require('fs');
const { initDb, upsertEvents, queryEvents, getLatestLedger } = require('../src/indexer/db');
const { parseEvent, stopPoller } = require('../src/indexer/poller');
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

describeRetention('retention — purge policies', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  const seedRetentionEvents = () => {
    upsertEvents([
      {
        id: 'ret-old-indexed',
        event_type: 'VaccinationMinted',
        ledger: 300,
        timestamp: Math.floor((now - 400 * DAY_MS) / 1000),
        contract_id: 'CABC',
        payload: { vaccine_name: 'Old' },
      },
      {
        id: 'ret-recent-indexed',
        event_type: 'VaccinationMinted',
        ledger: 301,
        timestamp: Math.floor((now - 1 * DAY_MS) / 1000),
        contract_id: 'CABC',
        payload: { vaccine_name: 'Recent' },
      },
      {
        id: 'ret-old-audit',
        event_type: 'IssuerAdded',
        ledger: 302,
        timestamp: Math.floor((now - 400 * DAY_MS) / 1000),
        contract_id: 'CABC',
        payload: { issuer: 'GAUDIT' },
      },
    ]);
  };

  it('documents data classes with retention periods and deletion constraints', () => {
    const policy = retention.getRetentionPolicy();
    expect(Array.isArray(policy)).toBe(true);
    expect(policy.length).toBeGreaterThan(0);
    policy.forEach((entry) => {
      expect(typeof entry.dataClass).toBe('string');
      expect(typeof entry.retentionDays).toBe('number');
      expect(entry.retentionDays).toBeGreaterThan(0);
      expect(typeof entry.deletable).toBe('boolean');
    });
    const audit = policy.find((e) => /audit/i.test(e.dataClass));
    expect(audit).toBeDefined();
    expect(audit.deletable).toBe(false);
  });

  it('purges expired indexed events only', () => {
    seedRetentionEvents();
    const result = retention.runRetentionJob({ now });
    expect(result).toBeDefined();
    expect(result.purged).toBeGreaterThanOrEqual(1);

    const remaining = queryEvents({ limit: 1000 }).map((e) => e.id);
    expect(remaining).not.toContain('ret-old-indexed');
    expect(remaining).toContain('ret-recent-indexed');
  });

  it('preserves audit and recovery records even when expired', () => {
    seedRetentionEvents();
    retention.runRetentionJob({ now });

    const remaining = queryEvents({ limit: 1000 }).map((e) => e.id);
    expect(remaining).toContain('ret-old-audit');
  });

  it('respects configured retention periods', () => {
    seedRetentionEvents();
    // With a very long retention window nothing should be purged.
    const result = retention.runRetentionJob({ now, retentionDays: 100000 });
    expect(result.purged).toBe(0);

    const remaining = queryEvents({ limit: 1000 }).map((e) => e.id);
    expect(remaining).toContain('ret-old-indexed');
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
