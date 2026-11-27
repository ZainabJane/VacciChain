#!/usr/bin/env node
/**
 * OpenAPI drift check (#43).
 *
 * Compares every route mounted under /v1 (read from src/app.js and the
 * router files) with the paths in the generated OpenAPI document
 * (src/swagger.js, built from @swagger JSDoc blocks). Exits 1 when a mounted
 * route has no documentation, or when the spec documents a route that is
 * not mounted, and when a documented operation lacks responses.
 *
 *   npm run docs:check
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

/** `v1.use('/auth', authRoutes)` + `const authRoutes = require('./routes/auth')` → { '/auth': ['auth.js'] } */
function mountedRouters() {
  const app = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  const requires = {};
  for (const m of app.matchAll(/const (\w+) = require\('\.\/routes\/(\w+)'\);/g)) requires[m[1]] = `${m[2]}.js`;
  const mounts = [];
  for (const m of app.matchAll(/v1\.use\('([^']+)',\s*(\w+)\)/g)) {
    if (requires[m[2]]) mounts.push({ prefix: m[1], file: requires[m[2]] });
  }
  return mounts;
}

/** Express `/:wallet` → OpenAPI `/{wallet}`. */
function toOpenApi(p) {
  return p.replace(/:(\w+)/g, '{$1}').replace(/\/$/, '') || '/';
}

function mountedRoutes() {
  const routes = new Set();
  for (const { prefix, file } of mountedRouters()) {
    const source = fs.readFileSync(path.join(SRC, 'routes', file), 'utf8');
    for (const m of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      routes.add(`${m[1].toUpperCase()} ${toOpenApi(prefix + (m[2] === '/' ? '' : m[2]))}`);
    }
  }
  return routes;
}

function documentedRoutes(spec) {
  const routes = new Map();
  for (const [p, ops] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(ops)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      // Docs may be written with or without the /v1 prefix.
      routes.set(`${method.toUpperCase()} ${toOpenApi(p.replace(/^\/v1(?=\/)/, ''))}`, op);
    }
  }
  return routes;
}

function main() {
  const spec = require(path.join(SRC, 'swagger.js'));
  const mounted = mountedRoutes();
  const documented = documentedRoutes(spec);
  const problems = [];

  for (const route of [...mounted].sort()) {
    if (!documented.has(route)) problems.push(`undocumented route: ${route}`);
  }
  for (const [route, op] of documented) {
    if (!mounted.has(route)) problems.push(`documented but not mounted: ${route}`);
    else if (!op.responses || Object.keys(op.responses).length === 0) problems.push(`no responses documented: ${route}`);
  }

  console.log(`OpenAPI check: ${mounted.size} mounted route(s), ${documented.size} documented operation(s).`);
  if (problems.length) {
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log('  ✓ every mounted route is documented');
}

if (require.main === module) main();

module.exports = { mountedRoutes, documentedRoutes, toOpenApi };
