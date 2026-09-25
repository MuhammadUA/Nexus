/**
 * DeepSeek provider.
 *
 * spec `integrations.deepseek`: the primary provider, server-side only, JSON/schema-validated before
 * any mutation. This is the transport that was missing — the schemas, prompt construction, selective
 * retrieval and claim checking already exist in `@nexus/core` and are used unchanged.
 *
 * Design decisions worth stating, because each one is a way this could be wrong:
 *
 *   * **The schema is applied here, not by the caller.** A response that does not satisfy it is a
 *     failure, so it is impossible to write an unvalidated model output by forgetting a parse.
 *   * **Models wrap JSON in prose.** A chat model asked for JSON will often answer with
 *     ```json fences, or with a sentence before the object. Extracting the JSON is treated as a
 *     separate, testable step, and a response containing no JSON at all is `malformed_json` rather
 *     than a schema failure — the two need different handling.
 *   * **Retries are bounded and selective.** A 429, a 5xx or a timeout may succeed on a second
 *     attempt; a 400 or a 401 will not, and retrying an auth failure just burns time. A schema
 *     violation is retried once, because a model that emitted invalid JSON once sometimes does not
 *     the second time — but only once, so a systematically wrong model cannot spin.
 *   * **Nothing secret is logged.** Errors are redacted, and the API key never reaches a log line,
 *     an error message, or a returned value.
 */
import 'server-only';

import type { z } from 'zod';

import { describeProvider, providerConfig, redactSecrets, type ProviderConfig } from './config';
import type { AiFailure, AiFailureKind, AiJsonRequest, AiProvider, AiResult } from './types';

/** Response shape of the OpenAI-compatible chat-completions endpoint DeepSeek exposes. */
interface ChatCompletionResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
    readonly finish_reason?: unknown;
  }[];
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown };
}

/**
 * Pulls the first JSON object or array out of a model's answer.
 *
 * Returns null when there is none. Scanning for the outermost balanced braces (while respecting
 * string literals and escapes) is used rather than a regex, because a regex cannot tell a brace
 * inside a quoted string from a structural one and would truncate a valid object.
 */
export function extractJsonObject(text: string): string | null {
  const start = findFirstStructural(text);
  if (start === null) return null;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  // Unbalanced: the model was cut off mid-object.
  return null;
}

/** Index of the first `{` or `[` that is not inside a string literal. */
function findFirstStructural(text: string): number | null {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{' || char === '[') return index;
  }
  return null;
}

/** Maps an HTTP status onto the failure vocabulary. */
function failureForStatus(status: number, body: string, config: ProviderConfig): AiFailure {
  const safeDetail = redactSecrets(body.slice(0, 300), config);

  if (status === 401 || status === 403) {
    return {
      ok: false,
      kind: 'unauthorized',
      error: 'The AI provider rejected the configured credential.',
      retryable: false,
      status,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      kind: 'rate_limited',
      error: 'The AI provider is rate limiting requests. Try again shortly.',
      // Retryable, but the caller should honour the backoff: hammering a 429 extends it.
      retryable: true,
      status,
    };
  }
  if (status === 400 || status === 422) {
    return {
      ok: false,
      kind: 'invalid_request',
      error: `The AI provider rejected the request: ${safeDetail}`,
      retryable: false,
      status,
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      kind: 'provider_unavailable',
      error: 'The AI provider is unavailable.',
      retryable: true,
      status,
    };
  }
  return {
    ok: false,
    kind: 'provider_unavailable',
    error: `The AI provider returned an unexpected status (${String(status)}).`,
    retryable: status >= 500,
    status,
  };
}

/** Milliseconds to wait before attempt `n` (1-based), honouring `Retry-After` when given. */
export function backoffMs(attempt: number, baseMs: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    // Capped: a provider asking for an hour would otherwise park the request.
    return Math.min(retryAfterSeconds * 1000, 30_000);
  }
  // Exponential with a ceiling, so a long outage cannot produce an unbounded wait.
  return Math.min(baseMs * 2 ** (attempt - 1), 8_000);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A one-shot timeout that does not leak a timer when the request finishes first. */
async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly kind: 'timeout' }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return { ok: true, value: await run(controller.signal) };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, kind: 'timeout' };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function createDeepSeekProvider(config: ProviderConfig = providerConfig()): AiProvider {
  const provider: AiProvider = {
    name: 'deepseek',
    model: config.model,
    configured: config.configured,

    async complete<Schema extends z.ZodTypeAny>(
      request: AiJsonRequest<Schema>,
    ): Promise<AiResult<z.infer<Schema>>> {
      if (!config.configured || config.apiKey === null) {
        // Not an exception: a development machine without a key must get a typed result the UI can
        // render, not a 500.
        return {
          ok: false,
          kind: 'provider_not_configured',
          error: 'AI generation is not configured on this deployment.',
          retryable: false,
          status: null,
        };
      }

      const startedAt = Date.now();
      let attempt = 0;
      let lastFailure: AiFailure | null = null;
      // A schema violation earns exactly one extra attempt; every other retryable failure uses the
      // configured attempt budget.
      let schemaAttemptsLeft = 1;

      while (attempt < config.maxAttempts) {
        attempt += 1;
        const outcome = await attemptOnce(request, config, attempt);

        if (outcome.ok) {
          const parsed = request.schema.safeParse(outcome.value);
          if (parsed.success) {
            const data = parsed.data as z.infer<Schema>;
            return {
              ok: true,
              data,
              provenance: {
                provider: 'deepseek',
                model: config.model,
                promptVersionId: request.promptVersionId ?? null,
                attempts: attempt,
                latencyMs: Date.now() - startedAt,
                usage: outcome.usage,
              },
            };
          }

          const issues = parsed.error.issues
            .slice(0, 10)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
          const failure: AiFailure = {
            ok: false,
            kind: 'schema_invalid',
            error: 'The AI provider returned data that did not match the required shape.',
            retryable: false,
            status: null,
            issues,
          };
          // One extra try only. The budget has to be tested *before* retrying, not after: a
          // second violation must end the call, otherwise a systematically wrong model keeps
          // spending the general attempt budget on a failure that retrying cannot fix.
          if (schemaAttemptsLeft <= 0 || attempt >= config.maxAttempts) return failure;
          schemaAttemptsLeft -= 1;
          lastFailure = failure;
          await sleep(backoffMs(1, config.retryBaseMs, null));
          continue;
        }

        lastFailure = outcome.failure;
        if (!outcome.failure.retryable || attempt >= config.maxAttempts) return outcome.failure;

        await sleep(backoffMs(attempt, config.retryBaseMs, outcome.retryAfterSeconds));
      }

      return (
        lastFailure ?? {
          ok: false,
          kind: 'provider_unavailable',
          error: 'The AI provider could not be reached.',
          retryable: true,
          status: null,
        }
      );
    },
  };

  return provider;
}

