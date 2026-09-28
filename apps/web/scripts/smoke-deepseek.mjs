/**
 * One tiny live DeepSeek smoke test.
 *
 * Spec §62: "If key exists, run one tiny real smoke with capped tokens and no
 * sensitive output. If absent, use provider mocks and report
 * `PENDING_DEPLOYMENT_ENV`."
 *
 * Deliberately standalone: it does not import the application's provider module (that
 * module is `server-only` and is aliased away in tests), so this script can be run on
 * a deployment host with nothing but Node and the environment. It sends NO business
 * data — a fixed arithmetic prompt and a fixed JSON schema — so running it can never
 * leak a lead, a profile or a business brain.
 *
 * Usage:
 *   node scripts/smoke-deepseek.mjs
 *
 * Exit codes:
 *   0  the provider answered and the JSON validated (or the key is absent: PENDING)
 *   1  the provider was called and failed, or answered something unusable
 */
import { z } from 'zod';

const apiKey = (process.env.DEEPSEEK_API_KEY ?? '').trim();
const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').trim().replace(/\/+$/, '');
const model = (process.env.DEEPSEEK_MODEL ?? 'deepseek-chat').trim();

if (apiKey.length === 0) {
  console.log('PENDING_DEPLOYMENT_ENV: DEEPSEEK_API_KEY is not set on this host.');
  console.log('The V1.2 AI pipeline is exercised with provider mocks until a key exists;');
  console.log('re-run this script after the key is configured to confirm the live provider.');
  process.exit(0);
}

/** The answer must satisfy this. A smoke test that accepts any text proves nothing. */
const answerSchema = z.object({
  sum: z.number(),
});

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);

try {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      // 0 for a deterministic check; the pipeline uses 0 for extraction tasks too.
      temperature: 0,
      // Capped hard: this must cost a fraction of a cent.
      max_tokens: 32,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Reply with JSON only: {"sum": <number>}.' },
        { role: 'user', content: 'What is 2 + 2?' },
      ],
    }),
    signal: controller.signal,
  });

  const body = await response.text();

  if (!response.ok) {
    // The key is never printed; the status is what an operator needs.
    console.error(`provider_http_${String(response.status)}: ${body.slice(0, 300)}`);
    process.exitCode = 1;
  } else {
    const parsed = JSON.parse(body);
    const usage = parsed?.usage ?? {};
    const content = parsed?.choices?.[0]?.message?.content ?? '';
    const validated = answerSchema.safeParse(JSON.parse(content));

    console.log(`provider ok — model ${model}`);
    console.log(`tokens in/out: ${String(usage.prompt_tokens ?? '?')}/${String(usage.completion_tokens ?? '?')}`);
    console.log(`schema valid: ${validated.success ? 'yes' : 'no'}`);

    if (!validated.success) {
      console.error('the provider answered, but not with the schema the pipeline requires');
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`smoke_failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
