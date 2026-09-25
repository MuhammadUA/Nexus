/**
 * Sequence lifecycle — DB_CONTRACT.md §1.6 and spec `sequence_engine` /
 * `lead_lifecycle`.
 *
 * Connection -> Message 1 -> FU1 -> FU2 -> FU3 -> Dormant, the configured delay
 * chain, the immutability of what was actually sent, and the publish behaviour.
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

interface SentResult {
  message_instance_id: string;
  state: string;
  message_event_id: string;
  message_version_id: string;
  next_message_instance_id: string | null;
  due_at: string | null;
  lead_status: string;
  enrollment_state: string;
  reactivation_due_at: string | null;
}

/** Creates a message version, freezes it and marks the instance SENT. */
async function sendPending(
  sql: Db,
  leadId: string,
  identityId: string,
  stepOrder: number,
): Promise<{ instanceId: string; result: SentResult; versionId: string }> {
  const instance = await sql.query<{ id: string }>(
    `select id from public.message_instances
      where lead_id = $1 and step_order = $2 and sent_at is null
      order by created_at desc limit 1`,
    [leadId, stepOrder],
  );
  const instanceId = instance.rows[0]?.id;
  if (instanceId === undefined) {
    throw new Error(`no pending message instance for lead ${leadId} at step ${stepOrder}`);
  }

  const version = await accepted(sql, () =>
    sql.query<{ id: string }>(
      `insert into public.message_versions (message_instance_id, content, generated_by_model, created_by)
       values ($1, $2, 'fixture-model', $3) returning id`,
      [instanceId, `Message for step ${stepOrder}`, FIXTURE_IDS.admin],
    ),
  );
  const versionId = version.rows[0]?.id;
  if (versionId === undefined) {
    throw new Error('message version insert returned no id');
  }

  await sql.query('update public.message_instances set current_version_id = $1 where id = $2', [
    versionId,
    instanceId,
  ]);

  const sent = await accepted(sql, () =>
    sql.query<{ result: SentResult }>('select public.mark_message_sent($1, $2, $3) as result', [
      instanceId,
      identityId,
      'sequence-test',
    ]),
  );

  const result = sent.rows[0]?.result;
  if (result === undefined) {
    throw new Error('mark_message_sent returned no result');
  }
  return { instanceId, result, versionId };
}

async function daysFromNow(sql: Db, instanceId: string): Promise<number> {
  const row = await sql.query<{ days: number }>(
    `select round(extract(epoch from (due_at - now())) / 86400)::int as days
       from public.message_instances where id = $1`,
    [instanceId],
  );
  const days = row.rows[0]?.days;
  if (days === undefined) throw new Error('instance not found');
  return days;
}

describe('connection accepted -> Message 1 due', () => {
  it('mark_connection_sent creates a due Message 1 instance', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const result = await accepted(sql, () =>
        sql.query<{ result: { message_instance_id: string; due_at: string; status: string } }>(
          'select public.mark_connection_sent($1, $2, $3, $4) as result',
          [FIXTURE_IDS.leadA3, FIXTURE_IDS.identityA1, 'with_note', 'connection-test'],
        ),
      );
      expect(result.rows[0]?.result.status).toBe('message_due');
      expect(result.rows[0]?.result.message_instance_id).toBeDefined();

      const instance = await sql.query<{
        step_order: number;
        step_kind: string;
        state: string;
        due_at: string | null;
      }>(
        'select step_order, step_kind, state, due_at from public.message_instances where id = $1',
        [result.rows[0]?.result.message_instance_id],
      );
      expect(instance.rows[0]?.step_order).toBe(1);
      expect(instance.rows[0]?.step_kind).toBe('message');
      expect(instance.rows[0]?.state).toBe('DYNAMIC');
      expect(instance.rows[0]?.due_at).not.toBeNull();

      const lead = await sql.query<{ status: string; next_action_type: string; next_action_at: string | null }>(
        'select status, next_action_type, next_action_at from public.leads where id = $1',
        [FIXTURE_IDS.leadA3],
      );
      expect(lead.rows[0]?.status).toBe('message_due');
      expect(lead.rows[0]?.next_action_type).toBe('message_1');
      expect(lead.rows[0]?.next_action_at).not.toBeNull();

      const event = await sql.query<{ c: number }>(
        `select count(*)::int as c from public.interactions
          where lead_id = $1 and type = 'connection_event' and direction = 'outbound'`,
        [FIXTURE_IDS.leadA3],
      );
      expect(event.rows[0]?.c).toBe(1);
    });
  });
});

