// Reports gzipped JS/CSS per route from the Vite manifest; exits 1 over budget.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root));
const manifest = JSON.parse(read('dist/.vite/manifest.json'));
const budget = JSON.parse(read('bundle-budget.json'));

const size = (file) => gzipSync(read(`dist/${file}`)).length;
function files(key, seen = new Set(), out = new Set()) {
  if (seen.has(key)) return out;
  seen.add(key);
  const chunk = manifest[key];
  out.add(chunk.file);
  (chunk.css ?? []).forEach((f) => out.add(f));
  (chunk.imports ?? []).forEach((k) => files(k, seen, out));
  return out;
}
const total = (set) => [...set].reduce((n, f) => n + size(f), 0);
const kb = (n) => Math.round(n / 10.24) / 100;

const app = read('src/App.jsx').toString();
const routes = [...app.matchAll(/<Route path="([^"]+)" element={<(\w+)/g)];
const entry = Object.keys(manifest).find((k) => manifest[k].isEntry);
const initial = files(entry);
const rows = [['(initial)', total(initial), budget.initialGzipKB]];
for (const [, path, page] of routes) {
  const key = `src/pages/${page}.jsx`;
  const set = new Set([...initial, ...(manifest[key] ? files(key) : [])]);
  rows.push([path, total(set), budget.routeGzipKB]);
}
for (const chunk of Object.values(manifest)) {
  if (chunk.isDynamicEntry && !chunk.src?.startsWith('src/pages/')) {
    rows.push([`async ${chunk.file}`, size(chunk.file), budget.asyncChunkGzipKB]);
  }
}

const report = rows.map(([name, bytes, max]) => ({ name, gzipKB: kb(bytes), budgetKB: max, ok: kb(bytes) <= max }));
console.table(report);
writeFileSync(new URL('dist/bundle-report.json', root), JSON.stringify(report, null, 2));
if (report.some((r) => !r.ok)) {
  console.error('Bundle budget exceeded (see bundle-budget.json).');
  process.exit(1);
}
