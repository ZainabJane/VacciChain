/**
 * API versioning middleware.
 * Adds API-Version header to all responses.
 * When a version (or legacy route) is deprecated, adds Deprecation, Sunset,
 * and Link (successor-version) headers so integrations can migrate without
 * surprises.
 *
 * Lifecycle policy (see docs/api-lifecycle.md):
 *  - A version is announced as deprecated at least MIGRATION_WINDOW_DAYS before
 *    its sunset date.
 *  - Deprecated responses include a `Deprecation` header, a `Sunset` header
 *    (HTTP-date), and a `Link` header pointing at the successor version.
 *  - After the sunset date the version is removed.
 */
const CURRENT_VERSION = '1';

// Minimum supported migration window between deprecation and sunset.
const MIGRATION_WINDOW_DAYS = 180;

/**
 * Deprecated versions and legacy routes.
 * Each entry:
 *   sunset:    ISO 8601 date (e.g. '2025-01-01T00:00:00Z') when the version is removed.
 *   successor: Absolute or root-relative URL of the successor version.
 *   deprecatedAt: ISO 8601 date when deprecation was announced (optional).
 */
const SUNSET_VERSIONS = {
  // Example: { sunset: '2025-01-01T00:00:00Z', successor: '/api/v1' }
};

/**
 * Legacy (unversioned) routes mapped to their successor versioned routes.
 * Keyed by the request path prefix.
 */
const LEGACY_ROUTES = {
  // Example: '/api/users': { sunset: '2025-01-01T00:00:00Z', successor: '/api/v1/users' }
};

function toHttpDate(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toUTCString();
}

function buildSuccessorLink(successor) {
  if (!successor) {
    return null;
  }
  return `<${successor}>; rel="successor-version"`;
}

function applyDeprecationHeaders(res, entry) {
  if (!entry) {
    return;
  }
  res.setHeader('Deprecation', 'true');

  const sunset = toHttpDate(entry.sunset);
  if (sunset) {
    res.setHeader('Sunset', sunset);
  }

  const link = buildSuccessorLink(entry.successor);
  if (link) {
    res.setHeader('Link', link);
  }
}

function findLegacyRoute(path) {
  if (!path) {
    return null;
  }
  const prefixes = Object.keys(LEGACY_ROUTES).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return LEGACY_ROUTES[prefix];
    }
  }
  return null;
}

function apiVersion(req, res, next) {
  res.setHeader('API-Version', CURRENT_VERSION);

  const requestedVersion = req.params && req.params.version;
  if (requestedVersion && SUNSET_VERSIONS[requestedVersion]) {
    applyDeprecationHeaders(res, SUNSET_VERSIONS[requestedVersion]);
  } else {
    const legacyEntry = findLegacyRoute(req.path);
    if (legacyEntry) {
      applyDeprecationHeaders(res, legacyEntry);
    }
  }

  next();
}

apiVersion.CURRENT_VERSION = CURRENT_VERSION;
apiVersion.SUNSET_VERSIONS = SUNSET_VERSIONS;
apiVersion.LEGACY_ROUTES = LEGACY_ROUTES;
apiVersion.MIGRATION_WINDOW_DAYS = MIGRATION_WINDOW_DAYS;

module.exports = apiVersion;