describe('M1 -> FU1 -> FU2 -> FU3 -> Dormant', () => {
  it('applies the configured delays and goes dormant with a reactivation date', async () => {
    await h.asAdmin(async (sql) => {
      await accepted(sql, () =>
        sql.query('select public.mark_connection_sent($1, $2, $3, $4)', [
          FIXTURE_IDS.leadA3,
          FIXTURE_IDS.identityA1,
          'without_note',
          'sequence-test',
        ]),
      );

      // Message 1 -> Follow-up 1 is due after the configured 3 days
      const m1 = await sendPending(sql, FIXTURE_IDS.leadA3, FIXTURE_IDS.identityA1, 1);
      const fu1Id = m1.result.next_message_instance_id;
      expect(fu1Id).not.toBeNull();
      if (fu1Id === null) throw new Error('no follow-up instance created');
      expect(await daysFromNow(sql, fu1Id)).toBe(3);
      expect(m1.result.lead_status).toBe('followup_due');

      // FU1 -> FU2 after 4 days
      const fu1 = await sendPending(sql, FIXTURE_IDS.leadA3, FIXTURE_IDS.identityA1, 2);
      const fu2Id = fu1.result.next_message_instance_id;
      if (fu2Id === null) throw new Error('no FU2 instance created');
      expect(await daysFromNow(sql, fu2Id)).toBe(4);

      // FU2 -> FU3 after 7 days
      const fu2 = await sendPending(sql, FIXTURE_IDS.leadA3, FIXTURE_IDS.identityA1, 3);
      const fu3Id = fu2.result.next_message_instance_id;
      if (fu3Id === null) throw new Error('no FU3 instance created');
      expect(await daysFromNow(sql, fu3Id)).toBe(7);

      // FU3 -> Dormant with the configured reactivation delay (default 60 days)
      const fu3 = await sendPending(sql, FIXTURE_IDS.leadA3, FIXTURE_IDS.identityA1, 4);
      expect(fu3.result.next_message_instance_id).toBeNull();
      expect(fu3.result.enrollment_state).toBe('dormant');
      expect(fu3.result.lead_status).toBe('dormant');

      const enrollment = await sql.query<{ state: string; dormant_at: string | null; days: number }>(
        `select state, dormant_at,
                round(extract(epoch from (reactivation_due_at - now())) / 86400)::int as days
           from public.sequence_enrollments where id = $1`,
        [FIXTURE_IDS.enrollmentLeadA3],
      );
      expect(enrollment.rows[0]?.state).toBe('dormant');
      expect(enrollment.rows[0]?.dormant_at).not.toBeNull();
      expect(enrollment.rows[0]?.days).toBe(60);

      const lead = await sql.query<{ status: string; next_action_type: string }>(
        'select status, next_action_type from public.leads where id = $1',
        [FIXTURE_IDS.leadA3],
      );
      expect(lead.rows[0]).toEqual({ status: 'dormant', next_action_type: 'reactivation' });
    });
  });

  it('honours a business-specific reactivation setting', async () => {
    await h.asAdmin(async (sql) => {
      await sql.query(
        `insert into public.platform_settings (business_id, key, value) values ($1, 'dormant.reactivation_days', '30'::jsonb)`,
        [FIXTURE_IDS.businessA],
      );

      await sql.query('select public.mark_connection_sent($1, $2, $3, $4)', [
        FIXTURE_IDS.leadA3,
        FIXTURE_IDS.identityA1,
        'without_note',
        'sequence-test',
      ]);

      let instanceId: string | undefined;
      for (const step of [1, 2, 3, 4]) {
        const sent = await sendPending(sql, FIXTURE_IDS.leadA3, FIXTURE_IDS.identityA1, step);
        instanceId = sent.instanceId;
      }
      expect(instanceId).toBeDefined();

      const days = await sql.query<{ days: number }>(
        `select round(extract(epoch from (reactivation_due_at - now())) / 86400)::int as days
           from public.sequence_enrollments where id = $1`,
        [FIXTURE_IDS.enrollmentLeadA3],
      );
      expect(days.rows[0]?.days).toBe(30);
    });
  });
});

