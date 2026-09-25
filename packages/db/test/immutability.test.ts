/**
 * Immutability and the audited admin delete path — DB_CONTRACT.md §2
 * invariants 7, 11, 20 and spec `sequence_engine.message_states`
 * ("SENT ... corrections use new events/versions, never overwrite").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { accepted, countOf, createHarness, FIXTURE_IDS, rejected, type Harness } from './harness';
import type { Db } from '../src/client';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 180_000);

afterAll(async () => {
  await h.close();
});

/** Moves the fixture Message 1 instance to SENT and returns its version id. */
async function makeSent(sql: Db): Promise<string> {
  await sql.query('select public.mark_message_sent($1, $2, $3)', [
    FIXTURE_IDS.messageInstanceA2M1,
    FIXTURE_IDS.identityA1,
    'immutability-test',
  ]);
  return FIXTURE_IDS.messageVersionA2M1;
}

describe('invariant 7 — sent content is immutable', () => {
  it('a version of a SENT message cannot be updated or deleted', async () => {
    await h.asAdmin(async (sql) => {
      await makeSent(sql);

      const update = await rejected(
        sql,
        () =>
          sql.query('update public.message_versions set content = $1 where id = $2', [
            'rewritten history',
            FIXTURE_IDS.messageVersionA2M1,
          ]),
        '23001',
      );
      expect(update.message).toContain('immutable');

      // DELETE is additionally revoked from `authenticated` (0014_grants.sql)
      const remove = await rejected(
        sql,
        () => sql.query('delete from public.message_versions where id = $1', [FIXTURE_IDS.messageVersionA2M1]),
        '42501',
      );
      expect(remove.message).toContain('permission denied');

      const content = await sql.query<{ content: string }>(
        'select content from public.message_versions where id = $1',
        [FIXTURE_IDS.messageVersionA2M1],
      );
      expect(content.rows[0]?.content).toBe('Fixture Message 1 body for Sarah Smith.');
    });

    // the table owner still cannot delete it: the trigger is the guarantee
    await h.asSuperuser(async (sql) => {
      await sql.query(`update public.message_instances set state = 'SENT', sent_at = now() where id = $1`, [
        FIXTURE_IDS.messageInstanceA2M1,
      ]);
      const remove = await rejected(
        sql,
        () => sql.query('delete from public.message_versions where id = $1', [FIXTURE_IDS.messageVersionA2M1]),
        '23001',
      );
      expect(remove.message).toContain('immutable');
    });
  });

  it('a version of an unsent message may still be edited', async () => {
    await h.asAdmin(async (sql) => {
      const version = await accepted(sql, () =>
        sql.query<{ id: string }>(
          `insert into public.message_versions (message_instance_id, content, created_by)
           values ($1, 'draft body', $2) returning id`,
          [FIXTURE_IDS.messageInstanceA2M1, FIXTURE_IDS.admin],
        ),
      );
      const versionId = version.rows[0]?.id;

      await accepted(sql, () =>
        sql.query('update public.message_versions set content = $1 where id = $2', [
          'edited draft body',
          versionId,
        ]),
      );

      const content = await sql.query<{ content: string; is_manual_edit: boolean }>(
        'select content, is_manual_edit from public.message_versions where id = $1',
        [versionId],
      );
      expect(content.rows[0]?.content).toBe('edited draft body');
      expect(content.rows[0]?.is_manual_edit).toBe(false);
    });
  });

  it('the assigned version_no increments per instance', async () => {
    await h.asAdmin(async (sql) => {
      const first = await sql.query<{ version_no: number }>(
        'select version_no from public.message_versions where id = $1',
        [FIXTURE_IDS.messageVersionA2M1],
      );
      expect(first.rows[0]?.version_no).toBe(1);

      const second = await accepted(sql, () =>
        sql.query<{ id: string }>(
          `insert into public.message_versions (message_instance_id, content, created_by)
           values ($1, 'second version', $2) returning id`,
          [FIXTURE_IDS.messageInstanceA2M1, FIXTURE_IDS.admin],
        ),
      );
      const third = await accepted(sql, () =>
        sql.query<{ id: string }>(
          `insert into public.message_versions (message_instance_id, content, created_by)
           values ($1, 'third version', $2) returning id`,
          [FIXTURE_IDS.messageInstanceA2M1, FIXTURE_IDS.admin],
        ),
      );

      const numbers = await sql.query<{ version_no: number }>(
        'select version_no from public.message_versions where id = any($1::uuid[]) order by version_no',
        [[second.rows[0]?.id, third.rows[0]?.id]],
      );
      expect(numbers.rows.map((r) => r.version_no)).toEqual([2, 3]);
    });
  });

  it('message_instances.state cannot move away from SENT', async () => {
    await h.asAdmin(async (sql) => {
      await makeSent(sql);

      const error = await rejected(
        sql,
        () =>
          sql.query('update public.message_instances set state = $1 where id = $2', [
            'DYNAMIC',
            FIXTURE_IDS.messageInstanceA2M1,
          ]),
        '23001',
      );
      expect(error.message).toContain('cannot move away from SENT');

      const current = await sql.query<{ state: string }>(
        'select state from public.message_instances where id = $1',
        [FIXTURE_IDS.messageInstanceA2M1],
      );
      expect(current.rows[0]?.state).toBe('SENT');
    });
  });

  it('the frozen version reference and sent_at of a SENT message cannot change', async () => {
    await h.asAdmin(async (sql) => {
      await makeSent(sql);

      await rejected(
        sql,
        () =>
          sql.query('update public.message_instances set current_version_id = null where id = $1', [
            FIXTURE_IDS.messageInstanceA2M1,
          ]),
        '23001',
      );

      await rejected(
        sql,
        () =>
          sql.query('update public.message_instances set sent_at = sent_at + interval \'1 hour\' where id = $1', [
            FIXTURE_IDS.messageInstanceA2M1,
          ]),
        '23001',
      );
    });
  });

  it('updating an unsent instance is still allowed', async () => {
    await h.asAdmin(async (sql) => {
      await accepted(sql, () =>
        sql.query(`update public.message_instances set state = 'LOCKED' where id = $1`, [
          FIXTURE_IDS.messageInstanceA2M1,
        ]),
      );
      await accepted(sql, () =>
        sql.query(`update public.message_instances set state = 'DYNAMIC' where id = $1`, [
          FIXTURE_IDS.messageInstanceA2M1,
        ]),
      );
    });
  });
});

