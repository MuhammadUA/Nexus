/**
 * Outreach identity lifecycle: unassign, archive, and safe delete.
 *
 * Transfer already existed. The rest of the lifecycle did not, and one of the missing pieces was a
 * silent data-loss path: every foreign key that points at `outreach_identities` is `on delete set
 * null`, so deleting an identity that has sent messages does not fail — it blanks the sender on every
 * one of them. The message text survives with nobody attributed to it, and nothing reports the loss.
 *
 * Four properties are load-bearing, and each has a test that fails without it:
 *
 *   * **Archive stops new work for everyone, admins included.** `identity_usable_by_actor` used to test
 *     `is_admin()` before looking at the identity at all, so an admin could send as a retired identity.
 *   * **Archive is terminal.** A reactivation would make the historical attribution of everything the
 *     identity sent ambiguous, so the database refuses it.
 *   * **Deletion is refused when the identity carries attribution**, with a typed rejection the UI can
 *     branch on rather than a message to pattern-match.
 *   * **The refusal holds at the database boundary**, so a path that does not come through the
 *     repository cannot silently orphan the attribution.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadViewer, withActor, type Viewer } from '@/lib/actor';
import { companionIdentities } from '@/lib/repo/companion';
import {
  archiveIdentity,
  assignIdentityManager,
  deleteIdentitySafely,
  getIdentity,
  getIdentityAttribution,
  listIdentities,
  summariseAttribution,
  unassignIdentity,
} from '@/lib/repo/identities';
import { listIdentityOptions } from '@/lib/repo/leads';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;
let admin: Viewer;
let ordinary: Viewer;

const ADMIN_ID = 'c3000000-0000-4000-8000-000000000001';
const USER_ID = 'c3000000-0000-4000-8000-000000000002';
const BUSINESS_ID = 'c3000000-0000-4000-8000-000000000003';
const PERSON_ID = 'c3000000-0000-4000-8000-000000000004';
const LEAD_ID = 'c3000000-0000-4000-8000-000000000005';
const CONVERSATION_ID = 'c3000000-0000-4000-8000-000000000006';
const INSTANCE_ID = 'c3000000-0000-4000-8000-000000000007';
const MESSAGE_VERSION_ID = 'c3000000-0000-4000-8000-000000000008';

/** The identity that sent a message — the case that must not be deletable. */
const USED_IDENTITY_ID = 'c3000000-0000-4000-8000-000000000009';
/** An identity that never sent anything — the case that is deletable. */
const CLEAN_IDENTITY_ID = 'c3000000-0000-4000-8000-00000000000a';
/** An identity used for the unassign cases. */
const UNASSIGNED_IDENTITY_ID = 'c3000000-0000-4000-8000-00000000000b';

