/**
 * Server-only AI provider configuration.
 *
 * spec `integrations.deepseek`: DeepSeek is the primary provider and every AI output must be
 * JSON/schema-validated server-side before it can mutate state. This module owns the *connection*
 * details only; the schemas an answer must satisfy live beside the contracts that use them.
 *
 * Two rules it exists to enforce:
 *
 *   1. **The key is server-side and optional.** A missing key is a normal state in development, not
 *      a crash: `configured: false` is returned so a caller can degrade to a typed
 *      provider-not-configured result. Nothing here throws at import time, because a build or a
 *      migration run must not need an AI credential.
 *   2. **Nothing secret is ever logged or returned.** `describeProvider` reports the model, the
 *      origin and whether a key is present — never the key, not even truncated.
 */
import 'server-only';

/** Where the provider lives. Configurable so a proxy or a self-hosted gateway can be used. */
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

export interface ProviderConfig {
  readonly configured: boolean;
  /** Why it is not configured, for a log line. Never includes a value. */
  readonly missing: string | null;
  readonly apiKey: string | null;
  readonly baseUrl: string;
  readonly model: string;
  /** Milliseconds allowed for one attempt. */
  readonly timeoutMs: number;
  /** Attempts in total, including the first. */
  readonly maxAttempts: number;
  /** Base delay for exponential backoff between attempts. */
  readonly retryBaseMs: number;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads the provider configuration from the environment.
 *
 * Read per call rather than captured at module load: the web app imports this during a build, and a
 * build machine has no DeepSeek key. A module-level read would bake `configured: false` into the
 * running process.
 */
export function providerConfig(): ProviderConfig {
  const apiKey = (process.env.DEEPSEEK_API_KEY ?? '').trim();
  const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const model = (process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL).trim();

  return {
    configured: apiKey.length > 0,
    missing: apiKey.length > 0 ? null : 'DEEPSEEK_API_KEY is not set',
    apiKey: apiKey.length > 0 ? apiKey : null,
    baseUrl,
    model: model.length > 0 ? model : DEFAULT_MODEL,
    // 30s: a profile extraction can be long, and a shorter timeout turns a slow model into a
    // spurious failure. Configurable because a batch normaliser may want longer.
    timeoutMs: readPositiveInt('DEEPSEEK_TIMEOUT_MS', 30_000),
    maxAttempts: readPositiveInt('DEEPSEEK_MAX_ATTEMPTS', 3),
    retryBaseMs: readPositiveInt('DEEPSEEK_RETRY_BASE_MS', 500),
  };
}

/** A log-safe description. The key is deliberately absent. */
export function describeProvider(config: ProviderConfig = providerConfig()): {
  readonly configured: boolean;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
} {
  return {
    configured: config.configured,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
  };
}

/**
 * Removes anything key-shaped from a string before it is logged.
 *
 * Belt and braces: the provider never logs the key, but an upstream error can echo the request it
 * received, and an upstream error is exactly the thing a developer pastes into an issue.
 */
export function redactSecrets(text: string, config: ProviderConfig = providerConfig()): string {
  let output = text;
  if (config.apiKey !== null && config.apiKey.length > 0) {
    output = output.split(config.apiKey).join('[redacted-api-key]');
  }
  // Bearer tokens, and `sk-`-style keys that are not this provider's.
  output = output.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]');
  output = output.replace(/\bsk-[A-Za-z0-9]{16,}\b/g, '[redacted-key]');
  return output;
}
