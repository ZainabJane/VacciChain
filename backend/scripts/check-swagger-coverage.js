/**
 * check-swagger-coverage.js — CI check that every mounted route is documented
 * in the OpenAPI spec (#43).
 *
 * Parses backend/src/app.js to find route mount prefixes and the route files
 * they come from, statically scans each route file for router.<METHOD>('<path>')
 * registrations, builds the set of actual (path, method) pairs, and compares
 * against the paths documented in the swagger spec (built by swagger-jsdoc
 * from @swagger JSDoc blocks).
 *
 * Exits non-zero if any mounted route lacks swagger documentation, printing the
 * missing (path, method) pairs.
 */

const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const APP_FILE = path.join(BACKEND, 'src', 'app.js');
const ROUTES_DIR = path.join(BACKEND, 'src', 'routes');

// Normalize a path so `:param` and `{param}` are treated identically and
// trailing slashes are dropped.
function normalize(p) {
  return p
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// Build mount prefix -> route file mapping by parsing app.js:
//   const authRoutes = require('./routes/auth');
//   app.use('/auth', authRoutes);
//   v1.use('/auth', authRoutes);
function buildMountMap() {
  const src = fs.readFileSync(APP_FILE, 'utf8');

  // varName -> route file basename (e.g. authRoutes -> auth)
  const varToFile = {};
  for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*require\('(\.\/routes\/[A-Za-z0-9_]+)'\)/g)) {
    varToFile[m[1]] = m[2].replace('./routes/', '');
  }

  // prefix -> set of route files mounted there
  const mountMap = {};
  function add(prefix, varName) {
    const file = varToFile[varName];
    if (!file) return;
    if (!mountMap[prefix]) mountMap[prefix] = new Set();
    mountMap[prefix].add(file);
  }
  for (const m of src.matchAll(/app\.use\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    add(m[1], m[2]);
  }
  for (const m of src.matchAll(/v1\.use\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    add(`/v1${m[1]}`, m[2]);
  }
  return mountMap;
}

// Scan a route file for router.<METHOD>('<path>') registrations.
function scanRoutes(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const routes = [];
  const re = /router\.(get|post|put|patch|delete|all|head|options)\s*\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    routes.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return routes;
}

function main() {
  const mountMap = buildMountMap();
  if (Object.keys(mountMap).length === 0) {
    console.error('check-swagger-coverage: could not parse any mounts from app.js');
    process.exit(1);
  }

  // Actual (path, method) set across all mount prefixes.
  const actual = new Set();
  const filesSeen = new Set();
  for (const [prefix, files] of Object.entries(mountMap)) {
    for (const file of files) {
      if (filesSeen.has(file)) continue;
      filesSeen.add(file);
      const filePath = path.join(ROUTES_DIR, `${file}.js`);
      if (!fs.existsSync(filePath)) {
        console.error(`check-swagger-coverage: route file not found: ${filePath}`);
        process.exit(1);
      }
      for (const r of scanRoutes(filePath)) {
        // Each mount prefix yields a distinct full path.
        const fullPath = normalize(`${prefix}${r.path}`);
        actual.add(`${fullPath} ${r.method}`);
      }
    }
  }

  // Documented (path, method) set from the swagger spec.
  let spec;
  try {
    spec = require(path.join(BACKEND, 'src', 'swagger'));
  } catch (err) {
    console.error(`check-swagger-coverage: failed to load swagger spec: ${err.message}`);
    process.exit(1);
  }
  const documented = new Set();
  const specPaths = spec && spec.paths ? spec.paths : {};
  for (const [rawPath, methods] of Object.entries(specPaths)) {
    if (!methods || typeof methods !== 'object') continue;
    const pathNorm = normalize(rawPath);
    for (const [method] of Object.entries(methods)) {
      if (method.startsWith('x-') || method.startsWith('_')) continue;
      documented.add(`${pathNorm} ${method.toUpperCase()}`);
    }
  }

  const missing = [...actual].filter((entry) => !documented.has(entry)).sort();

  console.log(`check-swagger-coverage: ${actual.size} mounted routes, ${documented.size} documented`);
  if (missing.length) {
    console.error('check-swagger-coverage: FAIL — the following routes are not documented in swagger:');
    for (const entry of missing) {
      console.error(`  - ${entry}`);
    }
    process.exit(1);
  }

  console.log('check-swagger-coverage: OK — all mounted routes are documented in swagger');
}

main();
