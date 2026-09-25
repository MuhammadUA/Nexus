/**
 * DeepSeek provider transport.
 *
 * `fetch` is stubbed, so these are tests of *this* code's behaviour and not of DeepSeek's
 * availability: what it sends, how it reacts to each class of failure, whether it retries the right
 * things and only the right things, whether a schema violation can ever escape, and whether a key
 * can end up in a log line.
 *
 * The failure taxonomy is the contract callers branch on, so almost every case here asserts the
 * exact `kind` rather than just "it failed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { backoffMs, deepSeekProvider, deepSeekProviderWith, extractJsonObject } from '@/lib/ai/deepseek';
import { redactSecrets, type ProviderConfig } from '@/lib/ai/config';

const TEST_KEY = 'sk-test-0123456789abcdefghijklmnop';

/** A configuration with a tiny backoff so retry tests do not sleep for real seconds. */
function testConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    configured: true,
    missing: null,
    apiKey: TEST_KEY,
    baseUrl: 'https://api.deepseek.test',
    model: 'deepseek-chat',
    timeoutMs: 50,
    maxAttempts: 3,
    retryBaseMs: 1,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** An OpenAI-compatible success envelope wrapping `content`. */
function completion(content: string, usage: { prompt_tokens?: number; completion_tokens?: number } = {}): Response {
  return jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }], usage });
}

const personSchema = z.object({ name: z.string().min(1), company: z.string().nullable() }).strict();

function request<Schema extends z.ZodTypeAny>(schema: Schema, overrides: Record<string, unknown> = {}) {
  return {
    system: 'You extract structured facts.',
    user: 'Ada Lovelace, Analytical Engine.',
    schema,
    promptVersionId: 'pv-1',
    operation: 'profile_extraction',
    ...overrides,
  };
}

/**
 * Queued responses; the last one repeats, so "always 429" needs a single entry.
 *
 * Each entry is *cloned* before being handed out. A `Response` body is single-use, so returning the
 * same object for two attempts made the second attempt fail while reading the body and silently
 * turned a schema test into a malformed-JSON test.
 */
function queueFetch(responses: readonly (Response | Error | (() => Promise<Response>))[]): ReturnType<typeof vi.fn> {
  let index = 0;
  const mock = vi.fn(async (_url: string, _init: RequestInit) => {
    const entry = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (entry === undefined) throw new Error('no stubbed response');
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'function') return entry();
    return entry.clone();
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  delete process.env.DEEPSEEK_API_KEY;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
  delete process.env.DEEPSEEK_API_KEY;
});

describe('extractJsonObject', () => {
  it('returns a bare object unchanged', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('unwraps a ```json fence', () => {
    const answer = '```json\n{"a":1,"b":"two"}\n```';
    expect(extractJsonObject(answer)).toBe('{"a":1,"b":"two"}');
  });

  it('ignores prose before and after the object', () => {
    const answer = 'Sure! Here is the JSON:\n{"a":1}\nLet me know if you need anything else.';
    expect(extractJsonObject(answer)).toBe('{"a":1}');
  });

  it('does not stop at a brace inside a string literal', () => {
    // A regex-based extractor truncates here. This is the case that motivates the scanner.
    const answer = '{"note":"use {curly} braces","ok":true}';
    expect(extractJsonObject(answer)).toBe(answer);
  });

  it('handles an escaped quote inside a string', () => {
    const answer = '{"note":"he said \\"hi\\"","ok":true}';
    expect(extractJsonObject(answer)).toBe(answer);
  });

  it('returns null when the model was cut off mid-object', () => {
    expect(extractJsonObject('{"a":1,"b":')).toBeNull();
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractJsonObject('I cannot help with that request.')).toBeNull();
  });

  it('extracts an array when that is what was asked for', () => {
    expect(extractJsonObject('here: [1,2,{"a":3}]')).toBe('[1,2,{"a":3}]');
  });
});

describe('backoffMs', () => {
  it('grows exponentially from the base', () => {
    expect(backoffMs(1, 500, null)).toBe(500);
    expect(backoffMs(2, 500, null)).toBe(1000);
    expect(backoffMs(3, 500, null)).toBe(2000);
  });

  it('caps the exponential growth so an outage cannot park a request', () => {
    expect(backoffMs(10, 500, null)).toBe(8000);
  });

  it('prefers Retry-After when the provider sends one', () => {
    expect(backoffMs(1, 500, 2)).toBe(2000);
  });

  it('caps a provider that asks for an implausibly long wait', () => {
    expect(backoffMs(1, 500, 3600)).toBe(30_000);
  });
});

