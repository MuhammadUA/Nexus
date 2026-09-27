/**
 * Diagnostic: reproduce the service-token RLS failures against the embedded DB
 * directly, so the failing policy and the GUC state are both observable.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..', '..', 'apps', 'web');
const appRequire = createRequire(path.join(appDir, 'package.json'));
const { PGlite } = await import(pathToFileURL(appRequire.resolve('@electric-sql/pglite')).href);

const secrets = JSON.parse(readFileSync(path.join(here, 'secrets.json'), 'utf8'));
const ZEMNAS = secrets.businesses.find((b) => b.key === 'zemnas').id;

const db = await PGlite.create({ dataDir: path.join(appDir, '.data', 'nexus') });

const client = (
  await db.query(`select id, name from public.api_clients where name = 'baseline-full'`)
).rows[0];
console.log('api_client row:', client);

// Replicate withActor's transaction prologue for an api_client actor.
async function withApiClient(fn) {
  await db.exec('begin');
  try {
    await db.exec('set local role authenticated');
    await db.exec(`select set_config('request.jwt.claims', '{}', true)`);
    await db.exec(`select set_config('nexus.api_client_id', '${client.id}', true)`);
    const out = await fn();
    await db.exec('commit');
    return out;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

try {
  const state = await withApiClient(async () => {
    const r = await db.query(
      `select public.acting_api_client_id() as api_client,
              public.current_user_id() as user_id,
              public.is_admin() as is_admin,
              public.has_business_access($1) as has_access,
              public.api_client_scopes() as scopes,
              public.api_client_business_ids() as bizes,
              public.is_api_client_allowed($1, 'lead_sources:write') as allowed_lead_sources,
              current_setting('nexus.api_client_id', true) as guc`,
      [ZEMNAS],
    );
    return r.rows[0];
  });
  console.log('session state:', JSON.stringify(state, null, 2));

  for (const [label, sql, params] of [
    ['companies insert', `insert into public.companies (name, normalized_name, created_by) values ($1,$2,null) returning id`, ['Diag Co', 'diag-co']],
    ['signals insert', `insert into public.signals (business_id, kind, polarity, strength, label, observed_at) values ($1,'hiring','positive',10,'diag',now()) returning id`, [ZEMNAS]],
    ['source_evidence insert', `insert into public.source_evidence (business_id, source, raw_text_or_json, content_hash, observed_at, confidence) values ($1,'diag','{}','diaghash123',now(),0.5) returning id`, [ZEMNAS]],
    ['agent_runs insert', `insert into public.agent_runs (business_id, api_client_id, agent_name, state, finished_at, summary, result, stats) values ($1, public.acting_api_client_id(), 'diag','completed', now(), 'x', '{}'::jsonb, '{}'::jsonb) returning id`, [ZEMNAS]],
  ]) {
    try {
      const r = await withApiClient(async () => (await db.query(sql, params)).rows[0]);
      console.log(`OK   ${label}:`, r);
    } catch (error) {
      console.log(`FAIL ${label}: code=${error.code} constraint=${error.constraint} message=${error.message}`);
    }
  }

  // Evaluate each predicate the companies_insert policy depends on, and count the
  // policy roles, so "which term is false" is decided by observation.
  const probes = await withApiClient(async () => {
    const r = await db.query(
      `select
         (public.acting_api_client_id() is not null)                                as api_client_ok,
         public.is_admin()                                                          as is_admin,
         (select count(*)::int from public.user_business_access a
            where a.user_id = public.current_user_id() and a.can_use_lead_sources)  as user_lead_source_rows,
         (select count(*)::int from public.api_clients)                             as visible_api_clients,
         (select count(*)::int from public.businesses)                              as visible_businesses`,
    );
    return r.rows[0];
  });
  console.log('PROBES ' + JSON.stringify(probes));

  // Evaluate the exact companies_insert predicate terms as the authenticated role.
  const terms = await withApiClient(async () => {
    const r = await db.query(
      `select
         (public.is_admin()
          or exists (select 1 from public.user_business_access a
                      where a.user_id = public.current_user_id() and a.can_use_lead_sources)
          or public.acting_api_client_id() is not null) as companies_insert_predicate,
         current_user as current_role,
         current_setting('role') as role_setting`,
    );
    return r.rows[0];
  });
  console.log('TERMS ' + JSON.stringify(terms));

  const catalog = await withApiClient(async () => {
    const r = await db.query(
      `select c.relname, pg_catalog.pg_get_userbyid(c.relowner) as owner,
              c.relrowsecurity as enabled, c.relforcerowsecurity as forced
         from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname in ('companies','signals','source_evidence')
        order by c.relname`,
    );
    return r.rows;
  });
  console.log('CATALOG ' + JSON.stringify(catalog));

  // Isolate the term that actually refuses the INSERT: run variants that each make
  // exactly one predicate term true.
  const variants = [
    {
      label: 'as table owner (postgres), no role switch',
      run: async () => {
        await db.exec('begin');
        try {
          await db.exec(`select set_config('request.jwt.claims', '{}', true)`);
          await db.exec(`select set_config('nexus.api_client_id', '${client.id}', true)`);
          const r = await db.query(`insert into public.companies (name, normalized_name) values ('diag-owner','diag-owner') returning id`);
          await db.exec('commit');
          return r.rows[0];
        } catch (e) {
          await db.exec('rollback');
          throw e;
        }
      },
    },
    {
      label: 'as authenticated, acting_api_client_id set (repeat)',
      run: () => withApiClient(async () => (await db.query(`insert into public.companies (name, normalized_name) values ('diag-auth','diag-auth') returning id`)).rows[0]),
    },
    {
      label: 'as authenticated, is_admin via claims (admin user)',
      run: async () => {
        const admin = (await db.query(`select id from public.users where email='admin@nexus.local'`)).rows[0].id;
        await db.exec('begin');
        try {
          await db.exec('set local role authenticated');
          await db.exec(`select set_config('request.jwt.claims', '{"sub":"${admin}","role":"authenticated"}', true)`);
          await db.exec(`select set_config('nexus.api_client_id', '', true)`);
          const r = await db.query(`insert into public.companies (name, normalized_name) values ('diag-admin','diag-admin') returning id`);
          await db.exec('commit');
          return r.rows[0];
        } catch (e) {
          await db.exec('rollback');
          throw e;
        }
      },
    },
  ];
  for (const v of variants) {
    try {
      console.log(`VARIANT OK   ${v.label}: ` + JSON.stringify(await v.run()));
    } catch (e) {
      console.log(`VARIANT FAIL ${v.label}: code=${e.code} message=${e.message}`);
    }
  }

  // Is there a user-scoped policy that also applies (permissive OR)?
  // Check whether `row_security` is OFF for this session: OFF makes policies
  // *not* filter (owner path), while FORCE RLS still applies them to non-owners.
  const rs = await withApiClient(async () => {
    const r = await db.query(`select current_setting('row_security', true) as row_security`);
    return r.rows[0];
  });
  console.log('ROW_SECURITY ' + JSON.stringify(rs));

  await db.exec(`set row_security = on`);
  try {
    const r = await withApiClient(async () => (await db.query(`insert into public.companies (name, normalized_name) values ('diag-rs-on','diag-rs-on') returning id`)).rows[0]);
    console.log('RS_ON OK   ' + JSON.stringify(r));
  } catch (e) {
    console.log(`RS_ON FAIL code=${e.code} message=${e.message}`);
  }

  // Decisive: does an INSERT policy whose only term is `acting_api_client_id() is not null`
  // work, on a table that already carries the standard grants?
  await db.exec(`create table if not exists public.diag_probe (id uuid primary key default gen_random_uuid(), label text)`);
  await db.exec(`grant select, insert, update, delete on public.diag_probe to authenticated`);
  await db.exec(`alter table public.diag_probe enable row level security`);
  await db.exec(`alter table public.diag_probe force row level security`);
  await db.exec(`drop policy if exists diag_probe_insert on public.diag_probe`);
  await db.exec(`drop policy if exists diag_probe_select on public.diag_probe`);
  await db.exec(`create policy diag_probe_insert on public.diag_probe for insert to authenticated
                   with check (public.acting_api_client_id() is not null)`);
  await db.exec(`create policy diag_probe_select on public.diag_probe for select to authenticated
                   using (public.acting_api_client_id() is not null)`);
  try {
    const r = await withApiClient(async () => (await db.query(`insert into public.diag_probe (label) values ('x') returning id`)).rows[0]);
    console.log('MINIMAL OK   acting_api_client_id-only INSERT policy accepted: ' + JSON.stringify(r));
  } catch (e) {
    console.log(`MINIMAL FAIL acting_api_client_id-only INSERT policy refused: code=${e.code} message=${e.message}`);
  }
  await db.exec(`drop table if exists public.diag_probe`);

  // And the same minimal policy but keyed on request.jwt.claims instead of the custom GUC.
  await db.exec(`create table if not exists public.diag_probe2 (id uuid primary key default gen_random_uuid(), label text)`);
  await db.exec(`grant select, insert on public.diag_probe2 to authenticated`);
  await db.exec(`alter table public.diag_probe2 enable row level security`);
  await db.exec(`alter table public.diag_probe2 force row level security`);
  await db.exec(`create policy diag_probe2_insert on public.diag_probe2 for insert to authenticated
                   with check (public.current_user_id() is not null or public.acting_api_client_id() is not null)`);
  try {
    const r = await withApiClient(async () => (await db.query(`insert into public.diag_probe2 (label) values ('x') returning id`)).rows[0]);
    console.log('MINIMAL2 OK   (current_user_id is not null or acting_api_client_id is not null) accepted: ' + JSON.stringify(r));
  } catch (e) {
    console.log(`MINIMAL2 FAIL code=${e.code} message=${e.message}`);
  }
  await db.exec(`drop table if exists public.diag_probe2`);
  const policies = await db.query(
    `select tablename, policyname, cmd, permissive, roles::text as roles, qual, with_check
       from pg_policies
      where schemaname='public' and tablename in ('companies','people','signals','source_evidence','agent_runs','notes','tasks','message_versions','lead_assignments')
      order by tablename, cmd, policyname`,
  );
  console.log('POLICIES_JSON ' + JSON.stringify(policies.rows));

  const grants = await db.query(
    `select table_name, privilege_type, grantee
       from information_schema.role_table_grants
      where table_schema='public' and table_name in ('companies','signals')
      order by table_name, grantee, privilege_type`,
  );
  console.log('GRANTS_JSON ' + JSON.stringify(grants.rows));
} finally {
  await db.close();
}
