/**
 * The one door for every model call.
 *
 * Spec §48 is explicit that prompt construction, provider call, schema validation,
 * cache lookup and the ledger write must live behind **one** server-side entry
 * point, because the cost rules and the failure policy are only enforceable at one
 * door. This is that door.
 *
 * ## What the cache key is
 *
 * ```
 * cache key = (business_id, task, prompt_version_id ?? 0-uuid, model ?? '', input_hash)
 * ```
 *
 * — exactly the tuple the partial unique index `ai_runs_cache_key` enforces over
 * `status = 'SUCCEEDED' and cache_hit = false`. Because the prompt version and the
 * model are *in* the key, changing either invalidates the cache structurally: there
 * is no flush button to forget (spec §60.4).
 *
 * ## The order, and why it cannot be reordered
 *
 * 1. resolve the prompt (an active business override, else the global default);
 * 2. look for a `SUCCEEDED` row for that exact key. If one exists **and** the
 *    caller can materialise the answer (`loadCached`), record a `CACHED` row and
 *    return without calling the provider. If the caller has no way to rebuild the
 *    value, fall through — a cache that cannot be read is not a cache;
 * 3. otherwise insert a `PENDING` run, call the provider, then mark it
 *    `SUCCEEDED` with tokens, cost, duration and prompt version, or `FAILED` with
 *    a typed `error_code`;
 * 4. **re-validate against the schema here.** A provider is expected to validate,
 *    and `deepseek.ts` does — but the guarantee that an invalid answer can never
 *    become data must not depend on which provider was injected;
 * 5. nothing in this module stores or logs a request or a response body. The
 *    ledger has no column for one, and an upstream error is passed through
 *    `redactSecrets` before it reaches a caller.
 */
import 'server-only';

import { createHash } from 'node:crypto';

import { canonicalJson, type AiTaskType, type PromptKey } from '@nexus/core';
import type { z } from 'zod';

import { withActor, type ActorCarrier } from '../actor';
import type { Db } from '../sql';
import { describeDbError } from '../repo/common';
import { redactSecrets } from './config';
import { deepSeekProvider } from './deepseek';
import { resolvePrompt, type ResolvedPrompt } from './prompts';
import type { AiFailureKind, AiProvider } from './types';

/** The all-zero uuid stands in for "no prompt version" in the cache key. */
export const NO_PROMPT_VERSION = '00000000-0000-0000-0000-000000000000';

export interface AiRunContext {
  readonly businessId: string;
  readonly task: AiTaskType;
  readonly promptKey: PromptKey;
  readonly leadId?: string | null;
  readonly personId?: string | null;
  readonly companyId?: string | null;
  readonly agentJobId?: string | null;
  readonly messageInstanceId?: string | null;
}

export interface AiRunUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export type AiRunFailureCode = AiFailureKind | 'cache_miss_write_failed';

export type AiRunOutcome<T> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly cached: boolean;
      readonly runId: string;
      readonly model: string;
      readonly promptVersionId: string | null;
      readonly usage: AiRunUsage | null;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly errorCode: AiRunFailureCode;
      readonly retryable: boolean;
      readonly runId: string | null;
    };

export interface AiTaskRequest<T> {
  /** Caller-supplied, from the *normalised* input only (never from row order). */
  readonly inputHash: string;
  readonly schema: z.ZodTypeAny;
  readonly build: (prompt: ResolvedPrompt) => { readonly system: string; readonly user: string };
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** How a cache hit is turned back into a value. Absent means "cannot reuse". */
  readonly loadCached?: () => Promise<T | null>;
  /** Injectable so a test drives the whole path without a network call. */
  readonly provider?: AiProvider;
}

/**
 * Canonical JSON + SHA-256.
 *
 * Key order is normalised (`canonicalJson` sorts recursively), so two fact sets
 * that differ only in the order their rows were read hash identically — which is
 * what makes "changed facts invalidate the cache" mean *changed facts* rather than
 * *changed query plan*.
 */
export function hashAiInput(parts: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(parts)).digest('hex')}`;
}

/**
 * Per-model prices, in USD per million tokens. Held in code, not in the database
 * (spec §61.5): a price change is a deploy, and it cannot then silently disagree
 * with the arithmetic that produced a stored cost.
 */
const MODEL_PRICES: Readonly<Record<string, { readonly inputPerM: number; readonly outputPerM: number }>> = {
  'deepseek-chat': { inputPerM: 0.27, outputPerM: 1.1 },
  'deepseek-reasoner': { inputPerM: 0.55, outputPerM: 2.19 },
};

/**
 * Estimated cost, or null when it cannot be estimated.
 *
 * Null rather than zero for an unknown model: a zero would read as "this call was
 * free", which is a worse lie than "we do not know what this cost".
 */
export function estimateCostUsd(
  model: string,
  tokensIn: number | null,
  tokensOut: number | null,
): number | null {
  const price = MODEL_PRICES[model];
  if (price === undefined) return null;
  if (tokensIn === null && tokensOut === null) return null;
  const cost = ((tokensIn ?? 0) * price.inputPerM + (tokensOut ?? 0) * price.outputPerM) / 1_000_000;
  // `estimated_cost_usd` is numeric(12,6).
  return Math.round(cost * 1_000_000) / 1_000_000;
}

type CachedRunRow = {
  id: string;
  model: string | null;
  prompt_version_id: string | null;
}

const CACHE_KEY_PREDICATE = `
  r.business_id = $1
  and r.task = $2
  and r.status = 'SUCCEEDED'
  and r.cache_hit = false
  and coalesce(r.prompt_version_id, '${NO_PROMPT_VERSION}'::uuid) = coalesce($3::uuid, '${NO_PROMPT_VERSION}'::uuid)
  and coalesce(r.model, '') = $4
  and r.input_hash = $5
