/**
 * Baseline-verification scratch helper (NOT product code).
 *
 *   node scripts/baseline-verify/db-setup.mjs
 *
 * Opens the embedded PGlite database used by apps/web, inserts the service
 * tokens needed to exercise the MCP gateway's auth/scope paths, and dumps the
 * real seeded ids the verification harness needs. Raw tokens are written to
 * `secrets.json` (git-ignored directory is not guaranteed, so this is scratch
 * only and is deleted at the end of the verification).
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..', '..', 'apps', 'web');
const dataDir = path.join(appDir, '.data', 'nexus');

// PGlite is installed in apps/web/node_modules, not at the repository root.
const appRequire = createRequire(path.join(appDir, 'package.json'));
const { pathToFileURL } = await import('node:url');
const { PGlite } = await import(pathToFileURL(appRequire.resolve('@electric-sql/pglite')).href);

const id = (group, n) =>
  `${group.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ZEMNAS = id('d0000002', 1);
const LAVISH = id('d0000002', 2);
const AI = id('d0000002', 3);

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

/**
 * Two scope vocabularies are in play, and a service token needs both:
 *
 *   1. the MCP tool scopes the gateway's `requireScope` checks
 *      (`TOOL_HANDLERS[*].scope` in src/app/api/v1/mcp/route.ts), and
 *   2. the RLS scope labels the database policies check through
 *      `is_api_client_allowed(...)` in packages/db/migrations/0013_rls.sql, which
 *      use a different naming scheme (`leads:write`, `lead_sources:write`, …).
 */
const MCP_TOOL_SCOPES = [
  'businesses:read',
  'context:read',
  'person:search',
  'company:search',
  'duplicate:check',
  'candidate:submit',
  'signal:create',
  'evidence:add',
  'lead:create',
  'lead:assign',
  'profile:capture',
  'reply:capture',
  'note:add',
  'task:create',
  'today:read',
  'research:submit',
  'message:draft',
  'agent:run',
  'agent_run:finish',
];

/** From the `is_api_client_allowed(...)` calls in 0013_rls.sql, plus the REST ingest scope. */
const RLS_SCOPES = [
  'businesses:read',
  'brain:read',
  'brain:write',
  'ingest:read',
  'ingest:write',
  'lead_sources:read',
  'lead_sources:write',
  'leads:read',
  'leads:write',
  'messages:read',
  'messages:write',
  'agent_runs:write',
];

const ALL_SCOPES = [...new Set([...MCP_TOOL_SCOPES, ...RLS_SCOPES])];

const TOKENS = [
  {
    name: 'baseline-full',
    kind: 'mcp',
    raw: 'nxs_baseline_full_0000000000000000000000000001',
    scopes: ALL_SCOPES,
    businessIds: [ZEMNAS, LAVISH, AI],
    isActive: true,
  },
  {
    name: 'baseline-narrow',
    kind: 'mcp',
    raw: 'nxs_baseline_narrow_00000000000000000000000002',
    // Deliberately missing most write scopes so scope enforcement can be proven.
    scopes: ['businesses:read', 'context:read', 'person:search', 'company:search'],
    businessIds: [ZEMNAS],
    isActive: true,
  },
  {
    name: 'baseline-otherbusiness',
    kind: 'mcp',
    raw: 'nxs_baseline_otherbiz_00000000000000000000000003',
    scopes: ALL_SCOPES,
    // Scoped to a business that exists but is NOT the one the call targets.
    businessIds: [AI],
    isActive: true,
  },
  {
    name: 'baseline-inactive',
    kind: 'mcp',
    raw: 'nxs_baseline_inactive_00000000000000000000000004',
    scopes: ALL_SCOPES,
    businessIds: [ZEMNAS],
    isActive: false,
  },
];

const db = await PGlite.create({ dataDir });
await db.exec('set row_security = off');

// ---------------------------------------------------------------- tokens ---
for (const token of TOKENS) {
  await db.query(
    `insert into public.api_clients (name, kind, token_hash, token_prefix, scopes, business_ids, is_active)
     values ($1, $2, $3, $4, $5::text[], $6::uuid[], $7)
     on conflict (token_hash) do update
       set scopes = excluded.scopes,
           business_ids = excluded.business_ids,
           is_active = excluded.is_active,
           revoked_at = null,
           expires_at = null`,
    [
      token.name,
      token.kind,
      sha256(token.raw),
      token.raw.slice(0, 12),
      token.scopes,
      token.businessIds,
      token.isActive,
    ],
  );
}

