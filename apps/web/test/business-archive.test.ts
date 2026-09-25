/**
 * Business lifecycle: archive, restore, and the guarded permanent delete.
 *
 * spec `business_units`: archiving is the non-destructive way to stop a business. It must take the
 * business out of the active selectors and stop *new* business-specific work, while preserving every
 * lead, message, reply, task and audit row — and it must be possible to undo. Permanent deletion is
 * the destructive alternative and is allowed only where there is nothing to destroy.
 *
 * Two properties are load-bearing and each has a test that would fail without them:
 *
 *   * **Archiving blocks new work at the database boundary, not only in one repository.** Each case
 *     inserts directly, so a future caller that forgets to check `business_is_open` still cannot create
 *     a lead, an enrolment, a message instance or an import in an archived business.
 *   * **A business with history cannot be deleted at all**, including by an admin, including with the
 *     confirmation string — because the cascade would destroy records that cannot be reconstructed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadViewer, withActor, type Viewer } from '@/lib/actor';
import {
  archiveBusiness,
  deleteBusinessPermanently,
  getBusinessProtectedHistory,
  getBusinessBySlug,
  listBusinesses,
  restoreBusiness,
  summariseProtectedHistory,
} from '@/lib/repo/businesses';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;
let admin: Viewer;
let ordinary: Viewer;

const ADMIN_ID = 'b3000000-0000-4000-8000-000000000001';
const USER_ID = 'b3000000-0000-4000-8000-000000000002';
const BUSINESS_ID = 'b3000000-0000-4000-8000-000000000003';
const OTHER_BUSINESS_ID = 'b3000000-0000-4000-8000-000000000004';
const PERSON_ID = 'b3000000-0000-4000-8000-000000000005';
const LEAD_ID = 'b3000000-0000-4000-8000-000000000006';
const CONVERSATION_ID = 'b3000000-0000-4000-8000-000000000007';
const INSTANCE_ID = 'b3000000-0000-4000-8000-000000000008';
const MESSAGE_VERSION_ID = 'b3000000-0000-4000-8000-000000000009';
const IDENTITY_ID = 'b3000000-0000-4000-8000-00000000000a';
const SEQUENCE_ID = 'b3000000-0000-4000-8000-00000000000b';
const SEQUENCE_VERSION_ID = 'b3000000-0000-4000-8000-00000000000c';
const ENROLLMENT_ID = 'b3000000-0000-4000-8000-00000000000d';

beforeAll(async () => {
  h = await createAppHarness();
  await h.db.exec('set row_security = off');

  await h.db.query(
    `insert into public.users (id, email, full_name, role, status) values
       ($1, 'lifecycle-admin@nexus.test', 'Lifecycle Admin', 'admin', 'active'),
       ($2, 'lifecycle-user@nexus.test', 'Lifecycle User', 'user', 'active')`,
    [ADMIN_ID, USER_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by) values
       ($1, 'lifecycle-live', 'Lifecycle Live', 'active', $3),
       ($2, 'lifecycle-empty', 'Lifecycle Empty', 'active', $3)`,
    [BUSINESS_ID, OTHER_BUSINESS_ID, ADMIN_ID],
  );
  // Both the admin and the ordinary user are granted access, so "blocked" cases cannot pass merely
  // because the actor could not see the business.
  await h.db.query(
    `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources, can_use_profile_queue, can_delete_leads, created_by)
     values ($1, $3, 'admin', true, true, true, true, $1),
            ($2, $3, 'user', true, true, true, false, $1)`,
    [ADMIN_ID, USER_ID, BUSINESS_ID],
  );

  await h.db.query(
    `insert into public.people (id, full_name, created_by) values ($1, 'Lifecycle Person', $2)`,
    [PERSON_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.leads (id, business_id, person_id, status, source_type, created_by)
     values ($1, $2, $3, 'ready', 'paste_list', $4)`,
    [LEAD_ID, BUSINESS_ID, PERSON_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.outreach_identities
       (id, platform, display_name, status, managed_by_user_id, created_by)
     values ($1, 'linkedin', 'Lifecycle Identity', 'active', $2, $2)`,
    [IDENTITY_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.outreach_identity_business_access (outreach_identity_id, business_id, created_by)
     values ($1, $2, $3)`,
    [IDENTITY_ID, BUSINESS_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.conversations (id, business_id, lead_id, channel, sender_identity_id)
     values ($1, $2, $3, 'linkedin', $4)`,
    [CONVERSATION_ID, BUSINESS_ID, LEAD_ID, IDENTITY_ID],
  );

  // A sent message with content and an identity event: the history that must survive archiving.
  await h.db.query(
    `insert into public.message_instances
       (id, conversation_id, state, business_id, lead_id, step_order, step_kind)
     values ($1, $2, 'DYNAMIC', $3, $4, 1, 'message')`,
    [INSTANCE_ID, CONVERSATION_ID, BUSINESS_ID, LEAD_ID],
  );
  await h.db.query(
    `insert into public.message_versions (id, message_instance_id, content, created_by)
     values ($1, $2, 'The exact text this person was sent.', $3)`,
    [MESSAGE_VERSION_ID, INSTANCE_ID, ADMIN_ID],
  );
  await h.db.query(
    `update public.message_instances set current_version_id = $2 where id = $1`,
    [INSTANCE_ID, MESSAGE_VERSION_ID],
  );
  // Marked SENT directly rather than through `mark_message_sent`: that RPC is `security definer` and
  // calls `assert_business_scope`, which needs the transaction-local claims `withActor` installs. The
  // fixture only needs the resulting state, and the repository's send path is covered elsewhere.
  await h.db.query(
    `update public.message_instances set state = 'SENT', sent_at = now() where id = $1`,
    [INSTANCE_ID],
  );
  await h.db.query(
    `insert into public.message_events
       (message_instance_id, event_type, business_id, lead_id, outreach_identity_id, message_version_id)
     values ($1, 'sent', $2, $3, $4, $5)`,
    [INSTANCE_ID, BUSINESS_ID, LEAD_ID, IDENTITY_ID, MESSAGE_VERSION_ID],
  );

  await h.db.query(
    `insert into public.sequences (id, business_id, name, is_default, status, created_by)
     values ($1, $2, 'Lifecycle sequence', true, 'active', $3)`,
    [SEQUENCE_ID, BUSINESS_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.sequence_versions (id, sequence_id, version, status, published_at, created_by)
     values ($1, $2, 1, 'published', now(), $3)`,
    [SEQUENCE_VERSION_ID, SEQUENCE_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.sequence_steps
       (sequence_version_id, step_order, kind, name, delay_days, delay_basis, generation_mode)
     values ($1, 1, 'message', 'Step one', 0, 'immediate', 'ai')`,
    [SEQUENCE_VERSION_ID],
  );
  await h.db.query(
    `insert into public.sequence_enrollments
       (id, business_id, lead_id, sequence_id, sequence_version_id, state, created_by)
     values ($1, $2, $3, $4, $5, 'active', $6)`,
    [ENROLLMENT_ID, BUSINESS_ID, LEAD_ID, SEQUENCE_ID, SEQUENCE_VERSION_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.tasks (business_id, lead_id, title, type, priority, status, created_by)
     values ($1, $2, 'Follow up with Lifecycle Person', 'follow_up', 'normal', 'open', $3)`,
    [BUSINESS_ID, LEAD_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.notes (business_id, lead_id, person_id, author_user_id, body, is_internal)
     values ($1, $2, $3, $4, 'An internal note that must survive.', true)`,
    [BUSINESS_ID, LEAD_ID, PERSON_ID, ADMIN_ID],
  );

  await h.db.exec('set row_security = on');
  admin = await loadViewer({ kind: 'user', userId: ADMIN_ID });
  ordinary = await loadViewer({ kind: 'user', userId: USER_ID });
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('archiveBusiness', () => {
  it('archives, reports what was preserved, and audits the transition', async () => {
    const result = await archiveBusiness(admin, BUSINESS_ID, 'client paused the engagement');

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.alreadyArchived).toBe(false);
    expect(result.history?.leads).toBe(1);
    expect(result.history?.sentMessages).toBe(1);
    expect(result.history?.tasks).toBe(1);

    await h.db.exec('set row_security = off');
    const business = await h.db.query<{ status: string }>(
      `select status from public.businesses where id = $1`,
      [BUSINESS_ID],
    );
    expect(business.rows[0]?.status).toBe('archived');

    const audit = await h.db.query<{ after_json: Record<string, unknown> | null }>(
      `select after_json from public.audit_events
        where entity_type = 'businesses' and entity_id = $1 and action = 'archive_business'`,
      [BUSINESS_ID],
    );
    expect(audit.rows[0]?.after_json?.['reason']).toBe('client paused the engagement');
    await h.db.exec('set row_security = on');
  });

  it('is idempotent, so a retried request is not reported as a failure', async () => {
    const again = await archiveBusiness(admin, BUSINESS_ID);
    expect(again.ok).toBe(true);
    expect(again.alreadyArchived).toBe(true);
  });

  it('preserves leads, messages, replies, tasks and notes', async () => {
    await h.db.exec('set row_security = off');

    const leads = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.leads where business_id = $1`,
      [BUSINESS_ID],
    );
    expect(leads.rows[0]?.n).toBe(1);

    // The exact text sent is still readable — that is the whole point of archiving rather than deleting.
    const content = await h.db.query<{ content: string }>(
      `select mv.content from public.message_versions mv
        where mv.id = $1`,
      [MESSAGE_VERSION_ID],
    );
    expect(content.rows[0]?.content).toBe('The exact text this person was sent.');

    const tasks = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.tasks where business_id = $1`,
      [BUSINESS_ID],
    );
    expect(tasks.rows[0]?.n).toBe(1);

    const notes = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.notes where business_id = $1`,
      [BUSINESS_ID],
    );
    expect(notes.rows[0]?.n).toBe(1);

    // Attribution survives too: the sent event still names the identity.
    const events = await h.db.query<{ outreach_identity_id: string | null }>(
      `select outreach_identity_id from public.message_events where message_instance_id = $1`,
      [INSTANCE_ID],
    );
    expect(events.rows[0]?.outreach_identity_id).toBe(IDENTITY_ID);

    await h.db.exec('set row_security = on');
  });

  it('pauses active enrolments and invalidates unsent outreach', async () => {
    await h.db.exec('set row_security = off');
    const enrollment = await h.db.query<{ state: string }>(
      `select state from public.sequence_enrollments where id = $1`,
      [ENROLLMENT_ID],
    );
    expect(enrollment.rows[0]?.state).toBe('paused');

    const instance = await h.db.query<{ regeneration_reason: string | null }>(
      `select regeneration_reason from public.message_instances where id = $1`,
      [INSTANCE_ID],
    );
    // A SENT instance is history and must not be invalidated.
    expect(instance.rows[0]?.regeneration_reason).toBeNull();
    await h.db.exec('set row_security = on');
  });

  it('removes the business from the active selectors', async () => {
    const active = await listBusinesses(admin.actor);
    expect(active.map((business) => business.id)).not.toContain(BUSINESS_ID);

    // Still readable on request: archiving is not hiding, and a report must be able to name it.
    const all = await listBusinesses(admin.actor, { includeArchived: true });
    expect(all.map((business) => business.id)).toContain(BUSINESS_ID);

    // Direct navigation still resolves, so an old link reports "archived" rather than "not found".
    const bySlug = await getBusinessBySlug(admin.actor, 'lifecycle-live');
    expect(bySlug?.status).toBe('archived');
  });

  it('blocks new leads, enrolments, message instances and imports at the database boundary', async () => {
    await h.db.exec('set row_security = off');

    await expect(
      h.db.query(
        `insert into public.leads (business_id, person_id, status, source_type, created_by)
         values ($1, $2, 'ready', 'paste_list', $3)`,
        [BUSINESS_ID, PERSON_ID, ADMIN_ID],
      ),
    ).rejects.toThrow(/does not accept new work/i);

    await expect(
      h.db.query(
        `insert into public.sequence_enrollments
           (business_id, lead_id, sequence_id, sequence_version_id, state)
         values ($1, $2, $3, $4, 'active')`,
        [BUSINESS_ID, LEAD_ID, SEQUENCE_ID, SEQUENCE_VERSION_ID],
      ),
    ).rejects.toThrow(/does not accept new work/i);

    await expect(
      h.db.query(
        `insert into public.message_instances
           (conversation_id, state, business_id, lead_id, step_order, step_kind)
         values ($1, 'DYNAMIC', $2, $3, 2, 'followup')`,
        [CONVERSATION_ID, BUSINESS_ID, LEAD_ID],
      ),
    ).rejects.toThrow(/does not accept new work/i);

    await expect(
      h.db.query(
        `insert into public.import_batches (business_id, source, status, created_by)
         values ($1, 'paste_list', 'pending', $2)`,
        [BUSINESS_ID, ADMIN_ID],
      ),
    ).rejects.toThrow(/does not accept new work/i);

    await h.db.exec('set row_security = on');
  });

  it('reports an archived business as closed through business_is_open', async () => {
    const open = await withActor(admin.actor, async (sql) => {
      const result = await sql.query<{ open: boolean }>(`select public.business_is_open($1) as open`, [
        BUSINESS_ID,
      ]);
      return result.rows[0]?.open;
    });
    expect(open).toBe(false);
  });

  it('refuses a non-admin', async () => {
    const result = await archiveBusiness(ordinary, BUSINESS_ID);
    expect(result.ok).toBe(false);
  });
});

describe('restoreBusiness', () => {
  it('returns the business to the active selectors and re-opens it for new work', async () => {
    const result = await restoreBusiness(admin, BUSINESS_ID);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);

    const active = await listBusinesses(admin.actor);
    expect(active.map((business) => business.id)).toContain(BUSINESS_ID);

    // The boundary is open again, so a direct insert succeeds.
    await h.db.exec('set row_security = off');
    const created = await h.db.query<{ id: string }>(
      `insert into public.tasks (business_id, lead_id, title, type, priority, status, created_by)
       values ($1, $2, 'A task created after restore', 'follow_up', 'normal', 'open', $3)
       returning id`,
      [BUSINESS_ID, LEAD_ID, ADMIN_ID],
    );
    expect(created.rows[0]?.id).toBeTruthy();
    await h.db.exec('set row_security = on');

    const audit = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events
        where entity_type = 'businesses' and entity_id = $1 and action = 'restore_business'`,
      [BUSINESS_ID],
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it('is idempotent on an active business', async () => {
    const again = await restoreBusiness(admin, BUSINESS_ID);
    expect(again.ok).toBe(true);
  });
});

describe('deleteBusinessPermanently', () => {
  it('refuses a business with protected history, naming what would be lost', async () => {
    const result = await deleteBusinessPermanently(admin, BUSINESS_ID, 'lifecycle-live');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/protected history/i);
    // The refusal must tell the operator what was found, or it is not actionable.
    expect(result.error).toMatch(/leads/);
    expect(result.error).toMatch(/archive/i);

    // And the business is still there.
    expect(await getBusinessBySlug(admin.actor, 'lifecycle-live')).not.toBeNull();
  });

  it('requires the business key as typed confirmation', async () => {
    const result = await deleteBusinessPermanently(admin, OTHER_BUSINESS_ID, 'wrong-key');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/type the business key/i);
  });

  it('deletes a business that holds nothing', async () => {
    const result = await deleteBusinessPermanently(admin, OTHER_BUSINESS_ID, 'lifecycle-empty');
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);

    await h.db.exec('set row_security = off');
    const row = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.businesses where id = $1`,
      [OTHER_BUSINESS_ID],
    );
    expect(row.rows[0]?.n).toBe(0);

    const audit = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events
        where entity_type = 'businesses' and action = 'delete'`,
    );
    expect(audit.rows[0]?.n).toBeGreaterThan(0);
    await h.db.exec('set row_security = on');
  });

  it('refuses a direct delete of a business with history, so no path cascades', async () => {
    // The repository refuses before it gets here; this asserts the trigger, which is what holds for a
    // caller that does not come through the repository.
    await h.db.exec('set row_security = off');
    await expect(
      h.db.query(`delete from public.businesses where id = $1`, [BUSINESS_ID]),
    ).rejects.toThrow(/protected history/i);
    await h.db.exec('set row_security = on');
  });
});

describe('the protected-history census', () => {
  it('counts every record a delete would destroy', async () => {
    const history = await getBusinessProtectedHistory(admin.actor, BUSINESS_ID);
    expect(history.leads).toBe(1);
    expect(history.sentMessages).toBe(1);
    expect(history.messageEvents).toBe(1);
    expect(history.conversations).toBe(1);
    expect(history.notes).toBe(1);
    expect(history.tasks).toBe(2);
    expect(history.auditEvents).toBeGreaterThan(0);

    const { total, parts } = summariseProtectedHistory(history);
    expect(total).toBeGreaterThan(0);
    expect(parts.length).toBeGreaterThan(0);
  });

  it('is empty for a business that was never used', async () => {
    await h.db.exec('set row_security = off');
    const freshId = 'b3000000-0000-4000-8000-0000000000ff';
    await h.db.query(
      `insert into public.businesses (id, key, name, status, created_by)
       values ($1, 'lifecycle-fresh', 'Fresh', 'active', $2)`,
      [freshId, ADMIN_ID],
    );
    await h.db.exec('set row_security = on');

    const history = await getBusinessProtectedHistory(admin.actor, freshId);
    expect(summariseProtectedHistory(history).total).toBe(0);
  });
});