`;

function ledgerColumns(ctx: AiRunContext): readonly unknown[] {
  return [
    ctx.businessId,
    ctx.task,
    ctx.leadId ?? null,
    ctx.personId ?? null,
    ctx.companyId ?? null,
    ctx.agentJobId ?? null,
    ctx.messageInstanceId ?? null,
  ];
}

const LEDGER_INSERT = `
  insert into public.ai_runs
    (business_id, task, lead_id, person_id, company_id, agent_job_id, message_instance_id,
     provider, model, prompt_key, prompt_version_id, prompt_version, input_hash, status,
     cache_hit, tokens_in, tokens_out, estimated_cost_usd, duration_ms, attempt, completed_at)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, now())
`;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

export async function runAiTask<T>(
  viewer: ActorCarrier,
  ctx: AiRunContext,
  request: AiTaskRequest<T>,
): Promise<AiRunOutcome<T>> {
  try {
    // 1. Resolve the prompt. Nothing is called until this is known, because the
    //    version is part of the cache key.
    const prompt = await resolvePrompt(viewer, ctx.promptKey, ctx.businessId);
    const provider = request.provider ?? deepSeekProvider();
    const model = prompt.model ?? provider.model;
    const promptVersionId = prompt.id;
    const temperature = request.temperature ?? prompt.temperature;
    const maxOutputTokens = request.maxOutputTokens ?? prompt.maxOutputTokens;

    // 2. Cache lookup on the exact key.
    const cachedRun = await withActor(viewer.actor, async (sql) =>
      findCachedRun(sql, ctx, promptVersionId, model, request.inputHash),
    );

    if (cachedRun !== null && request.loadCached !== undefined) {
      let materialised: T | null = null;
      try {
        materialised = await request.loadCached();
      } catch (error) {
        // A cache that cannot be read is not a cache. Falling through to the
        // provider is the correct behaviour; the alternative is failing a task
        // because a derived row is missing.
        console.error(
          `[ai] ${ctx.task} cache read failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }

      if (materialised !== null) {
        const inserted = await withActor(viewer.actor, async (sql) => {
          const result = await sql.query<{ id: string }>(
            `${LEDGER_INSERT}`,
            [
              ...ledgerColumns(ctx),
              provider.name,
              model,
              ctx.promptKey,
              promptVersionId,
              prompt.version,
              request.inputHash,
              'CACHED',
              true,
              0,
              0,
              0,
              0,
              1,
            ],
          );
          return result.rows[0]?.id ?? cachedRun.id;
        });

        return {
          ok: true,
          data: materialised,
          cached: true,
          runId: String(inserted),
          model,
          promptVersionId,
          usage: null,
        };
      }
    }

    // 3. A real attempt: record it as PENDING before the call, so a crash mid-call
    //    leaves a visible in-flight row rather than nothing at all.
    const pendingId = await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `insert into public.ai_runs
           (business_id, task, lead_id, person_id, company_id, agent_job_id, message_instance_id,
            provider, model, prompt_key, prompt_version_id, prompt_version, input_hash, status,
            cache_hit, attempt)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'PENDING', false, 1)
         on conflict do nothing
         returning id`,
        [
          ...ledgerColumns(ctx),
          provider.name,
          model,
          ctx.promptKey,
          promptVersionId,
          prompt.version,
          request.inputHash,
        ],
      );
      return result.rows[0]?.id ?? null;
    });

    if (pendingId === null) {
      return {
        ok: false,
        error: 'The AI usage ledger could not be written, so no model call was made.',
        errorCode: 'cache_miss_write_failed',
        retryable: true,
        runId: null,
      };
    }

    const built = request.build(prompt);
    const startedAt = Date.now();
    const result = await provider.complete({
      system: built.system,
      user: built.user,
      schema: request.schema,
      promptVersionId,
      operation: ctx.task.toLowerCase(),
      temperature,
      maxTokens: maxOutputTokens,
    });
    const durationMs = Date.now() - startedAt;

    if (!result.ok) {
      await withActor(viewer.actor, async (sql) => {
        await sql.query(
          `update public.ai_runs
              set status = 'FAILED', error_code = $2, duration_ms = $3, completed_at = now()
            where id = $1`,
          [pendingId, result.kind, durationMs],
        );
      });

      return {
        ok: false,
        // The operator sentence, with anything key-shaped removed. The upstream
        // body is never returned and never stored.
        error: redactSecrets(result.error),
        errorCode: result.kind,
        retryable: result.retryable,
        runId: String(pendingId),
      };
    }

    // 4. Validate here as well. A caller's schema is the contract; a provider that
    //    skipped the check must not be able to write unvalidated data.
    const parsed = request.schema.safeParse(result.data);
    if (!parsed.success) {
      const code = 'schema_invalid';
      await withActor(viewer.actor, async (sql) => {
        await sql.query(
          `update public.ai_runs
              set status = 'FAILED', error_code = $2, duration_ms = $3, completed_at = now()
            where id = $1`,
          [pendingId, code, durationMs],
        );
      });
      return {
        ok: false,
        error: 'The AI provider returned data that did not match the required shape, so it was discarded.',
        errorCode: code,
        // A model that emitted invalid JSON once sometimes does not the second
        // time; the attempt policy in `deepseek.ts` is what stops it spinning.
        retryable: true,
        runId: String(pendingId),
      };
    }

    const usage: AiRunUsage | null = result.provenance.usage ?? null;
    const tokensIn = usage?.promptTokens ?? null;
    const tokensOut = usage?.completionTokens ?? null;
    const cost = estimateCostUsd(result.provenance.model, tokensIn, tokensOut);

    const finalStatus = await markRunSucceeded(viewer, {
      runId: String(pendingId),
      ctx,
      promptVersionId,
      model,
      inputHash: request.inputHash,
      tokensIn,
      tokensOut,
      cost,
      durationMs,
    });

    return {
      ok: true,
      data: parsed.data as T,
      // A concurrent processor recorded the identical answer first, so the ledger
      // holds this attempt as a reuse. It is not a cache hit: the provider *was*
      // called, and the tokens are recorded as spent.
      cached: finalStatus === 'CACHED',
      runId: String(pendingId),
      model,
      promptVersionId,
      usage,
    };
  } catch (error) {
    // A database failure (RLS, a constraint, a lost connection) is reported as a
    // typed, retryable outcome rather than thrown at a route handler that would
    // turn it into a 500 with no explanation.
    return {
      ok: false,
      error: describeDbError(error, 'runAiTask'),
      errorCode: 'cache_miss_write_failed',
      retryable: true,
      runId: null,
    };
  }
}

