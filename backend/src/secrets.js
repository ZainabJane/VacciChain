import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * Load secrets from AWS Secrets Manager
 * @param {string} secretName - Secret name/ARN in Secrets Manager
 * @returns {Promise<Object>} Parsed secret object
 */
export async function loadSecretsFromAWS(secretName) {
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  
  try {
    const command = new GetSecretValueCommand({ SecretId: secretName });
    const response = await client.send(command);
    
    if (response.SecretString) {
      return JSON.parse(response.SecretString);
    }
    
    throw new Error('Secret does not contain SecretString');
  } catch (error) {
    // Avoid leaking secret values: only surface the error name and a sanitized message.
    const safeMessage = sanitizeErrorMessage(error);
    console.error(`Failed to load secrets from AWS: ${safeMessage}`);
    const wrapped = new Error(`Failed to load secrets from AWS: ${safeMessage}`);
    wrapped.name = 'SecretsLoadError';
    wrapped.code = error?.name || 'SECRETS_LOAD_FAILED';
    throw wrapped;
  }
}

/**
 * Produce a safe, non-sensitive error message.
 * Strips anything that could resemble a secret value from the message.
 * @param {unknown} error
 * @returns {string}
 */
function sanitizeErrorMessage(error) {
  const raw = error && typeof error === 'object' && 'message' in error
    ? String(error.message)
    : String(error);
  // Redact common secret-bearing patterns (key=value, JSON-ish, long tokens).
  return raw
    .replace(/(["']?[A-Za-z0-9_]*(?:secret|token|password|key)[A-Za-z0-9_]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9/+=]{32,}\b/g, '[REDACTED]');
}

/**
 * Load secrets from environment or AWS Secrets Manager
 * Falls back to .env file if AWS is not configured.
 *
 * In production, a failure to load required secrets is fatal (fail-fast) so the
 * service never starts with partial configuration. In other environments the
 * failure is reported via a structured diagnostic and initialization continues.
 *
 * @returns {Promise<{ok: boolean, source: string, error?: {name: string, code: string, message: string}}>}
 */
export async function initializeSecrets() {
  const useAWS = process.env.USE_AWS_SECRETS === 'true';
  const secretName = process.env.AWS_SECRET_NAME;
  const isProduction = process.env.NODE_ENV === 'production';

  if (!useAWS || !secretName) {
    return { ok: true, source: 'environment' };
  }

  try {
    const secrets = await loadSecretsFromAWS(secretName);
    Object.entries(secrets).forEach(([key, value]) => {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    });
    console.log('Secrets loaded from AWS Secrets Manager');
    return { ok: true, source: 'aws-secrets-manager' };
  } catch (error) {
    const diagnostic = {
      ok: false,
      source: 'aws-secrets-manager',
      error: {
        name: error?.name || 'SecretsLoadError',
        code: error?.code || 'SECRETS_LOAD_FAILED',
        message: sanitizeErrorMessage(error),
      },
    };

    if (isProduction) {
      // Fail-fast: do not start with partial configuration.
      console.error('Fatal: failed to load required secrets from AWS Secrets Manager', diagnostic.error);
      const fatal = new Error(`Secrets initialization failed: ${diagnostic.error.message}`);
      fatal.name = 'SecretsInitializationError';
      fatal.code = diagnostic.error.code;
      fatal.diagnostic = diagnostic;
      throw fatal;
    }

    console.error('Failed to load secrets from AWS, falling back to environment variables', diagnostic.error);
    return diagnostic;
  }
}