describe('unconfigured provider', () => {
  it('reports itself unconfigured without a key', () => {
    expect(deepSeekProvider().configured).toBe(false);
  });

  it('fails typed, and never touches the network', async () => {
    const mock = queueFetch([completion('{}')]);
    const result = await deepSeekProvider().complete(request(personSchema));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('provider_not_configured');
    expect(result.retryable).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });

  it('becomes configured when the key is present', () => {
    process.env.DEEPSEEK_API_KEY = TEST_KEY;
    const provider = deepSeekProvider();
    expect(provider.configured).toBe(true);
    expect(provider.model).toBe('deepseek-chat');
  });
});

describe('a successful completion', () => {
  it('returns validated data with provenance', async () => {
    const mock = queueFetch([
      completion('{"name":"Ada Lovelace","company":null}', { prompt_tokens: 120, completion_tokens: 18 }),
    ]);

    const result = await deepSeekProviderWith(testConfig()).complete(request(personSchema));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ name: 'Ada Lovelace', company: null });
    expect(result.provenance.provider).toBe('deepseek');
    expect(result.provenance.model).toBe('deepseek-chat');
    expect(result.provenance.promptVersionId).toBe('pv-1');
    expect(result.provenance.attempts).toBe(1);
    expect(result.provenance.usage).toEqual({ promptTokens: 120, completionTokens: 18 });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('sends the documented request shape', async () => {
    const mock = queueFetch([completion('{"name":"A","company":null}')]);
    await deepSeekProviderWith(testConfig()).complete(request(personSchema, { maxTokens: 512, temperature: 0 }));

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.test/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TEST_KEY}`);

    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: { role: string; content: string }[];
      response_format: { type: string };
      stream: boolean;
      max_tokens?: number;
      temperature: number;
    };
    expect(body.model).toBe('deepseek-chat');
    expect(body.stream).toBe(false);
    // JSON mode is requested, but the schema check is what actually guarantees the shape.
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages).toEqual([
      { role: 'system', content: 'You extract structured facts.' },
      { role: 'user', content: 'Ada Lovelace, Analytical Engine.' },
    ]);
    expect(body.max_tokens).toBe(512);
    expect(body.temperature).toBe(0);
  });

  it('tolerates a model that fences its JSON in prose', async () => {
    queueFetch([completion('Here you go:\n```json\n{"name":"Ada","company":"Analytical"}\n```')]);
    const result = await deepSeekProviderWith(testConfig()).complete(request(personSchema));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe('Ada');
  });

  it('reports usage as null when the provider omits it', async () => {
    queueFetch([completion('{"name":"A","company":null}')]);
    const result = await deepSeekProviderWith(testConfig()).complete(request(personSchema));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.usage).toBeNull();
  });
});

describe('schema enforcement', () => {
  it('refuses valid JSON that violates the schema', async () => {
    // `name` is required and non-empty. This must NOT reach the caller.
    queueFetch([completion('{"company":"Analytical"}')]);
    const result = await deepSeekProviderWith(testConfig({ maxAttempts: 1 })).complete(request(personSchema));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('schema_invalid');
    expect(result.issues?.some((issue) => issue.startsWith('name'))).toBe(true);
  });

  it('refuses a JSON object of the wrong type', async () => {
    queueFetch([completion('[]')]);
    const result = await deepSeekProviderWith(testConfig({ maxAttempts: 1 })).complete(request(personSchema));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('schema_invalid');
  });

  it('retries a schema violation exactly once, then succeeds', async () => {
    const mock = queueFetch([completion('{"company":"x"}'), completion('{"name":"Ada","company":null}')]);
    const result = await deepSeekProviderWith(testConfig()).complete(request(personSchema));

    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Provenance records the second attempt, so a stored row can be reconciled with the log.
    expect(result.provenance.attempts).toBe(2);
  });

  it('does not spin when the model is systematically wrong', async () => {
    // maxAttempts is 3, but a schema violation earns only one extra try: two calls, then stop.
    const mock = queueFetch([completion('{"company":"x"}')]);
    const result = await deepSeekProviderWith(testConfig()).complete(request(personSchema));

    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('schema_invalid');
  });
});

describe('malformed provider output', () => {
  it('classifies an unparseable JSON fragment as malformed_json, not schema_invalid', async () => {
    // Two distinct causes with distinct handling: a truncated answer may succeed on retry, whereas
    // a wrongly-shaped answer needs a different prompt.
    queueFetch([completion('{"name": "Ada", "company":')]);
    const result = await deepSeekProviderWith(testConfig({ maxAttempts: 1 })).complete(request(personSchema));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('malformed_json');
  });

  it('classifies a prose-only answer as malformed_json', async () => {
    queueFetch([completion('I am unable to extract any facts from this text.')]);
    const result = await deepSeekProviderWith(testConfig({ maxAttempts: 1 })).complete(request(personSchema));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('malformed_json');
  });

  it('classifies an empty answer as empty_response', async () => {
    queueFetch([completion('')]);
    const result = await deepSeekProviderWith(testConfig({ maxAttempts: 1 })).complete(request(personSchema));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('empty_response');
  });

  it('retries malformed JSON and succeeds on the second attempt', async () => {
    const mock = queueFetch([completion('nope'), completion('{"name":"Ada","company":null}')]);
    const result = await deepSeekProviderWith(testConfig()).complete(request(personSchema));

    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });
});

describe('HTTP failures', () => {
  it('does not retry an authentication failure', async () => {
    const mock = queueFetch([jsonResponse({ error: 'invalid key' }, { status: 401 })]);
    const result = await deepSeekProviderWith(testConfig()).complete(request(personSchema));

    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unauthorized');
    expect(result.retryable).toBe(false);
  });

  it('does not retry a rejected request', async () => {
    const mock = queueFetch([jsonResponse({ error: 'context too long' }, { status: 400 })]);
    const result = await deepSeekProviderWith(testConfig()).complete(request(personSchema));

    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('invalid_request');
    expect(result.retryable).toBe(false);
  });

  it('retries a rate limit and succeeds once the provider recovers', async () => {
    const mock = queueFetch([
      jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '0' } }),
      completion('{"name":"Ada","company":null}'),
    ]);
    const result = await deepSeekProviderWith(testConfig()).complete(request(personSchema));

    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('gives up after the attempt budget on a persistent rate limit', async () => {
    const mock = queueFetch([jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '0' } })]);
    const result = await deepSeekProviderWith(testConfig({ maxAttempts: 3 })).complete(request(personSchema));

    expect(mock).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rate_limited');
    expect(result.retryable).toBe(true);
  });

  it('retries a 5xx as provider_unavailable', async () => {
    const mock = queueFetch([jsonResponse({ error: 'boom' }, { status: 503 }), completion('{"name":"Ada","company":null}')]);
    const result = await deepSeekProviderWith(testConfig()).complete(request(personSchema));

    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('fails typed after exhausting retries on a 5xx', async () => {
    queueFetch([jsonResponse({ error: 'boom' }, { status: 500 })]);
    const result = await deepSeekProviderWith(testConfig({ maxAttempts: 2 })).complete(request(personSchema));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('provider_unavailable');
    expect(result.retryable).toBe(true);
  });
});

describe('transport failures', () => {
  it('retries a timeout and succeeds once the provider responds', async () => {
    // A fetch that only settles when the request is aborted, so the real timeout path is exercised
    // rather than a rejection being mistaken for one. The queue helper cannot pass `init` through,
    // so this case stubs directly and counts attempts.
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        }
        return completion('{"name":"Ada","company":null}');
      }),
    );

    const result = await deepSeekProviderWith(testConfig({ timeoutMs: 20 })).complete(request(personSchema));

    expect(calls).toBe(2);
    // Attempt 2 succeeds, so the timeout was retried rather than surfaced.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.attempts).toBe(2);
  });

  it('surfaces a timeout as a typed failure when every attempt times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      ),
    );

    const result = await deepSeekProviderWith(testConfig({ timeoutMs: 20, maxAttempts: 2 })).complete(
      request(personSchema),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  it('treats a connection error as provider_unavailable', async () => {
    queueFetch([new Error('ECONNREFUSED')]);
    const result = await deepSeekProviderWith(testConfig({ maxAttempts: 1 })).complete(request(personSchema));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('provider_unavailable');
  });
});

describe('secret hygiene', () => {
  it('never puts the API key in a log line, even if the provider echoes it', async () => {
    // An upstream 400 that echoes the request is the realistic leak path.
    queueFetch([jsonResponse({ error: `bad request for Bearer ${TEST_KEY}` }, { status: 400 })]);
    await deepSeekProviderWith(testConfig({ maxAttempts: 1 })).complete(request(personSchema));

    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(TEST_KEY);
    expect(logged).toContain('[redacted');
  });

  it('never puts the API key in a returned error', async () => {
    queueFetch([jsonResponse({ error: `rejected ${TEST_KEY}` }, { status: 400 })]);
    const result = await deepSeekProviderWith(testConfig({ maxAttempts: 1 })).complete(request(personSchema));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain(TEST_KEY);
  });

  it('redacts a key that is not the configured one', () => {
    const other = 'sk-abcdefghijklmnopqrstuvwx';
    expect(redactSecrets(`leaked ${other}`, testConfig())).not.toContain(other);
  });
});
