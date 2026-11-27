const express = require('express');

/**
 * Analytics proxy (#37).
 *
 * Provides a controlled production path from the browser to the internal
 * analytics service. Only documented analytics paths are forwarded; anything
 * else is rejected with a predictable 400. Upstream failures/timeouts are
 * mapped to predictable 502/504 responses so callers never see raw upstream
 * errors and the analytics service is never opened directly to the public.
 */

const router = express.Router();

const ANALYTICS_BASE = process.env.ANALYTICS_BASE_URL || 'http://localhost:8001';
const PROXY_TIMEOUT_MS = Number(process.env.ANALYTICS_PROXY_TIMEOUT_MS || 8000);

// The only analytics paths the proxy is allowed to forward.
const DOCUMENTED_PATHS = new Set(['/rates', '/issuers', '/anomalies']);

router.get('/:path*', async (req, res) => {
  const requested = '/' + (req.params.path || '');
  if (!DOCUMENTED_PATHS.has(requested)) {
    return res.status(400).json({ error: 'Undocumented analytics path' });
  }

  let timeoutHandle;
  try {
    const controller = new AbortController();
    timeoutHandle = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

    const upstream = await fetch(`${ANALYTICS_BASE}/analytics${requested}`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutHandle);

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'Analytics service error' });
    }

    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    clearTimeout(timeoutHandle);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Analytics request timed out' });
    }
    return res.status(502).json({ error: 'Analytics service unavailable' });
  }
});

module.exports = router;