describe('Mark Sent freezes an immutable version reference', () => {
  it('records a sent event pointing at the frozen version', async () => {
    await h.asAdmin(async (sql) => {
      await sql.query('select public.mark_connection_sent($1, $2, $3, $4)', [
        FIXTURE_IDS.leadA3,
        FIXTURE_IDS.identityA1,
        'with_note',
        'sequence-test',
      ]);

      const m1 = await sendPending(sql, FIXTURE_IDS.leadA3, FIXTURE_IDS.identityA1, 1);

      const instance = await sql.query<{ state: string; current_version_id: string; sent_at: string | null }>(
        'select state, current_version_id, sent_at from public.message_instances where id = $1',
        [m1.instanceId],
      );
      expect(instance.rows[0]?.state).toBe('SENT');
      expect(instance.rows[0]?.current_version_id).toBe(m1.versionId);
      expect(instance.rows[0]?.sent_at).not.toBeNull();

      const event = await sql.query<{
        event_type: string;
        message_version_id: string;
        outreach_identity_id: string;
        business_id: string;
        lead_id: string;
      }>(
        `select event_type, message_version_id, outreach_identity_id, business_id, lead_id
           from public.message_events where message_instance_id = $1`,
        [m1.instanceId],
      );
      expect(event.rows).toHaveLength(1);
      expect(event.rows[0]).toMatchObject({
        event_type: 'sent',
        message_version_id: m1.versionId,
        outreach_identity_id: FIXTURE_IDS.identityA1,
        business_id: FIXTURE_IDS.businessA,
        lead_id: FIXTURE_IDS.leadA3,
      });

      // the version itself is still there and unmodified
      const version = await sql.query<{ content: string; version_no: number }>(
        'select content, version_no from public.message_versions where id = $1',
        [m1.versionId],
      );
      expect(version.rows[0]?.content).toBe('Message for step 1');
      expect(version.rows[0]?.version_no).toBe(1);

      // sending twice is refused
      await rejected(
        sql,
        () =>
          sql.query('select public.mark_message_sent($1, $2, $3)', [
            m1.instanceId,
            FIXTURE_IDS.identityA1,
            'sequence-test',
          ]),
        '23514',
      );
    });
  });

  it('refuses to send an instance with no version', async () => {
    await h.asAdmin(async (sql) => {
      await sql.query('select public.mark_connection_sent($1, $2, $3, $4)', [
        FIXTURE_IDS.leadA3,
        FIXTURE_IDS.identityA1,
        'with_note',
        'sequence-test',
      ]);
      const instance = await sql.query<{ id: string }>(
        `select id from public.message_instances where lead_id = $1 and sent_at is null limit 1`,
        [FIXTURE_IDS.leadA3],
      );
      await rejected(
        sql,
        () =>
          sql.query('select public.mark_message_sent($1, $2, $3)', [
            instance.rows[0]?.id,
            FIXTURE_IDS.identityA1,
            'sequence-test',
          ]),
        '23514',
      );
    });
  });
});