// ------------------------------------------------- fixture independence ---
/**
 * Reset the state a previous verification run left behind, so the run is repeatable.
 *
 * Two constraints make an unclean fixture produce a FALSE product failure:
 *
 *   * `browser_sessions_active_identity_key` (0010) permits exactly one ACTIVE browser session per
 *     outreach identity. A previous run's bind therefore makes the next run's `COMP-BIND-OK`
 *     answer 400 "That record already exists." — which reads like a defect and is the unique index
 *     doing its job.
 *   * the seeded demo binding (`demo-install-osama`) is deliberately KEPT: it is what the
 *     concurrency-conflict case asserts against.
 *
 * Only rows this harness itself created are released (`baseline-install-%`), so nothing the demo
 * seed owns is disturbed.
 */
const releasedStaleBindings = await db.query(
  `update public.browser_sessions
      set status = 'revoked', revoked_at = now()
    where status = 'active'
      and browser_fingerprint_or_install_id like 'baseline-install-%'
  returning id`,
);

// ------------------------------------------------------------------ ids ----
const one = async (text, params = []) => (await db.query(text, params)).rows[0] ?? null;
const many = async (text, params = []) => (await db.query(text, params)).rows;

const admin = await one(`select id, email, role from public.users where lower(email) = 'admin@nexus.local'`);

const businesses = await many(`select id, key, name from public.businesses where deleted_at is null order by key`);
const users = await many(`select id, email, role from public.users order by email`);

// Real leads, with the business they belong to, so scoping cases use real rows.
const leads = await many(
  `select l.id, l.business_id, l.status, p.full_name as person_name, l.person_id
     from public.leads l
     left join public.people p on p.id = l.person_id
    where l.deleted_at is null
    order by l.business_id, l.created_at
    limit 60`,
);

const people = await many(`select id, full_name from public.people where deleted_at is null limit 20`);
const companies = await many(`select id, name from public.companies where deleted_at is null limit 20`);

const messageInstances = await many(
  `select id, business_id, state, lead_id from public.message_instances order by created_at limit 20`,
);

const icps = await many(`select id, business_id, name from public.icps where deleted_at is null limit 20`);

const tasks = await many(`select id, business_id, lead_id, title from public.tasks limit 5`);

const identities = await many(
  `select oi.id,
          oi.platform,
          oi.display_name,
          oi.profile_url,
          oi.managed_by_user_id,
          oi.status,
          /* The businesses this identity is actually authorized for. A companion bind must use one
             of these: migration 0017 refuses a browser_session whose default_business_id is not in
             this set, so asserting against an assumed business tests the fixture, not the product. */
          coalesce(
            (select json_agg(b.key order by b.key)
               from public.outreach_identity_business_access iba
               join public.businesses b on b.id = iba.business_id
              where iba.outreach_identity_id = oi.id),
            '[]'::json
          ) as business_keys,
          coalesce(
            (select json_agg(iba.business_id::text order by iba.business_id)
               from public.outreach_identity_business_access iba
              where iba.outreach_identity_id = oi.id),
            '[]'::json
          ) as business_ids
     from public.outreach_identities oi
    order by oi.status, oi.display_name`,
);

const out = {
  generatedAt: new Date().toISOString(),
  businesses,
  users,
  admin,
  identities,
  leads,
  people,
  companies,
  messageInstances,
  icps,
  tasks,
  tokens: TOKENS.map((t) => ({ name: t.name, raw: t.raw, scopes: t.scopes, businessIds: t.businessIds, isActive: t.isActive })),
};

writeFileSync(path.join(here, 'secrets.json'), JSON.stringify(out, null, 2), 'utf8');
await db.close();

console.log(
  JSON.stringify(
    {
      ok: true,
      releasedStaleBindings: releasedStaleBindings.affectedRows ?? releasedStaleBindings.rows.length,
      businesses: businesses.length,
      users: users.length,
      leads: leads.length,
      people: people.length,
      companies: companies.length,
      messageInstances: messageInstances.length,
      icps: icps.length,
    },
    null,
    2,
  ),
);
