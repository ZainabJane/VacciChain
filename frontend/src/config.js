/**
 * Centralized frontend configuration.
 *
 * All API callers must import their base URLs from this module so that
 * endpoint configuration lives in exactly one place.
 *
 * Environment variables (Vite):
 *   - VITE_API_BASE_URL        Base URL for the Node API
 *   - VITE_ANALYTICS_BASE_URL  Base URL for the analytics endpoints
 *
 * Defaults are provided for development and test. In production, both
 * variables are required and must not point at localhost; otherwise the
 * module throws at load time so the build/startup fails loudly instead of
 * silently targeting localhost.
 */

const LOCALHOST_PATTERN = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i;

const DEV_DEFAULTS = Object.freeze({
  apiBaseUrl: 'http://localhost:3000',
  analyticsBaseUrl: 'http://localhost:3001',
});

const TEST_DEFAULTS = Object.freeze({
  apiBaseUrl: 'http://localhost:3000',
  analyticsBaseUrl: 'http://localhost:3001',
});

const PROD_DEFAULTS = Object.freeze({
  apiBaseUrl: '',
  analyticsBaseUrl: '',
});

/**
 * Resolve the environment mode from Vite's import.meta.env.
 * Falls back to "development" when the mode is unavailable.
 */
function resolveMode() {
  const env = import.meta.env || {};
  if (env.PROD) return 'production';
  if (env.MODE === 'test') return 'test';
  if (env.MODE === 'production') return 'production';
  return 'development';
}

function getDefaults(mode) {
  switch (mode) {
    case 'production':
      return PROD_DEFAULTS;
    case 'test':
      return TEST_DEFAULTS;
    default:
      return DEV_DEFAULTS;
  }
}

function readEnv(name) {
  const env = import.meta.env || {};
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize a base URL: strip trailing slashes so callers can safely
 * concatenate paths.
 */
function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function isLocalhostUrl(value) {
  return LOCALHOST_PATTERN.test(value);
}

function isValidUrl(value) {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a resolved base URL. Throws in production when the URL is
 * missing, malformed, or points at localhost.
 */
function validateBaseUrl(name, value, mode) {
  const isProduction = mode === 'production';

  if (!value) {
    if (isProduction) {
      throw new Error(
        `[config] Missing required environment variable ${name} in production. ` +
          `Set ${name} to a non-localhost URL before building.`,
      );
    }
    return;
  }

  if (!isValidUrl(value)) {
    throw new Error(
      `[config] Invalid URL for ${name}: "${value}". Expected an absolute URL such as https://api.example.com.`,
    );
  }

  if (isProduction && isLocalhostUrl(value)) {
    throw new Error(
      `[config] ${name} points to localhost ("${value}") in production. ` +
        `Set ${name} to a reachable non-localhost URL before building.`,
    );
  }
}

const MODE = resolveMode();
const DEFAULTS = getDefaults(MODE);

const resolvedApiBaseUrl = normalizeBaseUrl(
  readEnv('VITE_API_BASE_URL') || DEFAULTS.apiBaseUrl,
);
const resolvedAnalyticsBaseUrl = normalizeBaseUrl(
  readEnv('VITE_ANALYTICS_BASE_URL') || DEFAULTS.analyticsBaseUrl,
);

validateBaseUrl('VITE_API_BASE_URL', resolvedApiBaseUrl, MODE);
validateBaseUrl('VITE_ANALYTICS_BASE_URL', resolvedAnalyticsBaseUrl, MODE);

/**
 * Base URL for the Node API. All Node API callers must use this constant
 * (or the apiUrl helper) instead of hardcoding URLs.
 */
export const API_BASE_URL = resolvedApiBaseUrl;

/**
 * Base URL for the analytics endpoints. All analytics callers must use
 * this constant instead of hardcoding URLs.
 */
export const ANALYTICS_BASE_URL = resolvedAnalyticsBaseUrl;

/**
 * Build a full URL for the Node API from a relative path.
 *
 * @param {string} path Relative path, e.g. "/users/1" or "users/1".
 * @returns {string} Absolute URL.
 */
export function apiUrl(path = '') {
  const normalizedPath = String(path).replace(/^\/+/, '');
  if (!normalizedPath) return API_BASE_URL;
  return `${API_BASE_URL}/${normalizedPath}`;
}

/**
 * Build a full URL for the analytics endpoints from a relative path.
 *
 * @param {string} path Relative path, e.g. "/events" or "events".
 * @returns {string} Absolute URL.
 */
export function analyticsUrl(path = '') {
  const normalizedPath = String(path).replace(/^\/+/, '');
  if (!normalizedPath) return ANALYTICS_BASE_URL;
  return `${ANALYTICS_BASE_URL}/${normalizedPath}`;
}

export default {
  API_BASE_URL,
  ANALYTICS_BASE_URL,
  apiUrl,
  analyticsUrl,
};