describe('publishing a new sequence version', () => {
  it('keeps SENT and LOCKED, regenerates eligible DYNAMIC and moves enrollments', async () => {
    await h.asAdmin(async (sql) => {
      // publish version 2 of the fixture sequence
      const version2 = await accepted(sql, () =>
        sql.query<{ id: string }>(
          `insert into public.sequence_versions (sequence_id, version, status, change_summary)
           values ($1, 2, 'draft', 'second version') returning id`,
          [FIXTURE_IDS.sequenceA],
        ),
      );
      const version2Id = version2.rows[0]?.id;
      if (version2Id === undefined) throw new Error('version 2 not created');

      for (const [order, kind, name, delay] of [
        [1, 'message', 'Message 1', 0],
        [2, 'followup', 'Follow-up 1', 3],
        [3, 'followup', 'Follow-up 2', 4],
        [4, 'followup', 'Follow-up 3', 7],
      ] as const) {
        await sql.query(
          `insert into public.sequence_steps
             (sequence_version_id, step_order, kind, name, delay_days, delay_basis, goal, generation_mode)
           values ($1, $2, $3, $4, $5, 'after_previous', 'v2 goal', 'ai')`,
          [version2Id, order, kind, name, delay],
        );
      }

      // one SENT instance (the fixture Message 1)
      await sql.query(
        `update public.message_instances set state = 'SENT', sent_at = now() where id = $1`,
        [FIXTURE_IDS.messageInstanceA2M1],
      );

      // one LOCKED instance and one DYNAMIC instance on another enrolled lead
      const locked = await accepted(sql, () =>
        sql.query<{ id: string }>(
          `insert into public.message_instances
             (conversation_id, sequence_step_id, state, due_at, business_id, lead_id, step_order, step_kind)
           values ($1, $2, 'LOCKED', now() + interval '1 day', $3, $4, 2, 'followup')
           returning id`,
          [
            FIXTURE_IDS.conversationLeadA3,
            FIXTURE_IDS.stepFollowup1,
            FIXTURE_IDS.businessA,
            FIXTURE_IDS.leadA3,
          ],
        ),
      );
      const dynamic = await accepted(sql, () =>
        sql.query<{ id: string }>(
          `insert into public.message_instances
             (conversation_id, sequence_step_id, state, due_at, business_id, lead_id, step_order, step_kind)
           values ($1, $2, 'DYNAMIC', now() + interval '2 days', $3, $4, 3, 'followup')
           returning id`,
          [
            FIXTURE_IDS.conversationLeadA3,
            FIXTURE_IDS.stepFollowup2,
            FIXTURE_IDS.businessA,
            FIXTURE_IDS.leadA3,
          ],
        ),
      );

      const preview = await accepted(sql, () =>
        sql.query<{ preview: Record<string, number> }>(
          'select public.publish_sequence_version($1, $2) as preview',
          [version2Id, FIXTURE_IDS.admin],
        ),
      );
      expect(preview.rows[0]?.preview).toMatchObject({
        sent_untouched: 1,
        locked_untouched: 1,
        dynamic_needs_regeneration: 1,
      });

      const sent = await sql.query<{ state: string; current_version_id: string; invalidated_at: string | null }>(
        'select state, current_version_id, invalidated_at from public.message_instances where id = $1',
        [FIXTURE_IDS.messageInstanceA2M1],
      );
      expect(sent.rows[0]).toEqual({
        state: 'SENT',
        current_version_id: FIXTURE_IDS.messageVersionA2M1,
        invalidated_at: null,
      });

      const lockedRow = await sql.query<{ state: string; invalidated_at: string | null; regeneration_reason: string | null }>(
        'select state, invalidated_at, regeneration_reason from public.message_instances where id = $1',
        [locked.rows[0]?.id],
      );
      expect(lockedRow.rows[0]).toEqual({
        state: 'LOCKED',
        invalidated_at: null,
        regeneration_reason: null,
      });

      const dynamicRow = await sql.query<{ state: string; invalidated_at: string | null; regeneration_reason: string | null }>(
        'select state, invalidated_at, regeneration_reason from public.message_instances where id = $1',
        [dynamic.rows[0]?.id],
      );
      expect(dynamicRow.rows[0]?.state).toBe('DYNAMIC');
      expect(dynamicRow.rows[0]?.invalidated_at).not.toBeNull();
      expect(dynamicRow.rows[0]?.regeneration_reason).toBe('sequence_version_published');

      const enrollment = await sql.query<{ sequence_version_id: string }>(
        'select sequence_version_id from public.sequence_enrollments where id = $1',
        [FIXTURE_IDS.enrollmentLeadA2],
      );
      expect(enrollment.rows[0]?.sequence_version_id).toBe(version2Id);

      const versions = await sql.query<{ id: string; status: string; published_at: string | null }>(
        'select id, status, published_at from public.sequence_versions where sequence_id = $1 order by version',
        [FIXTURE_IDS.sequenceA],
      );
      expect(versions.rows[0]).toMatchObject({ id: FIXTURE_IDS.sequenceVersionA1, status: 'archived' });
      expect(versions.rows[1]?.id).toBe(version2Id);
      expect(versions.rows[1]?.status).toBe('published');
      expect(versions.rows[1]?.published_at).not.toBeNull();

      const sequence = await sql.query<{ current_version_id: string }>(
        'select current_version_id from public.sequences where id = $1',
        [FIXTURE_IDS.sequenceA],
      );
      expect(sequence.rows[0]?.current_version_id).toBe(version2Id);

      // publishing again is refused
      await rejected(
        sql,
        () =>
          sql.query('select public.publish_sequence_version($1, $2)', [version2Id, FIXTURE_IDS.admin]),
        '23514',
      );
    });
  });

  it('requires an admin', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const version = await sql.query<{ id: string }>(
        `select id from public.sequence_versions where sequence_id = $1 limit 1`,
        [FIXTURE_IDS.sequenceA],
      );
      const error = await rejected(
        sql,
        () =>
          sql.query('select public.publish_sequence_version($1, $2)', [
            version.rows[0]?.id,
            FIXTURE_IDS.user1,
          ]),
        '42501',
      );
      expect(error.message).toContain('requires an admin');
    });
  });
});

describe('DNC stops the sequence', () => {
  it('cancels the enrollment and invalidates pending messages', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      await sql.query('select public.capture_reply($1, $2, $3, $4, $5, now())', [
        FIXTURE_IDS.leadA3,
        'Never contact me again.',
        'Do not contact',
        null,
        'dnc-test',
      ]);

      const enrollment = await sql.query<{ state: string; pause_reason: string }>(
        'select state, pause_reason from public.sequence_enrollments where id = $1',
        [FIXTURE_IDS.enrollmentLeadA3],
      );
      expect(enrollment.rows[0]).toEqual({ state: 'cancelled', pause_reason: 'do_not_contact' });

      expect(
        await countOf(
          sql,
          `select count(*)::int as n from public.message_instances
            where lead_id = $1 and sent_at is null and invalidated_at is null`,
          [FIXTURE_IDS.leadA3],
        ),
      ).toBe(0);
    });
  });
});