async function findCachedRun(
  sql: Db,
  ctx: AiRunContext,
  promptVersionId: string | null,
  model: string,
  inputHash: string,
): Promise<CachedRunRow | null> {
  const result = await sql.query<CachedRunRow>(
    `select r.id, r.model, r.prompt_version_id
       from public.ai_runs r
      where ${CACHE_KEY_PREDICATE}
      order by r.created_at desc
      limit 1`,
    [ctx.businessId, ctx.task, promptVersionId, model, inputHash],
  );
  return result.rows[0] ?? null;
}

interface MarkSucceededInput {
  readonly runId: string;
  readonly ctx: AiRunContext;
  readonly promptVersionId: string | null;
  readonly model: string;
  readonly inputHash: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly cost: number | null;
  readonly durationMs: number;
}

/**
 * Marks the run `SUCCEEDED` — or `CACHED` when an identical successful run already
 * exists.
 *
 * The guard is inside the statement: if a duplicate `SUCCEEDED` row is already
 * visible the row becomes `CACHED` and the unique index is never violated. Two
 * processors that both finished the same call and both passed the guard at the
 * same instant is still possible, so a `23505` earns exactly one retry, by which
 * time the winner has committed and the guard succeeds.
 */
async function markRunSucceeded(
  viewer: ActorCarrier,
  input: MarkSucceededInput,
): Promise<'SUCCEEDED' | 'CACHED'> {
  const sqlText = `
    with duplicate as (
      select 1
        from public.ai_runs r
       where ${CACHE_KEY_PREDICATE}
         and r.id <> $6
    )
    update public.ai_runs r
       set status = case when exists (select 1 from duplicate) then 'CACHED' else 'SUCCEEDED' end,
           cache_hit = exists (select 1 from duplicate),
           tokens_in = $7::int,
           tokens_out = $8::int,
           estimated_cost_usd = $9::numeric,
           duration_ms = $10::int,
           completed_at = now()
     where r.id = $6
    returning r.status
  `;
  const params: readonly unknown[] = [
    input.ctx.businessId,
    input.ctx.task,
    input.promptVersionId,
    input.model,
    input.inputHash,
    input.runId,
    input.tokensIn,
    input.tokensOut,
    input.cost,
    input.durationMs,
  ];

  const attempt = async (): Promise<'SUCCEEDED' | 'CACHED'> =>
    withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ status: string }>(sqlText, params);
      return result.rows[0]?.status === 'CACHED' ? 'CACHED' : 'SUCCEEDED';
    });

  try {
    return await attempt();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return await attempt();
  }
}
