jest.mock('../src/indexer/db', () => ({
  ...jest.requireActual('../src/indexer/db'),
  queryEvents: jest.fn(() => []),
  getConsent: jest.fn(() => null),
  hasConsented: jest.fn(() => false),
}));
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');

const ROUTERS = {
  auth: ['auth'], vaccination: ['vaccination'], verify: ['verify'], admin: ['admin'],
  patient: ['patient', 'consent'], events: ['events'], onboarding: ['onboarding'],
};
const endpoints = Object.entries(ROUTERS).flatMap(([mount, files]) => files.flatMap((f) =>
  require(`../src/routes/${f}`).stack.filter((l) => l.route).flatMap((l) =>
    Object.keys(l.route.methods).map((m) => [m.toUpperCase(), `/${mount}${l.route.path}`.replace(/\/$/, '')]))));
const docs = fs.readFileSync(path.join(__dirname, '../../docs/api-routes.md'), 'utf8');

describe.each(endpoints)('%s %s', (method, route) => {
  const url = route.replace(/:\w+/g, 'x');

  it('is documented', () => {
    expect(docs).toContain(`| ${method} | \`/v1${route}\` | \`${route}\` |`);
  });

  it('redirects the legacy path, keeping the query string', async () => {
    const res = await request(app)[method.toLowerCase()](`${url}?a=1&b=2`);
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe(`/v1${url}?a=1&b=2`);
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers['api-version']).toBe('1');
    expect(res.headers.link).toContain('rel="successor-version"');
  });

  it('serves the canonical path with a version header and no redirect', async () => {
    const res = await request(app)[method.toLowerCase()](`/v1${url}`);
    expect([308, 404]).not.toContain(res.status);
    expect(res.headers['api-version']).toBe('1');
    expect(res.headers.deprecation).toBeUndefined();
  });
});

it('does not redirect unversioned infrastructure routes', async () => {
  expect((await request(app).get('/health')).status).not.toBe(308);
});
