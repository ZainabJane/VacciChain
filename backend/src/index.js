'use strict';

const config = require('./config');
const logger = require('./logger');
const secrets = require('./secrets');
const database = require('./database');
const poller = require('./poller');

/**
 * Readiness state. Remains false until all required initialization steps
 * have completed successfully.
 */
let ready = false;

/**
 * Returns whether the service has completed all required initialization steps.
 * @returns {boolean}
 */
function isReady() {
  return ready === true;
}

/**
 * Sanitizes an error into a structured, secret-free diagnostic.
 * @param {string} step - Name of the initialization step.
 * @param {Error|*} err - The error that occurred.
 * @returns {{step: string, name: string, message: string, code: (string|number|null)}}
 */
function sanitizeError(step, err) {
  const safe = {
    step: String(step),
    name: 'Error',
    message: 'Initialization failed',
    code: null,
  };

  if (err && typeof err === 'object') {
    if (typeof err.name === 'string' && err.name.length > 0) {
      safe.name = err.name;
    }
    if (typeof err.message === 'string' && err.message.length > 0) {
      safe.message = err.message;
    }
    if (typeof err.code === 'string' || typeof err.code === 'number') {
      safe.code = err.code;
    }
  } else if (typeof err === 'string' && err.length > 0) {
    safe.message = err;
  }

  return safe;
}

/**
 * Runs a single initialization step, capturing failures as structured
 * diagnostics rather than throwing.
 * @param {string} name - Step name.
 * @param {Function} fn - Step function (may be async).
 * @returns {Promise<{ok: boolean, step: string, error?: object}>}
 */
async function runStep(name, fn) {
  try {
    await fn();
    logger.info({ step: name }, 'Startup step succeeded');
    return { ok: true, step: name };
  } catch (err) {
    const diagnostic = sanitizeError(name, err);
    logger.error({ diagnostic }, 'Startup step failed');
    return { ok: false, step: name, error: diagnostic };
  }
}

/**
 * Ordered list of required initialization steps.
 * Each entry has a name and an async function.
 */
function getRequiredSteps() {
  return [
    {
      name: 'config',
      run: async () => {
        if (typeof config.validate === 'function') {
          config.validate();
        } else if (typeof config.load === 'function') {
          await config.load();
        }
      },
    },
    {
      name: 'secrets',
      run: async () => {
        if (typeof secrets.initialize === 'function') {
          await secrets.initialize();
        } else if (typeof secrets.load === 'function') {
          await secrets.load();
        }
      },
    },
    {
      name: 'database',
      run: async () => {
        if (typeof database.connect === 'function') {
          await database.connect();
        } else if (typeof database.initialize === 'function') {
          await database.initialize();
        }
      },
    },
    {
      name: 'poller',
      run: async () => {
        if (typeof poller.start === 'function') {
          await poller.start();
        } else if (typeof poller.initialize === 'function') {
          await poller.initialize();
        }
      },
    },
  ];
}

/**
 * Runs all required initialization steps in order. Sets readiness to true
 * only after every step succeeds. On failure, logs a sanitized structured
 * diagnostic and exits the process with a non-zero code.
 *
 * @param {Object} [options]
 * @param {Function} [options.exit] - Exit function (defaults to process.exit).
 * @param {Array} [options.steps] - Override steps (for testing).
 * @returns {Promise<{ok: boolean, diagnostics: Array}>}
 */
async function runStartup(options = {}) {
  const exit = typeof options.exit === 'function' ? options.exit : process.exit;
  const steps = Array.isArray(options.steps) ? options.steps : getRequiredSteps();

  ready = false;

  const diagnostics = [];

  for (const step of steps) {
    const result = await runStep(step.name, step.run);
    if (!result.ok) {
      diagnostics.push(result.error);
      const summary = {
        event: 'startup_failed',
        failedStep: result.step,
        diagnostics,
      };
      logger.error(summary, 'Startup failed; exiting with non-zero code');
      ready = false;
      exit(1);
      return { ok: false, diagnostics };
    }
  }

  ready = true;
  logger.info({ event: 'startup_complete' }, 'All startup steps succeeded; service ready');
  return { ok: true, diagnostics };
}

module.exports = {
  runStartup,
  isReady,
  sanitizeError,
  getRequiredSteps,
};