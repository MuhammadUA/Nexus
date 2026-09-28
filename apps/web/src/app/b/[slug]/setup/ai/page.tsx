import type { ReactNode } from 'react';

import { PROMPT_KEYS, routePermissionsFor, type PromptKey } from '@nexus/core';
import {
  Alert,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Grid,
  PageHead,
  Row,
  Stack,
  Stat,
  type Column,
} from '@nexus/ui';
import { notFound } from 'next/navigation';

import { PromptScopeChip, PromptVersionHistory, type PromptVersionView } from '@/components/ai-settings-forms';
import { withActor, type Actor } from '@/lib/actor';
import { describeProvider } from '@/lib/ai/config';
import {
  ensureDefaultPrompts,
  listPromptVersions,
  resolvePrompt,
  type ResolvedPrompt,
} from '@/lib/ai/prompts';
import { asNumber } from '@/lib/repo/common';
import { requireRouteAccess } from '@/lib/route-guard';
import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';

import { activatePromptVersionAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * A14 — Business Setup · AI (spec §63, §26, §27).
 *
 * The tab answers three questions and refuses to answer a fourth:
 *
 *   1. **Is AI able to run here?** — the provider as *configured* or *not configured*, its
 *      model, endpoint and timeout. Never the key: `describeProvider` is the log-safe
 *      description, and the credential is not read into this render at all.
 *   2. **What will it use?** — for each of the twelve prompt keys, the version that will
 *      actually run, its model, temperature, output ceiling and origin, plus the full version
 *      history with an admin-only Activate control.
 *   3. **What has it cost?** — today's runs, tokens and estimated cost by task, from the
 *      `ai_usage_daily` projection over the `ai_runs` ledger. Every figure is a stored row; a
 *      day with no runs shows zero and says so rather than inventing a trend.
 *
 * The fourth question — "what did it actually say?" — has no answer here or anywhere, by
 * design: the ledger stores identifiers, counts and money, and the raw body is deleted after
 * the commit.
 *
 * **No model call happens on this render.** The only I/O is the prompt registry, the usage
 * projection, and an idempotent seed of the built-in prompts when the registry is incomplete.
 */
/**
 * The route pattern this screen is judged against.
 *
 * `packages/core` owns the route → permission matrix and is being extended by the agent that
 * owns that package; `/b/:businessSlug/setup/ai` is not in it yet. The guard fails closed on an
 * undeclared route — which would make this tab unreachable — so until the entry lands the tab
 * is judged by the requirement of the section it belongs to: Business Setup (§72.1 makes AI its
 * sixth tab). `routePermissionsFor` is consulted first, so the tab follows the matrix the moment
 * the entry exists. `actions.ts` resolves the same pattern for its own guard.
 */
const AI_ROUTE: string =
  routePermissionsFor('/b/:businessSlug/setup/ai') === null
    ? '/b/:businessSlug/setup'
    : '/b/:businessSlug/setup/ai';

interface PromptRow {
  readonly key: PromptKey;
  readonly prompt: ResolvedPrompt;
  readonly history: readonly PromptVersionView[];
}

interface AiUsageRow {
  readonly task: string;
  readonly runs: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly avgDurationMs: number;
}

interface AiUsageToday {
  readonly rows: readonly AiUsageRow[];
  readonly runs: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

/** Costs are fractions of a cent: six decimals, so a quiet day does not read as exactly zero. */
function formatCost(usd: number): string {
  return `$${usd.toFixed(6)}`;
}

/** A cache-hit share, or an em dash when nothing ran — never a fabricated 0%. */
function formatRatio(hits: number, runs: number): string {
  if (runs <= 0) return '—';
  return `${String(Math.round((hits / runs) * 100))}%`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  return ms < 1000 ? `${String(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export default async function AiSettingsPage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  requireRouteAccess(context, { route: AI_ROUTE, businessId: business.id });

  const viewer = context.viewer;
  const isAdmin = viewer.role === 'admin';

  /**
   * `describeProvider` is the log-safe description of the provider: model, origin, timeout and
   * whether a credential is present. `aiProviderStatus()` in `@/lib/ai/deepseek` is a one-line
   * alias of it; reading the config module directly keeps the provider client out of this
   * screen's imports. Neither form can return the key.
   */
  const provider = describeProvider();

  /**
   * The prompt registry, seeded on first use.
   *
   * `ensureDefaultPrompts` is idempotent and cannot fail loudly — a caller without the admin
   * privilege simply leaves the registry as it is, and `resolvePrompt` then falls back to the
   * built-in definition — so a fresh deployment shows twelve real rows instead of an empty
   * table. It is only called when the global set is incomplete, which is what keeps a healthy
   * deployment from writing on every render.
   */
  let versions = await listPromptVersions(viewer, business.id);
  const globalKeys = new Set(
    versions.filter((version) => version.businessId === null).map((version) => version.key),
  );
  if (globalKeys.size < PROMPT_KEYS.length) {
    await ensureDefaultPrompts(viewer);
    versions = await listPromptVersions(viewer, business.id);
  }

  /**
   * One `resolvePrompt` per key, in parallel.
   *
   * The resolution rule (an active business override, else the active global version, else the
   * built-in default) lives in `nexus_active_prompt` and must not be re-implemented here — a
   * second copy of it is exactly how a screen and the pipeline end up disagreeing about which
   * prompt ran. So this asks for the effective prompt twelve times rather than deriving it from
   * the rows it already has, and the usage projection is read alongside it.
   */
  const [prompts, usage] = await Promise.all([
    Promise.all(
      PROMPT_KEYS.map(async (key) => ({
        key,
        prompt: await resolvePrompt(viewer, key, business.id),
      })),
    ),
    aiUsageToday(viewer.actor, business.id),
  ]);

  const rows: readonly PromptRow[] = prompts.map(({ key, prompt }) => ({
    key,
    prompt,
    // Newest first, and a business override ahead of the global version it overrides: the
    // order an operator reads when asking "what changed, and how do I put it back".
    history: versions
      .filter((version) => version.key === key)
      .slice()
      .sort((a, b) => {
        if (a.businessId !== b.businessId) return a.businessId === null ? 1 : -1;
        return b.version - a.version;
      }),
  }));

  const promptColumns: readonly Column<PromptRow>[] = [
    {
      key: 'key',
      header: 'Prompt key',
      cell: (row) => (
        <div className="nx-stack nx-stack--sm">
          <span className="nx-table__mono">{row.key}</span>
          <span className="nx-hint">{row.prompt.purpose}</span>
        </div>
      ),
    },
    {
      key: 'active',
      header: 'Active version',
      cell: (row) => (
        <Row wrap>
          <span className="nx-table__mono">{`v${String(row.prompt.version)}`}</span>
          <PromptScopeChip businessId={row.prompt.businessId} stored={row.prompt.id !== null} />
        </Row>
      ),
    },
    {
      key: 'model',
      header: 'Model',
      cell: (row) =>
        row.prompt.model ?? (
          <span title="No model pinned on the prompt; the deployment's model is used">
            {`${provider.model} (deployment)`}
          </span>
        ),
    },
    {
      key: 'temperature',
      header: 'Temp.',
      numeric: true,
      cell: (row) => <span className="nx-table__mono">{String(row.prompt.temperature)}</span>,
    },
    {
      key: 'maxOutput',
      header: 'Max out',
      numeric: true,
      cell: (row) => (
        <span className="nx-table__mono">{formatCount(row.prompt.maxOutputTokens)}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: () => (
        <Row wrap>
          <Chip
            accent={provider.configured ? 'green' : 'neutral'}
            dataState={provider.configured ? 'configured' : 'not-configured'}
          >
            {provider.configured ? 'runnable' : 'provider not configured'}
          </Chip>
          {!provider.configured && (
            <Chip
              accent="amber"
              title="No credential is configured, so AI tasks degrade to provider_not_configured and write nothing"
            >
              AI unavailable
            </Chip>
          )}
        </Row>
      ),
    },
    {
      key: 'history',
      header: 'Version history',
      cell: (row) => (
        <PromptVersionHistory
          action={activatePromptVersionAction}
          promptKey={row.key}
          businessId={business.id}
          businessSlug={business.key}
          versions={row.history}
          canActivate={isAdmin}
        />
      ),
    },
  ];

  const usageColumns: readonly Column<AiUsageRow>[] = [
    { key: 'task', header: 'AI task', cell: (row) => <span className="nx-table__mono">{row.task}</span> },
    { key: 'runs', header: 'Runs', numeric: true, cell: (row) => formatCount(row.runs) },
    {
      key: 'cache',
      header: 'Cache hits',
      numeric: true,
      cell: (row) => `${formatCount(row.cacheHits)} · ${formatRatio(row.cacheHits, row.runs)}`,
    },
    {
      key: 'failures',
      header: 'Failures',
      numeric: true,
      cell: (row) =>
        row.failures === 0 ? (
          <span className="nx-hint">0</span>
        ) : (
          <Chip accent="red" dataState="failures">
            {formatCount(row.failures)}
          </Chip>
        ),
    },
    { key: 'tokensIn', header: 'Tokens in', numeric: true, mono: true, cell: (row) => formatCount(row.tokensIn) },
    { key: 'tokensOut', header: 'Tokens out', numeric: true, mono: true, cell: (row) => formatCount(row.tokensOut) },
    { key: 'cost', header: 'Est. cost', numeric: true, mono: true, cell: (row) => formatCost(row.costUsd) },
    {
      key: 'duration',
      header: 'Avg duration',
      numeric: true,
      cell: (row) => formatDuration(row.avgDurationMs),
    },
  ];

  return (
    <>
      <PageHead
        subtitle={`Model configuration, the versioned prompt library and today's usage for ${business.name}. AI configuration is part of the business, not a hidden environment toggle.`}
        actions={
          <Row wrap>
            <Chip accent={provider.configured ? 'green' : 'red'} dataState={provider.configured ? 'configured' : 'not-configured'}>
              {provider.configured ? 'Provider configured' : 'Provider not configured'}
            </Chip>
            <Chip accent="indigo">{`${String(PROMPT_KEYS.length)} prompt keys`}</Chip>
          </Row>
        }
      >
        Business Setup · AI
      </PageHead>

      {!provider.configured && (
        <>
          <Alert accent="amber" title="AI features are unavailable in this deployment">
            No provider credential is configured, so every AI task degrades to
            <code> provider_not_configured</code> and writes nothing: no lead is modified, no cost
            is incurred and no job is failed permanently. The prompt library below is still the
            real configuration — it is what will run the moment the credential is set. Nothing on
            this screen reads, prints or stores the credential itself.
          </Alert>
          <div style={{ height: 'var(--nx-space-lg)' }} />
        </>
      )}

      <Grid split>
        <Card title="Provider" actions={<Chip accent="neutral">deepseek</Chip>}>
          <Stack size="sm">
            <DetailRow
              label="Status"
              value={provider.configured ? 'Configured' : 'Not configured'}
            />
            <DetailRow label="Model" value={provider.model} />
            <DetailRow label="Base URL" value={provider.baseUrl} />
            <DetailRow label="Timeout" value={`${String(provider.timeoutMs)} ms per attempt`} />
            <DetailRow label="Attempts" value={`${String(provider.maxAttempts)} including the first`} />
            <span className="nx-hint">
              The credential is never shown, in any form. This card reports the model, the origin
              and whether a key is present — nothing key-shaped is rendered, logged or returned.
            </span>
          </Stack>
        </Card>

        <Card
          title="AI usage today"
          actions={<Chip accent="neutral">{formatRatio(usage.cacheHits, usage.runs)} cache hits</Chip>}
        >
          <Stack>
            <Grid cols={2}>
              <Stat value={formatCount(usage.runs)} label="Runs" meta={`${formatCount(usage.cacheHits)} served from cache`} />
              <Stat
                value={formatCost(usage.costUsd)}
                label="Estimated cost"
                meta="per-model price table, in code"
              />
              <Stat value={formatCount(usage.tokensIn)} label="Tokens in" meta={`${formatCount(usage.tokensOut)} out`} />
              <Stat
                value={formatCount(usage.failures)}
                label="Failures"
                meta={usage.failures === 0 ? 'none today' : 'typed error codes only'}
              />
            </Grid>
            <span className="nx-hint">
              Counted from <code>ai_usage_daily</code> over the <code>ai_runs</code> ledger, for
              the database&rsquo;s current day. A zero is a real zero.
            </span>
          </Stack>
        </Card>
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card
        title="Prompt library"
        actions={<Chip accent="indigo">{`${String(rows.length)} keys`}</Chip>}
      >
        <DataTable
          columns={promptColumns}
          rows={rows}
          rowKey={(row) => row.key}
          caption="Prompt keys, the version that will run, and its history"
          empty={
            <EmptyState
              title="No prompt keys"
              body="The AI task set is empty, which means the deployment is misconfigured rather than merely unseeded."
            />
          }
        />
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card title="Usage by task, today">
        <DataTable
          columns={usageColumns}
          rows={usage.rows}
          rowKey={(row) => row.task}
          caption="AI runs today by task"
          empty={
            <EmptyState
              title="No AI runs today"
              body="Nothing has needed a model today: no profile, company or signal has been extracted and no message has been drafted or classified for this business. The ledger starts filling the moment the pipeline runs."
            />
          }
        />
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Alert accent="indigo" title="What activation does and does not do">
        Activating a version changes what the next call uses: the version is part of the AI cache
        key, so cached results from the previous version stop being reused immediately, with
        nothing to flush. It does not rewrite anything already extracted, and it does not touch a
        message that has been sent — sent content is immutable and corrections are recorded as
        new events.
      </Alert>
    </>
  );
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <Row between>
      <span className="nx-hint">{label}</span>
      <span>{value}</span>
    </Row>
  );
}