describe('audit_events is append-only', () => {
  it('the trigger refuses update and delete for the owner', async () => {
    await h.asSuperuser(async (sql) => {
      const existing = await sql.query<{ id: string }>('select id from public.audit_events limit 1');
      const id = existing.rows[0]?.id;
      expect(id).toBeDefined();

      await rejected(
        sql,
        () => sql.query('update public.audit_events set action = $1 where id = $2', ['tampered', id]),
        '23001',
      );
      await rejected(
        sql,
        () => sql.query('delete from public.audit_events where id = $1', [id]),
        '23001',
      );
    });
  });

  it('an authenticated writer has no update/delete privilege at all', async () => {
    await h.asAdmin(async (sql) => {
      const existing = await sql.query<{ id: string }>('select id from public.audit_events limit 1');
      const id = existing.rows[0]?.id;
      expect(id).toBeDefined();

      const update = await rejected(
        sql,
        () => sql.query('update public.audit_events set action = $1 where id = $2', ['tampered', id]),
      );
      expect(['42501', '23001']).toContain(update.code);
    });
  });

  it('an admin can insert and read audit rows but a normal user only their own', async () => {
    await h.asAdmin(async (sql) => {
      await accepted(sql, () =>
        sql.query(
          `insert into public.audit_events (actor_type, actor_id, entity_type, action)
           values ('user', $1, 'leads', 'manual-test-event')`,
          [FIXTURE_IDS.admin],
        ),
      );
      const rows = await countOf(sql, `select count(*)::int as n from public.audit_events`);
      expect(rows).toBeGreaterThan(0);
    });

    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const others = await countOf(
        sql,
        `select count(*)::int as n from public.audit_events where actor_id is distinct from $1`,
        [FIXTURE_IDS.user1],
      );
      expect(others).toBe(0);
    });
  });
});