type AttemptOutcome =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly usage: { readonly promptTokens: number; readonly completionTokens: number } | null;
    }
  | {
      readonly ok: false;
      readonly failure: AiFailure;
      readonly retryAfterSeconds: number | null;
    };

/** One HTTP attempt: send, read, extract JSON. Schema validation happens in the caller. */
async function attemptOnce<Schema extends z.ZodTypeAny>(
  request: AiJsonRequest<Schema>,
  config: ProviderConfig,
  attempt: number,
): Promise<AttemptOutcome> {
  const url = `${config.baseUrl}/chat/completions`;
  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    // The provider is asked for JSON explicitly; the schema check is what actually guarantees it.
    response_format: { type: 'json_object' },
    temperature: request.temperature ?? 0,
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    stream: false,
  };

  let response: Response;
  let retryAfterSeconds: number | null = null;

  try {
    const timed = await withTimeout(
      (signal) =>
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey ?? ''}`,
          },
          body: JSON.stringify(payload),
          signal,
        }),
      config.timeoutMs,
    );

    if (!timed.ok) {
      return {
        ok: false,
        retryAfterSeconds: null,
        failure: {
          ok: false,
          kind: 'timeout',
          error: `The AI provider did not respond within ${String(Math.round(config.timeoutMs / 1000))}s.`,
          retryable: true,
          status: null,
        },
      };
    }
    response = timed.value;

    const header = response.headers.get('retry-after');
    if (header !== null) {
      const parsed = Number.parseInt(header, 10);
      if (Number.isFinite(parsed)) retryAfterSeconds = parsed;
    }
  } catch (error) {
    // A network failure: DNS, connection refused, TLS. Retryable, and never the key's fault.
    console.error(
      `[ai] ${request.operation} attempt ${String(attempt)} transport failure: ${redactSecrets(
        error instanceof Error ? error.message : String(error),
        config,
      )}`,
    );
    return {
      ok: false,
      retryAfterSeconds: null,
      failure: {
        ok: false,
        kind: 'provider_unavailable',
        error: 'The AI provider could not be reached.',
        retryable: true,
        status: null,
      },
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // Logged with the body redacted: an upstream error can echo the request headers.
    console.error(
      `[ai] ${request.operation} attempt ${String(attempt)} failed: ${String(response.status)} ${redactSecrets(body.slice(0, 200), config)}`,
    );
    return {
      ok: false,
      retryAfterSeconds,
      failure: failureForStatus(response.status, body, config),
    };
  }

  let envelope: ChatCompletionResponse;
  try {
    envelope = (await response.json()) as ChatCompletionResponse;
  } catch {
    return {
      ok: false,
      retryAfterSeconds: null,
      failure: {
        ok: false,
        kind: 'malformed_json',
        error: 'The AI provider returned a response that was not JSON.',
        retryable: true,
        status: response.status,
      },
    };
  }

  const content = envelope.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return {
      ok: false,
      retryAfterSeconds: null,
      failure: {
        ok: false,
        kind: 'empty_response',
        error: 'The AI provider returned an empty answer.',
        retryable: true,
        status: response.status,
      },
    };
  }

  const json = extractJsonObject(content);
  if (json === null) {
    return {
      ok: false,
      retryAfterSeconds: null,
      failure: {
        ok: false,
        kind: 'malformed_json',
        error: 'The AI provider did not return a JSON object.',
        retryable: true,
        status: response.status,
      },
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return {
      ok: false,
      retryAfterSeconds: null,
      failure: {
        ok: false,
        kind: 'malformed_json',
        error: 'The AI provider returned JSON that could not be parsed.',
        retryable: true,
        status: response.status,
      },
    };
  }

  const promptTokens = Number(envelope.usage?.prompt_tokens);
  const completionTokens = Number(envelope.usage?.completion_tokens);

  return {
    ok: true,
    value,
    usage:
      Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
        ? { promptTokens, completionTokens }
        : null,
  };
}

/** The provider for this deployment. `configured` is false when no key is present. */
export function deepSeekProvider(): AiProvider {
  return createDeepSeekProvider();
}

/** A provider bound to an explicit configuration. For tests, and for a caller that already read it. */
export function deepSeekProviderWith(config: ProviderConfig): AiProvider {
  return createDeepSeekProvider(config);
}

/** Log-safe provider state, for a health endpoint or a startup line. */
export function aiProviderStatus(): ReturnType<typeof describeProvider> {
  return describeProvider();
}

export type { AiFailure, AiFailureKind, AiResult };