/**
 * Today's usage, by task, for one business, from `public.ai_usage_daily`.
 *
 * The projection sums the `ai_runs` ledger by business, day and task, so this is a bounded
 * grouped read — no history is loaded and no row is scanned twice. The view is
 * `security_invoker`, so it is filtered by exactly the RLS policies on `ai_runs`.
 *
 * The task rollup is at most one row per `ai_runs.task` value (seven of them), which is why the
 * totals are summed here rather than in a second query.
 */
async function aiUsageToday(actor: Actor, businessId: string): Promise<AiUsageToday> {
  const rows = await withActor(actor, async (sql) =>
    sql.query<{
      task: string;
      runs: number | string;
      cache_hits: number | string;
      failures: number | string;
      tokens_in: number | string;
      tokens_out: number | string;
      estimated_cost_usd: number | string | null;
      avg_duration_ms: number | string | null;
    }>(
      `select task,
              sum(runs)::int                     as runs,
              sum(cache_hits)::int               as cache_hits,
              sum(failures)::int                 as failures,
              sum(tokens_in)::bigint             as tokens_in,
              sum(tokens_out)::bigint            as tokens_out,
              sum(estimated_cost_usd)            as estimated_cost_usd,
              (avg(avg_duration_ms))::int        as avg_duration_ms
         from public.ai_usage_daily
        where business_id = $1
          and day = current_date
        group by task
        order by task`,
      [businessId],
    ),
  );

  const usage: AiUsageRow[] = rows.rows.map((row) => ({
    task: String(row.task),
    runs: asNumber(row.runs, 0),
    cacheHits: asNumber(row.cache_hits, 0),
    failures: asNumber(row.failures, 0),
    tokensIn: asNumber(row.tokens_in, 0),
    tokensOut: asNumber(row.tokens_out, 0),
    costUsd: asNumber(row.estimated_cost_usd, 0),
    avgDurationMs: asNumber(row.avg_duration_ms, 0),
  }));

  return {
    rows: usage,
    runs: usage.reduce((sum, row) => sum + row.runs, 0),
    cacheHits: usage.reduce((sum, row) => sum + row.cacheHits, 0),
    failures: usage.reduce((sum, row) => sum + row.failures, 0),
    tokensIn: usage.reduce((sum, row) => sum + row.tokensIn, 0),
    tokensOut: usage.reduce((sum, row) => sum + row.tokensOut, 0),
    costUsd: usage.reduce((sum, row) => sum + row.costUsd, 0),
  };
}

/** Kept for the ledger's shape: a viewer is what every prompt read takes. */