describe('invariant 11 — permanent deletion is admin-only and audited', () => {
  it('a plain delete is refused for an admin', async () => {
    await h.asAdmin(async (sql) => {
      const error = await rejected(
        sql,
        () => sql.query('delete from public.leads where id = $1', [FIXTURE_IDS.leadA4]),
        '23001',
      );
      expect(error.message).toContain('hard delete');
    });
  });

  it('a plain delete is refused for people and companies as well', async () => {
    await h.asSuperuser(async (sql) => {
      await rejected(
        sql,
        () => sql.query('delete from public.people where id = $1', [FIXTURE_IDS.personNoraSchmidt]),
        '23001',
      );
      await rejected(
        sql,
        () => sql.query('delete from public.companies where id = $1', [FIXTURE_IDS.companyNorthstar]),
        '23001',
      );
    });
  });

  it('the admin flow requires the literal confirmation string', async () => {
    await h.asAdmin(async (sql) => {
      const error = await rejected(
        sql,
        () =>
          sql.query('select public.permanent_delete_lead($1, $2, $3)', [
            FIXTURE_IDS.leadA4,
            FIXTURE_IDS.admin,
            'yes please',
          ]),
        '42501',
      );
      expect(error.message).toContain('literal confirmation string');

      const stillThere = await countOf(sql, 'select count(*)::int as n from public.leads where id = $1', [
        FIXTURE_IDS.leadA4,
      ]);
      expect(stillThere).toBe(1);
    });
  });

  it('the audited confirmation path deletes the lead and writes both audit rows', async () => {
    await h.asAdmin(async (sql) => {
      const before = await countOf(sql, 'select count(*)::int as n from public.leads where id = $1', [
        FIXTURE_IDS.leadA4,
      ]);
      expect(before).toBe(1);

      const result = await accepted(sql, () =>
        sql.query<{ result: { permanently_deleted: boolean } }>(
          'select public.permanent_delete_lead($1, $2, $3) as result',
          [FIXTURE_IDS.leadA4, FIXTURE_IDS.admin, 'DELETE PERMANENTLY'],
        ),
      );
      expect(result.rows[0]?.result.permanently_deleted).toBe(true);

      expect(await countOf(sql, 'select count(*)::int as n from public.leads where id = $1', [
        FIXTURE_IDS.leadA4,
      ])).toBe(0);

      // the lead's dependent rows cascaded but the canonical person survived
      expect(await countOf(sql, 'select count(*)::int as n from public.lead_icp_matches where lead_id = $1', [
        FIXTURE_IDS.leadA4,
      ])).toBe(0);
      expect(await countOf(sql, 'select count(*)::int as n from public.people where id = $1', [
        FIXTURE_IDS.personNoraSchmidt,
      ])).toBe(1);

      const audit = await sql.query<{ action: string; actor_id: string }>(
        `select action, actor_id from public.audit_events
          where entity_id = $1 and entity_type = 'leads'
          order by created_at`,
        [FIXTURE_IDS.leadA4],
      );
      const actions = audit.rows.map((r) => r.action);
      expect(actions).toContain('permanent_delete_lead');
      expect(actions).toContain('delete');
      for (const row of audit.rows) {
        expect(row.actor_id).toBe(FIXTURE_IDS.admin);
      }
    });
  });
});
