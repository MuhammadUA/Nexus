/**
 * RLS access control — DB_CONTRACT.md §3.
 *
 * Every assertion performs the real operation against real PGlite Postgres and
 * checks the observed rows / raised error. Cross-actor checks stay inside one
 * transaction by switching `request.jwt.claims` (see `actAs`), so nothing leaks
 * between tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  accepted,
  actAs,
  actAsApiClient,
  attempt,
  countOf,
  createHarness,
  FIXTURE_IDS,
  quote,
  rejected,
  type Harness,
} from './harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('rls: business visibility', () => {
  it('a user cannot see a hidden business', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const visible = await sql.query<{ id: string }>('select id from public.businesses order by id');
      expect(visible.rows.map((r) => r.id)).toEqual([FIXTURE_IDS.businessA]);

      const guessed = await sql.query('select id from public.businesses where id = $1', [
        FIXTURE_IDS.businessB,
      ]);
      expect(guessed.rows).toHaveLength(0);

      const helper = await sql.query<{ ids: string[] }>(
        'select coalesce(array_agg(v order by v), array[]::uuid[]) as ids from public.visible_business_ids() as t(v)',
      );
      expect(helper.rows[0]?.ids).toEqual([FIXTURE_IDS.businessA]);
    });
  });

  it('a user cannot see another business leads even by guessing the uuid', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const hidden = await sql.query('select id from public.leads where id = $1', [FIXTURE_IDS.leadB2]);
      expect(hidden.rows).toHaveLength(0);

      const all = await sql.query<{ id: string }>(
        'select id from public.leads where id = any($1::uuid[]) order by id',
        [[FIXTURE_IDS.leadA1, FIXTURE_IDS.leadB1, FIXTURE_IDS.leadB2]],
      );
      expect(all.rows.map((r) => r.id)).toEqual([FIXTURE_IDS.leadA1]);
    });
  });

  it('an admin can see and configure the allowed scope', async () => {
    await h.asAdmin(async (sql) => {
      const businesses = await sql.query<{ id: string }>('select id from public.businesses order by id');
      expect(businesses.rows).toHaveLength(3);

      await sql.query('update public.businesses set focus = $1 where id = $2', [
        'configured by admin',
        FIXTURE_IDS.businessB,
      ]);
      const updated = await sql.query<{ focus: string }>(
        'select focus from public.businesses where id = $1',
        [FIXTURE_IDS.businessB],
      );
      expect(updated.rows[0]?.focus).toBe('configured by admin');
    });
  });

  it('a normal user cannot create a business', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const failure = await rejected(
        sql,
        () =>
          sql.query(`insert into public.businesses (key, name) values ('sneaky-business', 'Sneaky')`),
        '42501',
      );
      expect(failure.message).toContain('row-level security');
    });
  });
});

describe('rls: outreach identity assignment', () => {
  it('a user cannot select an identity they do not manage', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const visible = await sql.query<{ id: string }>(
        'select id from public.outreach_identities order by id',
      );
      expect(visible.rows.map((r) => r.id)).toEqual([FIXTURE_IDS.identityA1]);

      const unassigned = await sql.query('select id from public.outreach_identities where id = $1', [
        FIXTURE_IDS.identityUnassigned,
      ]);
      expect(unassigned.rows).toHaveLength(0);
    });
  });

  it('an RPC that requires the identity raises for an unassigned identity', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const error = await rejected(
        sql,
        () =>
          sql.query('select public.mark_connection_sent($1, $2, $3, $4)', [
            FIXTURE_IDS.leadA1,
            FIXTURE_IDS.identityUnassigned,
            'with_note',
            'rls-test',
          ]),
        '42501',
      );
      expect(error.message).toContain('assert_identity_usable');
    });
  });

  it('an RPC that requires the identity raises for another user identity', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const error = await rejected(
        sql,
        () =>
          sql.query('select public.mark_connection_sent($1, $2, $3, $4)', [
            FIXTURE_IDS.leadA1,
            FIXTURE_IDS.identityB1,
            'without_note',
            'rls-test',
          ]),
        '42501',
      );
      expect(error.message).toContain('assert_identity_usable');
    });
  });
});

describe('rls: companion visible businesses', () => {
  it('equals user_business_access INTERSECT identity business access', async () => {
    for (const identity of [FIXTURE_IDS.identityA1, FIXTURE_IDS.identityA2, FIXTURE_IDS.identityB1]) {
      await h.asAdmin(async (sql) => {
        // The expected set is computed from the raw tables as an admin, i.e.
        // independently of the SECURITY DEFINER helper under test.
        const expected = await sql.query<{ ids: string[] }>(
          `select coalesce(array_agg(distinct a.business_id order by a.business_id), array[]::uuid[]) as ids
             from public.user_business_access a
             join public.outreach_identity_business_access i
               on i.business_id = a.business_id
              and i.outreach_identity_id = $1
            where a.user_id = $2`,
          [identity, FIXTURE_IDS.user1],
        );

        await actAs(sql, FIXTURE_IDS.user1);
        const companion = await sql.query<{ ids: string[] }>(
          'select coalesce(array_agg(v order by v), array[]::uuid[]) as ids from public.companion_visible_business_ids($1) as t(v)',
          [identity],
        );

        expect(companion.rows[0]?.ids).toEqual(expected.rows[0]?.ids);
      });
    }

    // sanity: the intersection is non-trivial for at least one identity
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const companion = await sql.query<{ ids: string[] }>(
        'select coalesce(array_agg(v order by v), array[]::uuid[]) as ids from public.companion_visible_business_ids($1) as t(v)',
        [FIXTURE_IDS.identityA1],
      );
      expect(companion.rows[0]?.ids).toEqual([FIXTURE_IDS.businessA]);
    });
  });

  it('is an intersection, never a union', async () => {
    await h.asUser(FIXTURE_IDS.user2, async (sql) => {
      const result = await sql.query<{ ids: string[] }>(
        'select coalesce(array_agg(v order by v), array[]::uuid[]) as ids from public.companion_visible_business_ids($1) as t(v)',
        [FIXTURE_IDS.identityA1],
      );
      expect(result.rows[0]?.ids).toEqual([]);
    });

    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const result = await sql.query<{ ids: string[] }>(
        'select coalesce(array_agg(v order by v), array[]::uuid[]) as ids from public.companion_visible_business_ids($1) as t(v)',
        [FIXTURE_IDS.identityA2],
      );
      expect(result.rows[0]?.ids).toEqual([FIXTURE_IDS.businessA]);
    });
  });
});

describe('rls: lead writes', () => {
  it('a user cannot insert a lead into a business they lack access to', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const error = await rejected(
        sql,
        () =>
          sql.query(
            `insert into public.leads (business_id, person_id, status, source_type)
             values ($1, $2, 'new', 'manual_add')`,
            [FIXTURE_IDS.businessB, FIXTURE_IDS.personLisaWeber],
          ),
        '42501',
      );
      expect(error.message).toContain('row-level security');
    });
  });

  it('a user cannot move a lead into a business they lack access to', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const error = await rejected(
        sql,
        () =>
          sql.query('update public.leads set business_id = $1 where id = $2', [
            FIXTURE_IDS.businessB,
            FIXTURE_IDS.leadA1,
          ]),
        '42501',
      );
      expect(error.message).toContain('row-level security');
    });
  });

  it('an update against an invisible lead affects zero rows and changes nothing', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const result = await sql.query('update public.leads set lost_reason = $1 where id = $2', [
        'should not apply',
        FIXTURE_IDS.leadB2,
      ]);
      expect(result.affectedRows).toBe(0);

      await actAs(sql, FIXTURE_IDS.admin);
      const check = await sql.query<{ lost_reason: string | null }>(
        'select lost_reason from public.leads where id = $1',
        [FIXTURE_IDS.leadB2],
      );
      expect(check.rows[0]?.lost_reason).toBeNull();
    });
  });

  it('a user without can_manage_leads cannot insert a lead', async () => {
    await h.asAdmin(async (sql) => {
      await sql.query(
        `update public.user_business_access set can_manage_leads = false
          where user_id = $1 and business_id = $2`,
        [FIXTURE_IDS.user1, FIXTURE_IDS.businessA],
      );

      await actAs(sql, FIXTURE_IDS.user1);
      await rejected(
        sql,
        () =>
          sql.query(
            `insert into public.leads (business_id, person_id, status, source_type, owner_user_id)
             values ($1, $2, 'new', 'manual_add', $3)`,
            [FIXTURE_IDS.businessA, FIXTURE_IDS.personMiaBecker, FIXTURE_IDS.user1],
          ),
        '42501',
      );
    });
  });
});

describe('rls: soft delete and permanent delete', () => {
  it('a soft-deleted lead leaves normal lists but stays in Trash', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      await sql.query('select public.soft_delete_lead($1, $2)', [
        FIXTURE_IDS.leadA4,
        FIXTURE_IDS.user1,
      ]);

      const normalList = await countOf(
        sql,
        'select count(*)::int as n from public.leads where deleted_at is null',
      );
      expect(normalList).toBe(4);

      const hiddenFromList = await countOf(
        sql,
        'select count(*)::int as n from public.leads where id = $1 and deleted_at is null',
        [FIXTURE_IDS.leadA4],
      );
      expect(hiddenFromList).toBe(0);

      const trash = await countOf(
        sql,
        'select count(*)::int as n from public.leads where id = $1 and deleted_at is not null',
        [FIXTURE_IDS.leadA4],
      );
      expect(trash).toBe(1);

      const queue = await sql.query<{ item_lead_id: string }>(
        `select item_lead_id from public.get_today_queue($1, $2, 'today', null::text[], now())`,
        [FIXTURE_IDS.user1, FIXTURE_IDS.businessA],
      );
      expect(queue.rows.map((r) => r.item_lead_id)).not.toContain(FIXTURE_IDS.leadA4);

      const state = await sql.query<{ status: string }>(
        'select status from public.leads where id = $1',
        [FIXTURE_IDS.leadA4],
      );
      expect(state.rows[0]?.status).toBe('deleted');
    });
  });

  it('a normal user cannot permanently delete a lead', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const error = await rejected(
        sql,
        () =>
          sql.query('select public.permanent_delete_lead($1, $2, $3)', [
            FIXTURE_IDS.leadA4,
            FIXTURE_IDS.user1,
            'DELETE PERMANENTLY',
          ]),
        '42501',
      );
      expect(error.message).toContain('admin permission required');
    });
  });

  it('a manager in the business still cannot permanently delete a lead', async () => {
    await h.asUser(FIXTURE_IDS.manager, async (sql) => {
      await rejected(
        sql,
        () =>
          sql.query('select public.permanent_delete_lead($1, $2, $3)', [
            FIXTURE_IDS.leadA4,
            FIXTURE_IDS.manager,
            'DELETE PERMANENTLY',
          ]),
        '42501',
      );
    });
  });
});

describe('rls: anon and unmatched actors see nothing', () => {
  it('the anon role cannot read any application table', async () => {
    await h.asAnon(async (sql) => {
      const outcome = await attempt(sql, () => sql.query('select id from public.leads'));
      if (outcome.ok) {
        expect(outcome.value.rows).toHaveLength(0);
      } else {
        expect(outcome.error.code).toBe('42501');
      }
    });
  });

  it('an authenticated session with no jwt subject sees no business data', async () => {
    await h.asUser(null, async (sql) => {
      expect(await countOf(sql, 'select count(*)::int as n from public.leads')).toBe(0);
      expect(await countOf(sql, 'select count(*)::int as n from public.businesses')).toBe(0);
    });
  });

  it('a user with no business grants sees no business data', async () => {
    await h.asUser(FIXTURE_IDS.userNoData, async (sql) => {
      expect(await countOf(sql, 'select count(*)::int as n from public.leads')).toBe(0);
      expect(await countOf(sql, 'select count(*)::int as n from public.tasks')).toBe(0);
    });
  });
});

describe('rls: canonical identities follow lead visibility', () => {
  it('a user sees only people referenced by leads in accessible businesses', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const names = await sql.query<{ full_name: string }>(
        'select full_name from public.people order by full_name',
      );
      expect(names.rows.map((r) => r.full_name)).toEqual([
        'Jon Davies',
        'Lisa Weber',
        'Nora Schmidt',
        'Sarah Smith',
        'Tom Henry',
      ]);
    });
  });

  it('the person shared by two businesses is visible to both business owners', async () => {
    for (const user of [FIXTURE_IDS.user1, FIXTURE_IDS.user2]) {
      await h.asUser(user, async (sql) => {
        const row = await sql.query('select id from public.people where id = $1', [
          FIXTURE_IDS.personTomHenry,
        ]);
        expect(row.rows).toHaveLength(1);
      });
    }
  });
});

describe('rls: helper functions are policy inputs, not bypasses', () => {
  it('has_business_access answers for the acting user only', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const result = await sql.query<{ a: boolean; b: boolean; admin: boolean }>(
        'select public.has_business_access($1) as a, public.has_business_access($2) as b, public.is_admin() as admin',
        [FIXTURE_IDS.businessA, FIXTURE_IDS.businessB],
      );
      expect(result.rows[0]).toEqual({ a: true, b: false, admin: false });
    });
  });

  it('the lead scope filter hides leads outside the configured mode', async () => {
    await h.asAdmin(async (sql) => {
      await sql.query(
        `insert into public.leads (business_id, person_id, owner_user_id, status, source_type, created_by)
         values ($1, $2, $3, 'ready', 'manual_add', $4)`,
        [FIXTURE_IDS.businessA, FIXTURE_IDS.personMiaBecker, FIXTURE_IDS.manager, FIXTURE_IDS.manager],
      );
      await sql.query(
        `insert into public.user_lead_scope (user_id, business_id, mode) values ($1, $2, 'assigned')`,
        [FIXTURE_IDS.user1, FIXTURE_IDS.businessA],
      );

      // same transaction, switch the actor: this is what the policy sees
      await actAs(sql, FIXTURE_IDS.user1);
      const visible = await sql.query<{ id: string }>(
        'select id from public.leads where business_id = $1 order by id',
        [FIXTURE_IDS.businessA],
      );
      expect(visible.rows.map((r) => r.id)).toEqual([
        FIXTURE_IDS.leadA1,
        FIXTURE_IDS.leadA2,
        FIXTURE_IDS.leadA3,
        FIXTURE_IDS.leadA4,
        FIXTURE_IDS.leadA5,
      ]);

      // and with mode = 'all' the manager-owned lead is visible again
      await actAs(sql, FIXTURE_IDS.admin);
      await sql.query(`update public.user_lead_scope set mode = 'all' where user_id = $1`, [
        FIXTURE_IDS.user1,
      ]);
      await actAs(sql, FIXTURE_IDS.user1);
      expect(
        await countOf(sql, 'select count(*)::int as n from public.leads where business_id = $1', [
          FIXTURE_IDS.businessA,
        ]),
      ).toBe(6);
    });
  });
});

describe('rls: no SQL-text entry point', () => {
  it('no application function executes caller-supplied SQL', async () => {
    const result = await h.asSuperuser((sql) =>
      sql.query<{ proname: string }>(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and (
              p.prosrc ilike '%' || ${quote('execute immediate')} || '%'
              or p.prosrc ilike '%' || ${quote('execute_sql')} || '%'
            )
          order by p.proname`,
      ),
    );
    expect(result.rows.map((r) => r.proname)).toEqual([]);
  });
});

describe('rls: api client boundary and auditing', () => {
  it('a token reads only businesses inside api_clients.business_ids', async () => {
    await h.asApiClient(FIXTURE_IDS.apiClientLimited, async (sql) => {
      expect(
        await countOf(sql, 'select count(*)::int as n from public.leads where business_id = $1', [
          FIXTURE_IDS.businessA,
        ]),
      ).toBe(5);
      expect(
        await countOf(sql, 'select count(*)::int as n from public.leads where business_id = $1', [
          FIXTURE_IDS.businessB,
        ]),
      ).toBe(0);
    });
  });

  it('an allowed api-client write succeeds and is audited as api_client', async () => {
    await h.asApiClient(FIXTURE_IDS.apiClientIngest, async (sql) => {
      const inserted = await accepted(sql, () =>
        sql.query<{ id: string }>(
          `insert into public.source_evidence
             (business_id, person_id, source, content_hash, observed_at, confidence)
           values ($1, $2, 'api-client-test', 'api-client-hash-1', now(), 0.5)
           returning id`,
          [FIXTURE_IDS.businessA, FIXTURE_IDS.personTomHenry],
        ),
      );
      const evidenceId = inserted.rows[0]?.id;
      expect(evidenceId).toBeDefined();

      await actAs(sql, FIXTURE_IDS.admin);
      const audit = await sql.query<{ actor_type: string; api_client_id: string }>(
        `select actor_type, api_client_id from public.audit_events
          where entity_id = $1 order by created_at desc limit 1`,
        [evidenceId],
      );
      expect(audit.rows[0]?.actor_type).toBe('api_client');
      expect(audit.rows[0]?.api_client_id).toBe(FIXTURE_IDS.apiClientIngest);
    });
  });

  it('a client cannot write into a business outside its business_ids', async () => {
    await h.asApiClient(FIXTURE_IDS.apiClientIngest, async (sql) => {
      await actAsApiClient(sql, FIXTURE_IDS.apiClientIngest);
      await rejected(
        sql,
        () =>
          sql.query(
            `insert into public.source_evidence
               (business_id, person_id, source, content_hash, observed_at, confidence)
             values ($1, $2, 'api-client-test', 'api-client-hash-2', now(), 0.5)`,
            [FIXTURE_IDS.businessB, FIXTURE_IDS.personTomHenry],
          ),
        '42501',
      );
    });
  });
});
