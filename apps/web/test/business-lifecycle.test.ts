/**
 * Business lifecycle: create and clone.
 *
 * The rule that matters is what a clone does *not* copy. spec: a new Business is a clean container —
 * structure can be templated, but leads, people, message history and outreach identities are records
 * of things that happened to a different business and must never be duplicated into another one. A
 * cloned message history would be indistinguishable from real history.
 *
 * This is also the only place the clone is covered by a test. It was uncovered, and it had a real
 * defect: it copied `sequences` rows without their versions or steps, so every cloned sequence was an
 * empty shell that could never produce a message.
 *
 * Each case builds its own source business. Sharing one would make a failure ambiguous — a clone
 * refuses a duplicate key, so a second test cloning the same source into the same name would fail for
 * a reason unrelated to what it asserts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadViewer, type Viewer } from '@/lib/actor';
import { cloneBusiness, createBusiness, getBusinessById } from '@/lib/repo/businesses';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;
let viewer: Viewer;

const ADMIN_ID = 'f2000000-0000-4000-8000-000000000001';

/** Builds a source business with one ICP, one published sequence (two steps) and real history. */
async function seedSource(suffix: string): Promise<{ businessId: string; personCount: number }> {
  const businessId = `f2000000-0000-4000-8000-0000000${suffix.padStart(5, '0')}`;
  const personId = `f2100000-0000-4000-8000-0000000${suffix.padStart(5, '0')}`;
  const leadId = `f2200000-0000-4000-8000-0000000${suffix.padStart(5, '0')}`;
  const icpId = `f2300000-0000-4000-8000-0000000${suffix.padStart(5, '0')}`;
  const sequenceId = `f2400000-0000-4000-8000-0000000${suffix.padStart(5, '0')}`;
  const versionId = `f2500000-0000-4000-8000-0000000${suffix.padStart(5, '0')}`;
  const conversationId = `f2600000-0000-4000-8000-0000000${suffix.padStart(5, '0')}`;
  const instanceId = `f2700000-0000-4000-8000-0000000${suffix.padStart(5, '0')}`;
  const messageVersionId = `f2800000-0000-4000-8000-0000000${suffix.padStart(5, '0')}`;

  await h.db.exec('set row_security = off');

  await h.db.query(
    `insert into public.businesses (id, key, name, status, focus, created_by)
     values ($1, $2, $3, 'active', 'Editing', $4)`,
    [businessId, `src-${suffix}`, `Source ${suffix}`, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources, can_use_profile_queue, can_delete_leads, created_by)
     values ($1, $2, 'admin', true, true, true, true, $1)`,
    [ADMIN_ID, businessId],
  );
  await h.db.query(
    `insert into public.icps (id, business_id, name, description, is_default, is_active, created_by)
     values ($1, $2, 'Agency owner', 'Owns a content agency', true, true, $3)`,
    [icpId, businessId, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.sequences (id, business_id, name, description, is_default, status, created_by)
     values ($1, $2, 'Default outreach', 'Three-step sequence', true, 'active', $3)`,
    [sequenceId, businessId, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.sequence_versions (id, sequence_id, version, status, published_at, created_by)
     values ($1, $2, 1, 'published', now(), $3)`,
    [versionId, sequenceId, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.sequence_steps
       (sequence_version_id, step_order, kind, name, delay_days, delay_basis, generation_mode)
     values ($1, 1, 'connection', 'Connection', 0, 'immediate', 'ai'),
            ($1, 2, 'followup', 'Follow-up', 3, 'after_previous', 'ai')`,
    [versionId],
  );
  await h.db.query(`update public.sequences set current_version_id = $2 where id = $1`, [
    sequenceId,
    versionId,
  ]);

  // History that must NOT be cloned.
  await h.db.query(`insert into public.people (id, full_name, created_by) values ($1, $2, $3)`, [
    personId,
    `Source Lead ${suffix}`,
    ADMIN_ID,
  ]);
  await h.db.query(
    `insert into public.leads (id, business_id, person_id, status, source_type, primary_icp_id, created_by)
     values ($1, $2, $3, 'ready', 'paste_list', $4, $5)`,
    [leadId, businessId, personId, icpId, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.lead_icp_matches (lead_id, icp_id, is_primary, reason)
     values ($1, $2, true, 'test')`,
    [leadId, icpId],
  );
  await h.db.query(
    `insert into public.conversations (id, business_id, lead_id, channel)
     values ($1, $2, $3, 'linkedin')`,
    [conversationId, businessId, leadId],
  );
  await h.db.query(
    `insert into public.source_evidence
       (business_id, person_id, lead_id, source, content_hash, observed_at, confidence, created_by)
     values ($1, $2, $3, 'LinkedIn manual import', $4, now(), 0.85, $5)`,
    [businessId, personId, leadId, `hash-${suffix}`, ADMIN_ID],
  );

  // A sent message with content. Written DYNAMIC-then-frozen because a direct SENT insert without a
  // version is now refused.
  await h.db.query(
    `insert into public.message_instances
       (id, conversation_id, state, business_id, lead_id, step_order, step_kind)
     values ($1, $2, 'DYNAMIC', $3, $4, 1, 'connection')`,
    [instanceId, conversationId, businessId, leadId],
  );
  await h.db.query(
    `insert into public.message_versions (id, message_instance_id, content, created_by)
     values ($1, $2, 'History that must not travel.', $3)`,
    [messageVersionId, instanceId, ADMIN_ID],
  );
  await h.db.query(
    `update public.message_instances set current_version_id = $2 where id = $1`,
    [instanceId, messageVersionId],
  );
  await h.db.query(
    `update public.message_instances set state = 'SENT', sent_at = now() where id = $1`,
    [instanceId],
  );

  await h.db.exec('set row_security = on');
  return { businessId, personCount: 1 };
}

beforeAll(async () => {
  h = await createAppHarness();
  await h.db.exec('set row_security = off');
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'clone-admin@nexus.test', 'Clone Admin', 'admin', 'active')`,
    [ADMIN_ID],
  );
  await h.db.exec('set row_security = on');
  viewer = await loadViewer({ kind: 'user', userId: ADMIN_ID });
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('cloneBusiness', () => {
  it('copies the container — business, ICPs, sequence versions and steps', async () => {
    const source = await seedSource('1');
    const result = await cloneBusiness(viewer, source.businessId, {
      key: 'clone-target-1',
      name: 'Target One',
      focus: 'Editing',
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const newId = result.id;
    if (newId === undefined) return;

    await h.db.exec('set row_security = off');

    const business = await h.db.query<{ status: string; focus: string | null }>(
      `select status, focus from public.businesses where id = $1`,
      [newId],
    );
    expect(business.rows[0]?.status).toBe('active');
    expect(business.rows[0]?.focus).toBe('Editing');

    const icps = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.icps where business_id = $1`,
      [newId],
    );
    expect(icps.rows[0]?.n).toBe(1);

    // The defect this test exists for: a sequence without its version has no steps, so it can never
    // produce a message. Copying the parent row alone produced an empty shell.
    const sequences = await h.db.query<{ id: string; current_version_id: string | null; status: string }>(
      `select id, current_version_id, status from public.sequences where business_id = $1`,
      [newId],
    );
    expect(sequences.rows).toHaveLength(1);
    const cloned = sequences.rows[0];
    expect(cloned?.status).toBe('draft');
    expect(cloned?.current_version_id).toBeTruthy();

    const steps = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.sequence_steps where sequence_version_id = $1`,
      [cloned?.current_version_id],
    );
    expect(steps.rows[0]?.n).toBe(2);

    await h.db.exec('set row_security = on');
  });

  it('does not copy leads, conversations, message history or evidence', async () => {
    const source = await seedSource('2');
    const result = await cloneBusiness(viewer, source.businessId, {
      key: 'clone-target-2',
      name: 'Target Two',
    });
    expect(result.error).toBeUndefined();
    const newId = result.id;
    if (newId === undefined) return;

    await h.db.exec('set row_security = off');

    for (const table of ['leads', 'conversations', 'message_instances', 'source_evidence']) {
      const rows = await h.db.query<{ n: number }>(
        `select count(*)::int as n from public.${table} where business_id = $1`,
        [newId],
      );
      expect(rows.rows[0]?.n, `${table} was cloned`).toBe(0);
    }

    const matches = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.lead_icp_matches m
         join public.leads l on l.id = m.lead_id where l.business_id = $1`,
      [newId],
    );
    expect(matches.rows[0]?.n).toBe(0);

    await h.db.exec('set row_security = on');
  });

  it('records the clone in the audit trail, naming the source', async () => {
    const source = await seedSource('3');
    const result = await cloneBusiness(viewer, source.businessId, {
      key: 'clone-target-3',
      name: 'Target Three',
    });
    const newId = result.id;
    if (newId === undefined) return;

    await h.db.exec('set row_security = off');
    const audit = await h.db.query<{ after_json: Record<string, unknown> | null }>(
      `select after_json from public.audit_events
        where entity_type = 'businesses' and entity_id = $1 and action = 'clone_business'`,
      [newId],
    );
    expect(audit.rows[0]?.after_json?.['cloned_from']).toBe(source.businessId);
    await h.db.exec('set row_security = on');
  });

  it('refuses a clone whose key is already taken', async () => {
    const source = await seedSource('4');
    await cloneBusiness(viewer, source.businessId, { key: 'clone-target-dup', name: 'Winner' });
    const second = await cloneBusiness(viewer, source.businessId, {
      key: 'clone-target-dup',
      name: 'Loser',
    });
    expect(second.ok).toBe(false);
  });
});

describe('createBusiness', () => {
  it('creates an empty business with no cloned structure', async () => {
    const result = await createBusiness(viewer, { key: 'brand-new-1', name: 'Brand New Co' });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const newId = result.id;
    if (newId === undefined) return;

    const business = await getBusinessById(viewer.actor, newId);
    expect(business?.key).toBe('brand-new-1');
    expect(business?.status).toBe('active');

    await h.db.exec('set row_security = off');
    const icps = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.icps where business_id = $1`,
      [newId],
    );
    expect(icps.rows[0]?.n).toBe(0);
    await h.db.exec('set row_security = on');
  });

  it('refuses a duplicate key', async () => {
    await createBusiness(viewer, { key: 'duplicate-key', name: 'First' });
    const second = await createBusiness(viewer, { key: 'duplicate-key', name: 'Second' });
    expect(second.ok).toBe(false);
  });
});
