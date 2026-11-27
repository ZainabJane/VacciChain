/**
 * Analytics proxy route — /v1/analytics/*
 *
 * Forwards requests to the internal Python analytics service for a fixed
 * allow-list of paths.  The analytics service is never reachable directly
 * from outside the Compose network; this Express route is the only
 * production-facing entry point.
 *
 * Allowed paths: /rates  /issuers  /anomalies
 *
 * Design decisions:
 * - Allow-list (not block-list) so new analytics endpoints are opt-in.
 * - Short, explicit timeouts to avoid hanging requests.
 * - Errors from the upstream are translated to predictable shapes before
 *   they reach the caller, so internal service details are not leaked.
 */

const express = require('express');
const http = require('http');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const ANALYTICS_HOST = process.env.ANALYTICS_HOST || 'python-service';
const ANALYTICS_PORT = parseInt(process.env.ANALYTICS_PORT || '8001', 10);

/** Paths the proxy is permitted to forward (without the /analytics prefix). */
const ALLOWED_PATHS = new Set(['/rates', '/issuers', '/anomalies']);

/** Timeout (ms) for the upstream request. */
const UPSTREAM_TIMEOUT_MS = parseInt(
  process.env.ANALYTICS_PROXY_TIMEOUT_MS || '8000',
  10,
);

/**
 * Forward an allow-listed GET request to the internal analytics service and
 * pipe the response back, translating upstream errors into predictable shapes.
 *
 * @param {string} path - Upstream path, e.g. "/rates"
 * @param {import('express').Response} res - Express response object
 */
function proxyToAnalytics(path, res) {
  const options = {
    hostname: ANALYTICS_HOST,
    port: ANALYTICS_PORT,
    path: `/analytics${path}`,
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  };

  const upstream = http.request(options, (upstreamRes) => {
    // Pass through the status code and content-type only — strip any
    // internal headers the analytics service might send.
    res.status(upstreamRes.statusCode || 502);
    res.setHeader(
      'Content-Type',
      upstreamRes.headers['content-type'] || 'application/json',
    );
    upstreamRes.pipe(res, { end: true });
  });

  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    upstream.destroy();
    if (!res.headersSent) {
      res.status(504).json({ error: 'Analytics service timed out.' });
    }
  });

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      // Do not expose internal hostnames or OS error codes.
      res.status(502).json({ error: 'Analytics service unavailable.' });
    }
  });

  upstream.end();
}

/**
 * GET /v1/analytics/:resource
 *
 * Requires a valid JWT (admin or issuer role).  Forwards the request to the
 * internal analytics service for allow-listed resources.
 *
 * @route GET /v1/analytics/:resource
 * @security BearerAuth
 * @param {string} resource.path.required - One of: rates, issuers, anomalies
 * @returns {object} 200 - Analytics data from the upstream service
 * @returns {object} 403 - Resource is not on the allow-list
 * @returns {object} 502 - Upstream analytics service is unreachable
 * @returns {object} 504 - Upstream request timed out
 */
router.get('/:resource', authMiddleware, (req, res) => {
  const { resource } = req.params;
  const path = `/${resource}`;

  if (!ALLOWED_PATHS.has(path)) {
    return res.status(403).json({
      error: `Analytics path '${resource}' is not supported.`,
      allowed: Array.from(ALLOWED_PATHS).map((p) => p.slice(1)),
    });
  }

  proxyToAnalytics(path, res);
});

module.exports = router;
