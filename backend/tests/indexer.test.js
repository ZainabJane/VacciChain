const os = require('os');
const path = require('path');
const fs = require('fs');
const { initDb, upsertEvents, queryEvents, getLatestLedger } = require('../src/indexer/db');
const { parseEvent, stopPoller } = require('../src/indexer/poller');
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

describe('reconciliation — detect and repair differences', () => {
  const { reconcileRange, repairDifferences } = require('../src/indexer/reconcile');

  const chainEvents = [
    { id: 'rec-001', event_type: 'VaccinationMinted', ledger: 300, timestamp: 1700001000, contract_id: 'CABC', payload: { vaccine_name: 'Flu' } },
    { id: 'rec-002', event_type: 'IssuerAdded', ledger: 301, timestamp: 1700001060, contract_id: 'CABC', payload: { issuer: 'GISSUER3' } },
    { id: 'rec-003', event_type: 'IssuerRevoked', ledger: 302, timestamp: 1700001120, contract_id: 'CABC', payload: { issuer: 'GISSUER4' } },
  ];

  beforeEach(() => {
    // Seed with a missing event (rec-002 absent) and a duplicate (rec-001 twice)
    upsertEvents([chainEvents[0], chainEvents[0], chainEvents[2]]);
  });

  it('detects missing events in the indexed store', () => {
    const diff = reconcileRange({ fromLedger: 300, toLedger: 302, chainEvents });
    expect(diff.missing.map((e) => e.id)).toContain('rec-002');
  });

  it('detects duplicated indexed events', () => {
    const diff = reconcileRange({ fromLedger: 300, toLedger: 302, chainEvents });
    expect(diff.duplicates.map((e) => e.id)).toContain('rec-001');
  });

  it('detects stale/out-of-order indexed events', () => {
    const diff = reconcileRange({ fromLedger: 300, toLedger: 302, chainEvents });
    expect(Array.isArray(diff.stale)).toBe(true);
  });

  it('emits actionable differences with ledger range', () => {
    const diff = reconcileRange({ fromLedger: 300, toLedger: 302, chainEvents });
    expect(diff.fromLedger).toBe(300);
    expect(diff.toLedger).toBe(302);
    expect(diff).toHaveProperty('missing');
    expect(diff).toHaveProperty('duplicates');
  });

  it('repair is idempotent and fixes missing/duplicate records', () => {
    const diff = reconcileRange({ fromLedger: 300, toLedger: 302, chainEvents });
    repairDifferences(diff, chainEvents);
    const afterFirst = queryEvents();
    const idsAfterFirst = afterFirst.map((e) => e.id).filter((id) => id.startsWith('rec-'));
    expect(idsAfterFirst.filter((id) => id === 'rec-001').length).toBe(1);
    expect(idsAfterFirst).toContain('rec-002');

    // Second repair pass should not change anything
    const diff2 = reconcileRange({ fromLedger: 300, toLedger: 302, chainEvents });
    repairDifferences(diff2, chainEvents);
    const afterSecond = queryEvents();
    const idsAfterSecond = afterSecond.map((e) => e.id).filter((id) => id.startsWith('rec-'));
    expect(idsAfterSecond.sort()).toEqual(idsAfterFirst.sort());
  });

  it('repair handles out-of-order events deterministically', () => {
    const shuffled = [chainEvents[2], chainEvents[0], chainEvents[1]];
    const diff = reconcileRange({ fromLedger: 300, toLedger: 302, chainEvents: shuffled });
    repairDifferences(diff, shuffled);
    const results = queryEvents().filter((e) => e.id.startsWith('rec-'));
    const ledgers = results.map((e) => e.ledger);
    expect(ledgers).toEqual([...ledgers].sort((a, b) => a - b));
  });

  it('repair emits an audit event', () => {
    const auditSpy = jest.fn();
    const diff = reconcileRange({ fromLedger: 300, toLedger: 302, chainEvents });
    repairDifferences(diff, chainEvents, { audit: auditSpy });
    expect(auditSpy).toHaveBeenCalled();
    const auditEntry = auditSpy.mock.calls[0][0];
    expect(auditEntry).toHaveProperty('action');
    expect(auditEntry).toHaveProperty('fromLedger', 300);
    expect(auditEntry).toHaveProperty('toLedger', 302);
  });
});

describe('poller operational controls', () => {
  const { getStatus, pausePoller, resumePoller } = require('../src/indexer/poller');

  it('exposes progress, lag, and state via status', () => {
    const status = getStatus();
    expect(status).toHaveProperty('state');
    expect(status).toHaveProperty('lastLedger');
    expect(status).toHaveProperty('lag');
  });

  it('requires privileged authorization to pause', () => {
    expect(() => pausePoller({ role: 'viewer' })).toThrow(/forbidden|unauthorized/i);
  });

  it('requires privileged authorization to resume', () => {
    expect(() => resumePoller({ role: 'viewer' })).toThrow(/forbidden|unauthorized/i);
  });

  it('transitions state on pause and resume with audit events', () => {
    const auditSpy = jest.fn();
    pausePoller({ role: 'operator', audit: auditSpy });
    expect(getStatus().state).toBe('paused');
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'poller.pause' }));

    resumePoller({ role: 'operator', audit: auditSpy });
    expect(getStatus().state).toBe('running');
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'poller.resume' }));
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
