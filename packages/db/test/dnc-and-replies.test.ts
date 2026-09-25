/**
 * DNC, cooldown and reply handling — DB_CONTRACT.md §2 invariants 8 + 9 and
 * spec `sequence_engine.do_not_contact` / `ordinary_not_interested` /
 * `reply_and_notes`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { accepted, countOf, createHarness, FIXTURE_IDS, rejected, type Harness } from './harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('do not contact', () => {
  it('creates a global person+channel suppression and flags every lead', async () => {
    await h.asAdmin(async (sql) => {
      const result = await accepted(sql, () =>
        sql.query<{ result: { outcome_id: string; suppression_id: string | null; interaction_id: string } }>(
          `select public.capture_reply($1, $2, $3, $4, $5, now()) as result`,
          [
            FIXTURE_IDS.leadA3,
            'Please stop contacting me.',
            'Do not contact',
            'asked to stop',
            'dnc-test',
          ],
        ),
      );
      expect(result.rows[0]?.result.suppression_id).toBeDefined();

      const suppression = await sql.query<{
        person_id: string;
        channel: string;
        business_id: string | null;
        active: boolean;
        reason: string;
      }>('select person_id, channel, business_id, active, reason from public.contact_suppressions');

      expect(suppression.rows).toHaveLength(1);
      expect(suppression.rows[0]).toMatchObject({
        person_id: FIXTURE_IDS.personJonDavies,
        channel: 'linkedin',
        business_id: null,
        active: true,
        reason: 'explicit_dnc',
      });

      const lead = await sql.query<{ is_dnc: boolean; status: string }>(
        'select is_dnc, status from public.leads where id = $1',
        [FIXTURE_IDS.leadA3],
      );
      expect(lead.rows[0]).toEqual({ is_dnc: true, status: 'do_not_contact' });

      // across ALL outreach identities: the helper is identity-agnostic
      expect(
        await sql.query<{ blocked: boolean }>(
          'select public.is_dnc_blocked($1, $2) as blocked',
          [FIXTURE_IDS.personJonDavies, 'linkedin'],
        ),
      ).toMatchObject({ rows: [{ blocked: true }] });

      const suppressedElsewhere = await sql.query<{ blocked: boolean }>(
        'select public.is_dnc_blocked($1, $2) as blocked',
        [FIXTURE_IDS.personJonDavies, 'email'],
      );
      expect(suppressedElsewhere.rows[0]?.blocked).toBe(false);
    });
  });

  it('blocks mark_message_sent even under a different outreach identity', async () => {
    await h.asAdmin(async (sql) => {
      await accepted(sql, () =>
        sql.query(`select public.capture_reply($1, $2, $3, $4, $5, now())`, [
          FIXTURE_IDS.leadA3,
          'Do not contact me again.',
          'Do not contact',
          null,
          'dnc-test',
        ]),
      );

      const instance = await accepted(sql, () =>
        sql.query<{ id: string }>(
          `insert into public.message_instances
             (conversation_id, sequence_step_id, state, due_at, business_id, lead_id, step_order, step_kind)
           values ($1, $2, 'DYNAMIC', now(), $3, $4, 1, 'message')
           returning id`,
          [
            FIXTURE_IDS.conversationLeadA3,
            FIXTURE_IDS.stepMessage1,
            FIXTURE_IDS.businessA,
            FIXTURE_IDS.leadA3,
          ],
        ),
      );
      const instanceId = instance.rows[0]?.id;
      expect(instanceId).toBeDefined();

      const version = await accepted(sql, () =>
        sql.query<{ id: string }>(
          `insert into public.message_versions (message_instance_id, content, created_by)
           values ($1, 'Attempted outreach after DNC', $2) returning id`,
          [instanceId, FIXTURE_IDS.admin],
        ),
      );
      await sql.query('update public.message_instances set current_version_id = $1 where id = $2', [
        version.rows[0]?.id,
        instanceId,
      ]);

      // identityA2 is a *different* sender identity (managed by the manager)
      const error = await rejected(
        sql,
        () =>
          sql.query('select public.mark_message_sent($1, $2, $3)', [
            instanceId,
            FIXTURE_IDS.identityA2,
            'dnc-test',
          ]),
        '23514',
      );
      expect(error.message).toContain('Do Not Contact suppression');

      const state = await sql.query<{ state: string; sent_at: string | null }>(
        'select state, sent_at from public.message_instances where id = $1',
        [instanceId],
      );
      expect(state.rows[0]?.state).toBe('DYNAMIC');
      expect(state.rows[0]?.sent_at).toBeNull();
    });
  });

  it('a direct transition to SENT is blocked by the trigger too', async () => {
    await h.asAdmin(async (sql) => {
      await sql.query(`select public.capture_reply($1, $2, $3, $4, $5, now())`, [
        FIXTURE_IDS.leadA3,
        'stop',
        'Do not contact',
        null,
        'dnc-test',
      ]);

      const error = await rejected(
        sql,
        () =>
          sql.query(
            `insert into public.message_instances
               (conversation_id, state, sent_at, business_id, lead_id, step_order, step_kind)
             values ($1, 'SENT', now(), $2, $3, 2, 'followup')`,
            [FIXTURE_IDS.conversationLeadA3, FIXTURE_IDS.businessA, FIXTURE_IDS.leadA3],
          ),
        '23514',
      );
      expect(error.message).toMatch(/do-not-contact|Do Not Contact/);
    });
  });
});

describe('ordinary not interested', () => {
  it('creates a business-specific cooldown and no DNC suppression', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      await accepted(sql, () =>
        sql.query(`select public.capture_reply($1, $2, $3, $4, $5, now())`, [
          FIXTURE_IDS.leadA2,
          'Not interested right now, thanks.',
          'Not interested',
          null,
          'cooldown-test',
        ]),
      );

      const cooldown = await sql.query<{
        business_id: string;
        lead_id: string;
        reason: string;
        is_active: boolean;
        days: number;
      }>(
        `select business_id, lead_id, reason, is_active,
                round(extract(epoch from (ends_at - starts_at)) / 86400)::int as days
           from public.cooldowns`,
      );
      expect(cooldown.rows).toHaveLength(1);
      expect(cooldown.rows[0]).toMatchObject({
        business_id: FIXTURE_IDS.businessA,
        lead_id: FIXTURE_IDS.leadA2,
        reason: 'ordinary_not_interested',
        is_active: true,
        days: 90,
      });

      expect(
        await countOf(sql, 'select count(*)::int as n from public.contact_suppressions where person_id = $1', [
          FIXTURE_IDS.personSarahSmith,
        ]),
      ).toBe(0);

      expect(
        await sql.query<{ blocked: boolean }>(
          'select public.is_dnc_blocked($1, $2) as blocked',
          [FIXTURE_IDS.personSarahSmith, 'linkedin'],
        ),
      ).toMatchObject({ rows: [{ blocked: false }] });

      const lead = await sql.query<{ status: string; is_dnc: boolean }>(
        'select status, is_dnc from public.leads where id = $1',
        [FIXTURE_IDS.leadA2],
      );
      expect(lead.rows[0]).toEqual({ status: 'cooldown', is_dnc: false });
    });
  });
});

describe('reply pauses the sequence', () => {
  it('parks the enrollment and cancels pending steps', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const pendingBefore = await countOf(
        sql,
        'select count(*)::int as n from public.message_instances where lead_id = $1 and sent_at is null',
        [FIXTURE_IDS.leadA2],
      );
      expect(pendingBefore).toBeGreaterThan(0);

      await accepted(sql, () =>
        sql.query(`select public.capture_reply($1, $2, $3, $4, $5, now())`, [
          FIXTURE_IDS.leadA2,
          'Maybe later — ping me in Q3.',
          'Maybe later',
          'Warm, revisit later',
          'reply-test',
        ]),
      );

      const enrollment = await sql.query<{ state: string; paused_at: string | null; pause_reason: string }>(
        'select state, paused_at, pause_reason from public.sequence_enrollments where id = $1',
        [FIXTURE_IDS.enrollmentLeadA2],
      );
      expect(enrollment.rows[0]?.state).toBe('paused');
      expect(enrollment.rows[0]?.paused_at).not.toBeNull();
      expect(enrollment.rows[0]?.pause_reason).toBe('Maybe later');

      const pending = await sql.query<{ invalidated_at: string | null; regeneration_reason: string | null }>(
        `select invalidated_at, regeneration_reason from public.message_instances
          where lead_id = $1 and sent_at is null`,
        [FIXTURE_IDS.leadA2],
      );
      expect(pending.rows.length).toBeGreaterThan(0);
      for (const row of pending.rows) {
        expect(row.invalidated_at).not.toBeNull();
        expect(row.regeneration_reason).toBe('reply_received');
      }

      const lead = await sql.query<{ status: string; next_action_type: string }>(
        'select status, next_action_type from public.leads where id = $1',
        [FIXTURE_IDS.leadA2],
      );
      expect(lead.rows[0]).toEqual({ status: 'replied', next_action_type: 'review' });
    });
  });

  it('records the outcome with its reply reference', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const result = await accepted(sql, () =>
        sql.query<{ result: { interaction_id: string; outcome_id: string } }>(
          `select public.capture_reply($1, $2, $3, $4, $5, now()) as result`,
          [FIXTURE_IDS.leadA2, 'Interested, tell me more.', 'Interested', null, 'reply-test'],
        ),
      );

      const outcome = await sql.query<{ source_reply_id: string; is_terminal: boolean }>(
        'select source_reply_id, is_terminal from public.conversation_outcomes where id = $1',
        [result.rows[0]?.result.outcome_id],
      );
      expect(outcome.rows[0]?.source_reply_id).toBe(result.rows[0]?.result.interaction_id);
      expect(outcome.rows[0]?.is_terminal).toBe(false);
    });
  });
});

describe('capture_reply stores the exact inbound text', () => {
  const EXACT =
    'Hi — thanks for reaching out! 👋\n\n' +
    'We are NOT looking right now; "maybe" in Q3.\n' +
    '\tTabbed line with emoji 🎬 and symbols &<>|\\\'"\n' +
    'Last line.';

  it('stores the inbound text byte-for-byte', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const result = await accepted(sql, () =>
        sql.query<{ result: { interaction_id: string } }>(
          `select public.capture_reply($1, $2, $3, $4, $5, now()) as result`,
          [FIXTURE_IDS.leadA2, EXACT, 'No current need', 'internal note text', 'reply-test'],
        ),
      );

      const inbound = await sql.query<{ summary: string; type: string; direction: string; payload: { exact_text: string } }>(
        'select summary, type, direction, payload from public.interactions where id = $1',
        [result.rows[0]?.result.interaction_id],
      );
      expect(inbound.rows[0]?.summary).toBe(EXACT);
      expect(inbound.rows[0]?.payload.exact_text).toBe(EXACT);
      expect(inbound.rows[0]?.type).toBe('inbound_reply');
      expect(inbound.rows[0]?.direction).toBe('inbound');

      // the internal note is a separate record, never merged into the inbound text
      const note = await sql.query<{ body: string; is_internal: boolean }>(
        `select body, is_internal from public.notes where lead_id = $1 order by created_at desc limit 1`,
        [FIXTURE_IDS.leadA2],
      );
      expect(note.rows[0]?.body).toBe('internal note text');
      expect(note.rows[0]?.body).not.toBe(EXACT);
      expect(note.rows[0]?.is_internal).toBe(true);
    });
  });

  it('rejects an empty body and an unknown outcome', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      await rejected(
        sql,
        () =>
          sql.query('select public.capture_reply($1, $2, $3, $4, $5, now())', [
            FIXTURE_IDS.leadA2,
            '   ',
            'Other',
            null,
            'reply-test',
          ]),
        '23514',
      );

      await rejected(
        sql,
        () =>
          sql.query('select public.capture_reply($1, $2, $3, $4, $5, now())', [
            FIXTURE_IDS.leadA2,
            'text',
            'Not a real outcome',
            null,
            'reply-test',
          ]),
        '23514',
      );
    });
  });
});
