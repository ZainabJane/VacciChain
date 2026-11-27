# VacciChain Bundle Budget

## Production Asset Budget

| Asset Type | Target Size (gzip) | Max Size (gzip) |
|------------|-------------------|-----------------|
| Route chunk (per page) | < 50 KB | < 100 KB |
| Vendor chunk | < 100 KB | < 150 KB |
| Total initial JS | < 150 KB | < 250 KB |

## Route Splitting

Each page is lazy-loaded via `React.lazy` and wrapped in `Suspense` + `ErrorBoundary`:

- `route-landing` — Landing page
- `route-patient` — Patient dashboard
- `route-issuer` — Issuer dashboard
- `route-verify` — Verify page
- `route-admin` — Admin dashboard
- `route-onboarding` — Issuer onboarding
- `route-analytics` — Analytics dashboard

Vendor chunks:
- `vendor-react` — React + React DOM
- `vendor-router` — React Router
- `vendor-i18n` — i18next + react-i18next
- `vendor-certificate` — jsPDF + qrcode (only loaded on certificate export)

## Chunk-Load Error Handling

Each lazy route is wrapped in `ErrorBoundary` which catches chunk-load failures and offers a "Try again" button to retry mounting the route. Direct URL loading is preserved because React Router renders the matching route element, which triggers the lazy import for that specific chunk.

## Generating a Bundle Report

```bash
cd frontend
npm run build-report
```

This builds the project and prints asset sizes against the budget targets.
