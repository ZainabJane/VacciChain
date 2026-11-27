# Frontend bundle budget

`npm run build` reports gzipped JS and CSS per route, writes `dist/bundle-report.json`, and fails
if a limit in `frontend/bundle-budget.json` is exceeded:

| Limit | Meaning |
| --- | --- |
| `initialGzipKB` | entry chunk and its static imports, loaded on every page |
| `routeGzipKB` | initial load plus the route's own chunks |
| `asyncChunkGzipKB` | any on-demand library chunk (jsPDF, html2canvas, QR code) |

Every route except the landing page is lazy. Direct URLs still work because nginx serves
`index.html` for app paths. A missing file under `/assets/` returns 404, and
`ChunkErrorBoundary` then offers a reload. Raise a limit only in the PR that needs it, with the reason.