beforeAll(async () => {
  h = await createAppHarness();
  await h.db.exec('set row_security = off');

  await h.db.query(
    `insert into public.users (id, email, full_name, role, status) values
       ($1, 'identitylife-admin@nexus.test', 'Identity Admin', 'admin', 'active'),
       ($2, 'identitylife-user@nexus.test', 'Identity User', 'user', 'active')`,
    [ADMIN_ID, USER_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by)
     values ($1, 'identity-lifecycle', 'Identity Lifecycle Co', 'active', $2)`,
    [BUSINESS_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources, can_use_profile_queue, can_delete_leads, created_by)
     values ($1, $3, 'admin', true, true, true, true, $1),
            ($2, $3, 'user', true, true, true, false, $1)`,
    [ADMIN_ID, USER_ID, BUSINESS_ID],
  );

  await h.db.query(
    `insert into public.outreach_identities
       (id, platform, display_name, status, managed_by_user_id, created_by) values
       ($1, 'linkedin', 'Used Identity',  'active', $4, $4),
       ($2, 'linkedin', 'Clean Identity', 'active', $4, $4),
       ($3, 'linkedin', 'Spare Identity', 'active', $4, $4)`,
    [USED_IDENTITY_ID, CLEAN_IDENTITY_ID, UNASSIGNED_IDENTITY_ID, ADMIN_ID],
  );
  // Every identity is granted the business, so "blocked" cases cannot pass merely because the identity
  // was not usable in that business to begin with.
  for (const identityId of [USED_IDENTITY_ID, CLEAN_IDENTITY_ID, UNASSIGNED_IDENTITY_ID]) {
    await h.db.query(
      `insert into public.outreach_identity_business_access (outreach_identity_id, business_id, created_by)
       values ($1, $2, $3)`,
      [identityId, BUSINESS_ID, ADMIN_ID],
    );
  }

  await h.db.query(
    `insert into public.people (id, full_name, created_by) values ($1, 'Identity Person', $2)`,
    [PERSON_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.leads (id, business_id, person_id, status, source_type, outreach_identity_id, created_by)
     values ($1, $2, $3, 'ready', 'paste_list', $4, $5)`,
    [LEAD_ID, BUSINESS_ID, PERSON_ID, USED_IDENTITY_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.conversations (id, business_id, lead_id, channel, sender_identity_id)
     values ($1, $2, $3, 'linkedin', $4)`,
    [CONVERSATION_ID, BUSINESS_ID, LEAD_ID, USED_IDENTITY_ID],
  );
  await h.db.query(
    `insert into public.message_instances
       (id, conversation_id, state, business_id, lead_id, step_order, step_kind)
     values ($1, $2, 'DYNAMIC', $3, $4, 1, 'message')`,
    [INSTANCE_ID, CONVERSATION_ID, BUSINESS_ID, LEAD_ID],
  );
  await h.db.query(
    `insert into public.message_versions (id, message_instance_id, content, created_by)
     values ($1, $2, 'Sent by the used identity.', $3)`,
    [MESSAGE_VERSION_ID, INSTANCE_ID, ADMIN_ID],
  );
  await h.db.query(
    `update public.message_instances set current_version_id = $2 where id = $1`,
    [INSTANCE_ID, MESSAGE_VERSION_ID],
  );
  await h.db.query(
    `update public.message_instances set state = 'SENT', sent_at = now() where id = $1`,
    [INSTANCE_ID],
  );
  // The sent event is the only place the CRM records who actually reached a person: `message_instances`
  // has no identity column.
  await h.db.query(
    `insert into public.message_events
       (message_instance_id, event_type, business_id, lead_id, outreach_identity_id, message_version_id)
     values ($1, 'sent', $2, $3, $4, $5)`,
    [INSTANCE_ID, BUSINESS_ID, LEAD_ID, USED_IDENTITY_ID, MESSAGE_VERSION_ID],
  );

  await h.db.exec('set row_security = on');
  admin = await loadViewer({ kind: 'user', userId: ADMIN_ID });
  ordinary = await loadViewer({ kind: 'user', userId: USER_ID });
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('the attribution census', () => {
  it('counts the sent messages an identity would be erased from', async () => {
    const attribution = await getIdentityAttribution(admin.actor, USED_IDENTITY_ID);
    expect(attribution.sentMessages).toBe(1);
    expect(attribution.conversations).toBe(1);
    expect(attribution.leads).toBe(1);

    const { total, parts } = summariseAttribution(attribution);
    expect(total).toBeGreaterThan(0);
    expect(parts.join(' ')).toContain('sent messages');
  });

  it('is empty for an identity that never sent anything', async () => {
    const attribution = await getIdentityAttribution(admin.actor, CLEAN_IDENTITY_ID);
    expect(summariseAttribution(attribution).total).toBe(0);
  });
});

describe('unassignIdentity', () => {
  it('releases the identity and audits the change', async () => {
    const result = await unassignIdentity(admin, UNASSIGNED_IDENTITY_ID, 'operator left');

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);

    const identity = await getIdentity(admin.actor, UNASSIGNED_IDENTITY_ID);
    expect(identity?.managedByUserId).toBeNull();

    await h.db.exec('set row_security = off');
    const audit = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events
        where entity_type = 'outreach_identities' and entity_id = $1 and action = 'identity_unassign'`,
      [UNASSIGNED_IDENTITY_ID],
    );
    expect(audit.rows[0]?.n).toBe(1);
    await h.db.exec('set row_security = on');
  });

  it('does not write an identity_transfers row, because nobody took it over', async () => {
    // A transfer row names a recipient; "nobody has this now" is not a transfer, and recording it as
    // one would put a row in the transfer log that answers no question.
    await h.db.exec('set row_security = off');
    const transfers = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.identity_transfers where outreach_identity_id = $1`,
      [UNASSIGNED_IDENTITY_ID],
    );
    expect(transfers.rows[0]?.n).toBe(0);
    await h.db.exec('set row_security = on');
  });

  it('reports a typed code when the identity is not assigned', async () => {
    const result = await unassignIdentity(admin, UNASSIGNED_IDENTITY_ID);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('identity_not_assigned');
  });

  it('reports a typed code for an unknown identity', async () => {
    const result = await unassignIdentity(admin, 'c3000000-0000-4000-8000-0000000000ff');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('identity_not_found');
  });

  it('can be assigned again afterwards, so unassign is not terminal', async () => {
    const result = await assignIdentityManager(admin, UNASSIGNED_IDENTITY_ID, USER_ID, {
      confirmed: false,
      note: null,
    });
    expect(result.ok).toBe(true);
    const identity = await getIdentity(admin.actor, UNASSIGNED_IDENTITY_ID);
    expect(identity?.managedByUserId).toBe(USER_ID);
  });
});

describe('archiveIdentity', () => {
  it('archives the identity, revokes live browser sessions and audits the change', async () => {
    await h.db.exec('set row_security = off');
    await h.db.query(
      `insert into public.browser_sessions
         (user_id, browser_fingerprint_or_install_id, outreach_identity_id, status)
       values ($1, 'lifecycle-install', $2, 'active')`,
      [ADMIN_ID, USED_IDENTITY_ID],
    );
    await h.db.exec('set row_security = on');

    const result = await archiveIdentity(admin, USED_IDENTITY_ID, 'account closed');

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.attribution?.sentMessages).toBe(1);

    const identity = await getIdentity(admin.actor, USED_IDENTITY_ID);
    expect(identity?.status).toBe('retired');

    await h.db.exec('set row_security = off');
    // A bound browser profile would otherwise keep sending as an identity that has been closed.
    const sessions = await h.db.query<{ status: string; revoked_at: string | null }>(
      `select status, revoked_at from public.browser_sessions where outreach_identity_id = $1`,
      [USED_IDENTITY_ID],
    );
    expect(sessions.rows[0]?.status).toBe('revoked');
    expect(sessions.rows[0]?.revoked_at).not.toBeNull();

    const audit = await h.db.query<{ after_json: Record<string, unknown> | null }>(
      `select after_json from public.audit_events
        where entity_type = 'outreach_identities' and entity_id = $1 and action = 'identity_archive'`,
      [USED_IDENTITY_ID],
    );
    expect(audit.rows[0]?.after_json?.['status']).toBe('retired');
    expect(audit.rows[0]?.after_json?.['revoked_sessions']).toBe(1);
    await h.db.exec('set row_security = on');
  });

  it('is idempotent, reporting a typed code the second time', async () => {
    const again = await archiveIdentity(admin, USED_IDENTITY_ID);
    expect(again.ok).toBe(false);
    expect(again.errorCode).toBe('identity_already_archived');
  });

  it('cannot be reactivated, because that would make the history ambiguous', async () => {
    const result = await withActor(admin.actor, async (sql) => {
      try {
        await sql.query(`update public.outreach_identities set status = 'active' where id = $1`, [
          USED_IDENTITY_ID,
        ]);
        return 'updated';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(result).toMatch(/archived and cannot be reactivated/i);
  });

  it('blocks new work for a regular user through the scope assertion every send path calls', async () => {
    // `assert_identity_usable` raises; that is the refusal `mark_message_sent` and the browser-binding
    // path both meet, so asserting the predicate and the assertion together covers both.
    expect(ordinary.userId).toBe(USER_ID);

    const outcome = await withActor(ordinary.actor, async (sql) => {
      const usable = await sql.query<{ usable: boolean }>(
        `select public.identity_usable_by_actor($1) as usable`,
        [USED_IDENTITY_ID],
      );
      let assertion = 'no error';
      try {
        await sql.query(`select public.assert_identity_usable($1)`, [USED_IDENTITY_ID]);
      } catch (error) {
        assertion = error instanceof Error ? error.message : String(error);
      }
      return { usable: usable.rows[0]?.usable, assertion };
    });

    expect(outcome.usable).toBe(false);
    expect(outcome.assertion).toMatch(/may not use outreach identity/i);
  });

  it('blocks new work for an admin too, which it previously did not', async () => {
    // This is the regression: `identity_usable_by_actor` short-circuited on `is_admin()` before
    // examining the identity, so an admin bypassed its state entirely.
    const usable = await withActor(admin.actor, async (sql) => {
      const result = await sql.query<{ usable: boolean }>(
        `select public.identity_usable_by_actor($1) as usable`,
        [USED_IDENTITY_ID],
      );
      return result.rows[0]?.usable;
    });
    expect(usable).toBe(false);
  });

  it('refuses a new browser binding to an archived identity', async () => {
    await h.db.exec('set row_security = off');
    await expect(
      h.db.query(
        `insert into public.browser_sessions
           (user_id, browser_fingerprint_or_install_id, outreach_identity_id, status)
         values ($1, 'late-install', $2, 'active')`,
        [ADMIN_ID, USED_IDENTITY_ID],
      ),
    ).rejects.toThrow(/is not active/i);
    await h.db.exec('set row_security = on');
  });

  it('removes the identity from the sender selector and the Companion selector', async () => {
    const options = await listIdentityOptions(admin.actor, BUSINESS_ID);
    expect(options.map((option) => option.value)).not.toContain(USED_IDENTITY_ID);
    // The identity that was never archived is still offered, so the filter is not simply hiding everything.
    expect(options.map((option) => option.value)).toContain(CLEAN_IDENTITY_ID);

    const companion = await companionIdentities(admin.actor, ADMIN_ID);
    expect(companion.map((identity) => identity.id)).not.toContain(USED_IDENTITY_ID);
    expect(companion.map((identity) => identity.id)).toContain(CLEAN_IDENTITY_ID);
  });

  it('stays visible on the management screen, marked retired', async () => {
    // Archiving is not hiding: an administrator has to be able to find it to see what it sent.
    const identities = await listIdentities(admin.actor);
    const archived = identities.find((identity) => identity.id === USED_IDENTITY_ID);
    expect(archived?.status).toBe('retired');
  });

  it('preserves all historical attribution', async () => {
    await h.db.exec('set row_security = off');
    const events = await h.db.query<{ outreach_identity_id: string | null }>(
      `select outreach_identity_id from public.message_events where message_instance_id = $1`,
      [INSTANCE_ID],
    );
    expect(events.rows[0]?.outreach_identity_id).toBe(USED_IDENTITY_ID);

    const lead = await h.db.query<{ outreach_identity_id: string | null }>(
      `select outreach_identity_id from public.leads where id = $1`,
      [LEAD_ID],
    );
    expect(lead.rows[0]?.outreach_identity_id).toBe(USED_IDENTITY_ID);

    const conversation = await h.db.query<{ sender_identity_id: string | null }>(
      `select sender_identity_id from public.conversations where id = $1`,
      [CONVERSATION_ID],
    );
    expect(conversation.rows[0]?.sender_identity_id).toBe(USED_IDENTITY_ID);
    await h.db.exec('set row_security = on');
  });
});

describe('deleteIdentitySafely', () => {
  it('requires the display name as typed confirmation', async () => {
    const result = await deleteIdentitySafely(admin, CLEAN_IDENTITY_ID, 'wrong name');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('confirmation_required');
    expect(await getIdentity(admin.actor, CLEAN_IDENTITY_ID)).not.toBeNull();
  });

  it('refuses an identity with attribution, returning the counts and the alternative', async () => {
    const result = await deleteIdentitySafely(admin, USED_IDENTITY_ID, 'Used Identity');

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('identity_has_attribution');
    expect(result.attribution?.sentMessages).toBe(1);
    expect(result.error).toMatch(/archive it instead/i);

    // The identity is untouched, so the caller can go straight to archiving it.
    expect(await getIdentity(admin.actor, USED_IDENTITY_ID)).not.toBeNull();
  });

  it('deletes an identity that holds no attribution', async () => {
    const result = await deleteIdentitySafely(admin, CLEAN_IDENTITY_ID, 'Clean Identity');

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(await getIdentity(admin.actor, CLEAN_IDENTITY_ID)).toBeNull();

    await h.db.exec('set row_security = off');
    const audit = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events
        where entity_type = 'outreach_identities' and entity_id = $1 and action = 'identity_delete'`,
      [CLEAN_IDENTITY_ID],
    );
    expect(audit.rows[0]?.n).toBe(1);
    await h.db.exec('set row_security = on');
  });

  it('refuses a direct delete at the database boundary, so no path orphans attribution', async () => {
    // The repository refuses before it reaches the database. This asserts the trigger, which is what
    // holds for a caller that does not come through the repository — the case that used to succeed
    // silently and blank the sender on every message the identity had sent.
    await h.db.exec('set row_security = off');
    await expect(
      h.db.query(`delete from public.outreach_identities where id = $1`, [USED_IDENTITY_ID]),
    ).rejects.toThrow(/referenced by history/i);

    // Proof that the attribution that would have been lost is still present.
    const events = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.message_events
        where outreach_identity_id = $1 and event_type = 'sent'`,
      [USED_IDENTITY_ID],
    );
    expect(events.rows[0]?.n).toBe(1);
    await h.db.exec('set row_security = on');
  });
});
