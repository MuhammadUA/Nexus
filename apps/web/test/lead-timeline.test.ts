/**
 * Lead history timeline.
 *
 * spec `reply_and_notes.history_rule`: the timeline must show outbound messages, inbound
 * replies, internal notes, tasks, connection events and sequence state changes, and it must
 * show an inbound reply *verbatim* — a reply represented only by a truncated summary is not
 * the reply, and the operator cannot judge a response from a summary.
 *
 * This is regression coverage for that: the lead detail screen rendered the summary while the
 * verbatim text sat unread in the interaction payload.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadViewer, type Viewer } from '@/lib/actor';
import { getLead, getLeadTimeline } from '@/lib/repo/leads';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;
let viewer: Viewer;

const ADMIN_ID = 'e0000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'e0000000-0000-4000-8000-000000000002';
const PERSON_ID = 'e0000000-0000-4000-8000-000000000003';
const LEAD_ID = 'e0000000-0000-4000-8000-000000000004';

const REPLY_TEXT =
  'Thanks for reaching out - we are looking for extra editing capacity for Q3. Can you send rates and a sample?';

beforeAll(async () => {
  h = await createAppHarness();
  await h.db.exec('set row_security = off');
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'timeline-admin@nexus.test', 'Timeline Admin', 'admin', 'active')`,
    [ADMIN_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by)
     values ($1, 'timeline-test', 'Timeline Test Co', 'active', $2)`,
    [BUSINESS_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources, can_use_profile_queue, can_delete_leads, created_by)
     values ($1, $2, 'admin', true, true, true, true, $1)`,
    [ADMIN_ID, BUSINESS_ID],
  );
  await h.db.query(
    `insert into public.people (id, full_name, normalized_name, created_by)
     values ($1, 'Reply Person', 'reply person', $2)`,
    [PERSON_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.leads (id, business_id, person_id, status, source_type, created_by)
     values ($1, $2, $3, 'replied', 'paste_list', $4)`,
    [LEAD_ID, BUSINESS_ID, PERSON_ID, ADMIN_ID],
  );
  // The inbound reply is stored with the exact text on the payload, as the capture form does.
  await h.db.query(
    `insert into public.interactions
       (business_id, lead_id, person_id, type, direction, summary, payload, source_client, occurred_at)
     values ($1, $2, $3, 'inbound_reply', 'inbound', $4, $5::jsonb, 'companion', now())`,
    [BUSINESS_ID, LEAD_ID, PERSON_ID, REPLY_TEXT.slice(0, 60), JSON.stringify({ body: REPLY_TEXT, verbatim: true })],
  );
  await h.db.exec('set row_security = on');
  viewer = await loadViewer({ kind: 'user', userId: ADMIN_ID });
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('lead history', () => {
  it('returns the inbound reply verbatim rather than only its summary', async () => {
    const timeline = await getLeadTimeline(viewer.actor, LEAD_ID);
    const inbound = timeline.find((entry) => entry.kind === 'inbound');

    expect(inbound).toBeDefined();
    expect(inbound?.body).toBe(REPLY_TEXT);
    expect(inbound?.body).not.toBe(inbound?.summary);
  });

  it('shows the reply on the same read the lead detail screen renders', async () => {
    // The screen calls both reads; both must be able to serve the verbatim text.
    const [detail, timeline] = await Promise.all([
      getLead(viewer.actor, LEAD_ID),
      getLeadTimeline(viewer.actor, LEAD_ID),
    ]);
    expect(detail).not.toBeNull();
    const bodies = timeline.map((entry) => entry.body ?? '');
    expect(bodies).toContain(REPLY_TEXT);
  });
});
