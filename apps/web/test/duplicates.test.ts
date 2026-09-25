/**
 * Duplicate Review and Reactivation repository reads.
 *
 * Both of these screens were throwing in the browser. The causes were SQL referring to
 * columns the schema does not have:
 *
 *   * the duplicate-candidate select read `duplicate_candidates.incoming_lead_id`, which
 *     was never created — the incoming lead is derived from the person, the same way
 *     `merge_duplicate_candidate` derives it;
 *   * the reactivation read selected `sequence_enrollments.last_step_sent_at`, which is not
 *     in the table either — the last send comes from `message_instances`.
 *
 * A type check cannot catch that: the column list is a string. These tests execute the
 * queries against the real schema and under RLS as a real actor, which is where the
 * browser pass found the failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadViewer, type Viewer } from '@/lib/actor';
import { getDuplicateCounts, listDuplicateCandidates, resolveDuplicate } from '@/lib/repo/duplicates';
import { listReactivationCandidates } from '@/lib/repo/sequence';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;
let viewer: Viewer;

const ADMIN_ID = 'c0000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'c0000000-0000-4000-8000-000000000002';
const INCOMING_PERSON = 'c0000000-0000-4000-8000-000000000003';
const EXISTING_PERSON = 'c0000000-0000-4000-8000-000000000004';
const INCOMING_LEAD = 'c0000000-0000-4000-8000-000000000005';
const EXISTING_LEAD = 'c0000000-0000-4000-8000-000000000006';
const CANDIDATE_ID = 'c0000000-0000-4000-8000-000000000007';
const SEQUENCE_ID = 'c0000000-0000-4000-8000-000000000008';
const SEQUENCE_VERSION = 'c0000000-0000-4000-8000-000000000009';
const ENROLLMENT_ID = 'c0000000-0000-4000-8000-00000000000a';
const CONVERSATION_ID = 'c0000000-0000-4000-8000-00000000000b';
const MESSAGE_ID = 'c0000000-0000-4000-8000-00000000000c';
const MESSAGE_VERSION_ID = 'c0000000-0000-4000-8000-00000000000d';

beforeAll(async () => {
  h = await createAppHarness();

  // Fixtures go in with row security off, exactly as the demo seed does; the reads under
  // test then run as the admin with RLS on.
  await h.db.exec('set row_security = off');
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'duplicates-admin@nexus.test', 'Duplicates Admin', 'admin', 'active')`,
    [ADMIN_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by)
     values ($1, 'dup-test', 'Dup Test Co', 'active', $2)`,
    [BUSINESS_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources, can_use_profile_queue, can_delete_leads, created_by)
     values ($1, $2, 'admin', true, true, true, true, $1)`,
    [ADMIN_ID, BUSINESS_ID],
  );
  await h.db.query(
    `insert into public.people (id, full_name, normalized_name, job_title, created_by)
     values ($1, 'Incoming Person', 'incoming person', 'Head of Production', $3),
            ($2, 'Existing Person', 'existing person', 'Head of Production', $3)`,
    [INCOMING_PERSON, EXISTING_PERSON, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.leads (id, business_id, person_id, status, source_type, created_by)
     values ($1, $3, $4, 'ready', 'file_csv', $5),
            ($2, $3, $6, 'ready', 'manual_add', $5)`,
    [INCOMING_LEAD, EXISTING_LEAD, BUSINESS_ID, INCOMING_PERSON, ADMIN_ID, EXISTING_PERSON],
  );
  await h.db.query(
    `insert into public.duplicate_candidates
       (id, business_id, incoming_person_id, existing_person_id, existing_lead_id, match_reason, confidence, status, payload)
     values ($1, $2, $3, $4, $5, 'linkedin_url', 0.94, 'open', '{"import_batch_id":"c0000000-0000-4000-8000-00000000000d"}'::jsonb)`,
    [CANDIDATE_ID, BUSINESS_ID, INCOMING_PERSON, EXISTING_PERSON, EXISTING_LEAD],
  );

  // A dormant enrollment with one sent message, so the reactivation read has real history.
  await h.db.query(
    `insert into public.sequences (id, business_id, name, is_default, status, created_by)
     values ($1, $2, 'Dup Test Sequence', true, 'active', $3)`,
    [SEQUENCE_ID, BUSINESS_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.sequence_versions (id, sequence_id, version, status, published_at, published_by, change_summary)
     values ($1, $2, 1, 'published', now(), $3, 'test')`,
    [SEQUENCE_VERSION, SEQUENCE_ID, ADMIN_ID],
  );
  await h.db.query(`update public.sequences set current_version_id = $2 where id = $1`, [
    SEQUENCE_ID,
    SEQUENCE_VERSION,
  ]);
  await h.db.query(
    `insert into public.sequence_enrollments
       (id, business_id, lead_id, sequence_id, sequence_version_id, state, current_step_order, started_at, dormant_at, reactivation_due_at, created_by)
     values ($1, $2, $3, $4, $5, 'dormant', 3, now() - interval '40 days', now() - interval '20 days', now() + interval '2 days', $6)`,
    [ENROLLMENT_ID, BUSINESS_ID, INCOMING_LEAD, SEQUENCE_ID, SEQUENCE_VERSION, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.conversations (id, business_id, lead_id, channel, default_owner_user_id, last_outbound_at)
     values ($1, $2, $3, 'linkedin', $4, now() - interval '25 days')`,
    [CONVERSATION_ID, BUSINESS_ID, INCOMING_LEAD, ADMIN_ID],
  );
  // A sent message the reactivation candidate's "last send" is derived from. It needs a version with
  // content: a SENT instance with no `current_version_id` is refused by the sent-content trigger,
  // because such a row can never be displayed as history.
  await h.db.query(
    `insert into public.message_instances
       (id, conversation_id, state, due_at, business_id, lead_id, step_order, step_kind)
     values ($1, $2, 'DYNAMIC', now() - interval '25 days', $3, $4, 1, 'message')`,
    [MESSAGE_ID, CONVERSATION_ID, BUSINESS_ID, INCOMING_LEAD],
  );
  await h.db.query(
    `insert into public.message_versions (id, message_instance_id, content, created_by)
     values ($1, $2, 'An earlier outreach message the history view must be able to show.', $3)`,
    [MESSAGE_VERSION_ID, MESSAGE_ID, ADMIN_ID],
  );
  await h.db.query(
    `update public.message_instances
        set current_version_id = $2, state = 'SENT', sent_at = now() - interval '25 days'
      where id = $1`,
    [MESSAGE_ID, MESSAGE_VERSION_ID],
  );
  await h.db.exec('set row_security = on');

  viewer = await loadViewer({ kind: 'user', userId: ADMIN_ID });
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('duplicate review reads', () => {
  it('lists an open candidate and resolves the incoming lead from the person', async () => {
    const candidates = await listDuplicateCandidates(viewer.actor, BUSINESS_ID, 'open', 50);

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    expect(candidate?.id).toBe(CANDIDATE_ID);
    expect(candidate?.incoming?.fullName).toBe('Incoming Person');
    expect(candidate?.existing?.fullName).toBe('Existing Person');

    // The incoming side has no lead column; it must be derived, and derived correctly.
    expect(candidate?.incomingLead?.id).toBe(INCOMING_LEAD);
    expect(candidate?.existingLead?.id).toBe(EXISTING_LEAD);
    expect(candidate?.importBatchId).toBe('c0000000-0000-4000-8000-00000000000d');
  });

  it('counts the statuses', async () => {
    const counts = await getDuplicateCounts(viewer.actor, BUSINESS_ID);
    expect(counts).toEqual({ open: 1, merged: 0, keptSeparate: 0, skipped: 0 });
  });

  it('resolves through the database function and leaves nothing open', async () => {
    const result = await resolveDuplicate(viewer, CANDIDATE_ID, 'keep_separate');
    expect(result.ok).toBe(true);
    expect(result.status).toBe('kept_separate');

    const counts = await getDuplicateCounts(viewer.actor, BUSINESS_ID);
    expect(counts.open).toBe(0);
    expect(counts.keptSeparate).toBe(1);
  });
});

describe('reactivation reads', () => {
  it('lists the dormant candidate with the last send derived from its messages', async () => {
    const candidates = await listReactivationCandidates(viewer.actor, BUSINESS_ID, 50);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.leadId).toBe(INCOMING_LEAD);
    expect(candidates[0]?.personName).toBe('Incoming Person');
    expect(candidates[0]?.lastStepOrder).toBe(3);
    // The bug being guarded: this used to read a column that does not exist.
    expect(candidates[0]?.lastStepSentAt).not.toBeNull();
  });
});
