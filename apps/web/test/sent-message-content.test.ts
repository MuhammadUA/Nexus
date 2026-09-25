/**
 * A SENT message must carry content that can be shown as history.
 *
 * The invariant that existed was "SENT requires a version". The one that did not was "…and that
 * version has something in it": `message_versions.content` is `text not null`, so an empty or
 * whitespace-only body was a legal version. Marking an instance sent on one of those produces a row
 * that is SENT forever with nothing to display, and a SENT instance's versions and
 * `current_version_id` are immutable by trigger — so it can never be repaired.
 *
 * The important property is that it is unrepairable, which is why this is enforced at the database
 * boundary rather than only in the form that creates the trouble.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadViewer, withActor, type Viewer } from '@/lib/actor';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;
let viewer: Viewer;

/**
 * Calls the RPC the way the application does.
 *
 * `mark_message_sent` is `security definer` and calls `assert_business_scope`, so it needs the
 * transaction-local claims `withActor` installs. Calling it outside an actor context — as the first
 * version of this test did — fails the scope assertion rather than testing anything.
 */
function markSent(instanceId: string): Promise<unknown> {
  return withActor(viewer.actor, async (sql) => {
    await sql.query(`select public.mark_message_sent($1, $2, 'test')`, [instanceId, IDENTITY_ID]);
  });
}

const ADMIN_ID = 'e1000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'e1000000-0000-4000-8000-000000000002';
const PERSON_ID = 'e1000000-0000-4000-8000-000000000003';
const LEAD_ID = 'e1000000-0000-4000-8000-000000000004';
const CONVERSATION_ID = 'e1000000-0000-4000-8000-000000000005';
const IDENTITY_ID = 'e1000000-0000-4000-8000-000000000006';

/** A fresh DYNAMIC instance, so each case starts from a sendable state. */
async function newInstance(id: string): Promise<void> {
  await h.db.query(
    `insert into public.message_instances
       (id, conversation_id, state, business_id, lead_id, step_order, step_kind)
     values ($1, $2, 'DYNAMIC', $3, $4, 0, 'message')`,
    [id, CONVERSATION_ID, BUSINESS_ID, LEAD_ID],
  );
}

async function newVersion(instanceId: string, versionId: string, content: string): Promise<void> {
  await h.db.query(
    `insert into public.message_versions (id, message_instance_id, content, generated_by_model, created_by)
     values ($1, $2, $3, 'test-model', $4)`,
    [versionId, instanceId, content, ADMIN_ID],
  );
  await h.db.query(`update public.message_instances set current_version_id = $2 where id = $1`, [
    instanceId,
    versionId,
  ]);
}

beforeAll(async () => {
  h = await createAppHarness();
  await h.db.exec('set row_security = off');
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'sent-admin@nexus.test', 'Sent Admin', 'admin', 'active')`,
    [ADMIN_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by)
     values ($1, 'sent-test', 'Sent Test Co', 'active', $2)`,
    [BUSINESS_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.people (id, full_name, created_by) values ($1, 'Sent Person', $2)`,
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
     values ($1, 'linkedin', 'Sent Identity', 'active', $2, $2)`,
    [IDENTITY_ID, ADMIN_ID],
  );
  // An identity reaches a business through the access table, not a column on the identity.
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
  await h.db.exec('set row_security = on');
  viewer = await loadViewer({ kind: 'user', userId: ADMIN_ID });
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('message_versions content', () => {
  it('refuses a blank body at insert, so no pathway can create one', async () => {
    await h.db.exec('set row_security = off');
    await newInstance('e1000000-0000-4000-8000-0000000000a1');

    await expect(
      newVersion('e1000000-0000-4000-8000-0000000000a1', 'e1000000-0000-4000-8000-0000000000b1', '   '),
    ).rejects.toThrow(/content_not_blank|check constraint/i);

    await expect(
      newVersion('e1000000-0000-4000-8000-0000000000a1', 'e1000000-0000-4000-8000-0000000000b2', ''),
    ).rejects.toThrow(/content_not_blank|check constraint/i);

    await h.db.exec('set row_security = on');
  });

  it('accepts a real body', async () => {
    await h.db.exec('set row_security = off');
    await newInstance('e1000000-0000-4000-8000-0000000000a2');
    await newVersion(
      'e1000000-0000-4000-8000-0000000000a2',
      'e1000000-0000-4000-8000-0000000000b3',
      'A real message body.',
    );

    const row = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.message_versions where message_instance_id = $1`,
      ['e1000000-0000-4000-8000-0000000000a2'],
    );
    expect(row.rows[0]?.n).toBe(1);
    await h.db.exec('set row_security = on');
  });
});

describe('the SENT transition', () => {
  it('refuses to mark an instance sent with no version at all', async () => {
    await h.db.exec('set row_security = off');
    await newInstance('e1000000-0000-4000-8000-0000000000a3');
    await h.db.exec('set row_security = on');

    await expect(markSent('e1000000-0000-4000-8000-0000000000a3')).rejects.toThrow(/no version to freeze/i);
  });

  it('refuses a state change to SENT on an instance with no version', async () => {
    // The trigger, not the RPC: a direct state write is the path that bypasses the function.
    await h.db.exec('set row_security = off');
    await newInstance('e1000000-0000-4000-8000-0000000000a4');

    await expect(
      h.db.query(
        `update public.message_instances set state = 'SENT', sent_at = now() where id = $1`,
        ['e1000000-0000-4000-8000-0000000000a4'],
      ),
    ).rejects.toThrow(/without a current version/i);

    await h.db.exec('set row_security = on');
  });

  it('marks a message with real content sent, and freezes it', async () => {
    await h.db.exec('set row_security = off');
    await newInstance('e1000000-0000-4000-8000-0000000000a5');
    await newVersion(
      'e1000000-0000-4000-8000-0000000000a5',
      'e1000000-0000-4000-8000-0000000000b5',
      'Ada, happy to share how we handled the same handoff.',
    );
    await h.db.exec('set row_security = on');

    await markSent('e1000000-0000-4000-8000-0000000000a5');

    await h.db.exec('set row_security = off');
    const instance = await h.db.query<{ state: string; current_version_id: string }>(
      `select state, current_version_id from public.message_instances where id = $1`,
      ['e1000000-0000-4000-8000-0000000000a5'],
    );
    expect(instance.rows[0]?.state).toBe('SENT');

    // The content is retrievable — which is the whole point of the invariant.
    const version = await h.db.query<{ content: string }>(
      `select mv.content from public.message_versions mv
        where mv.id = (select current_version_id from public.message_instances where id = $1)`,
      ['e1000000-0000-4000-8000-0000000000a5'],
    );
    expect(version.rows[0]?.content).toContain('happy to share');

    // And it can no longer be edited, so the content shown is the content sent.
    await expect(
      h.db.query(`update public.message_versions set content = 'rewritten' where id = $1`, [
        'e1000000-0000-4000-8000-0000000000b5',
      ]),
    ).rejects.toThrow(/immutable/i);

    await h.db.exec('set row_security = on');
  });

  it('cannot be sent twice', async () => {
    await expect(markSent('e1000000-0000-4000-8000-0000000000a5')).rejects.toThrow(/already been sent/i);
  });
});
