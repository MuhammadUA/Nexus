/**
 * Global platform settings are platform configuration, not shared business data.
 *
 * `platform_settings_select` was `business_id is null or has_business_access(business_id)`, so the
 * DNC suppression rule, the reply-pause rule, the dormant-reactivation window and the retention and
 * security defaults were readable by **any** authenticated user, from any business, whatever their
 * grants. A policy that grants a read is the boundary; the fact that the only page reaching it today
 * happens to be admin-only is not.
 *
 * A business-scoped row keeps its rule: readable by someone with access to that business.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadViewer, type Viewer } from '@/lib/actor';
import { listPlatformSettings } from '@/lib/repo/businesses';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;
let admin: Viewer;
let outsider: Viewer;

const ADMIN_ID = 'a2000000-0000-4000-8000-000000000001';
const OUTSIDER_ID = 'a2000000-0000-4000-8000-000000000002';
const BUSINESS_ID = 'a2000000-0000-4000-8000-000000000003';

beforeAll(async () => {
  h = await createAppHarness();
  await h.db.exec('set row_security = off');
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status) values
       ($1, 'settings-admin2@nexus.test', 'Settings Admin', 'admin', 'active'),
       ($2, 'settings-user@nexus.test', 'Settings User', 'user', 'active')`,
    [ADMIN_ID, OUTSIDER_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by)
     values ($1, 'settings-scope', 'Scoped Co', 'active', $2)`,
    [BUSINESS_ID, ADMIN_ID],
  );
  // The admin reaches the business; the ordinary user does not.
  await h.db.query(
    `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources, can_use_profile_queue, can_delete_leads, created_by)
     values ($1, $2, 'admin', true, true, true, true, $1)`,
    [ADMIN_ID, BUSINESS_ID],
  );
  // A business-scoped row the admin owns, plus the seeded global rows.
  await h.db.query(
    `insert into public.platform_settings (business_id, key, value)
     values ($1, 'dormant.reactivation_days', '30'::jsonb)`,
    [BUSINESS_ID],
  );
  await h.db.exec('set row_security = on');

  admin = await loadViewer({ kind: 'user', userId: ADMIN_ID });
  outsider = await loadViewer({ kind: 'user', userId: OUTSIDER_ID });
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('global platform settings', () => {
  it('are readable by an administrator', async () => {
    const settings = await listPlatformSettings(admin.actor);
    expect(settings.length).toBeGreaterThan(0);
    // Migration 0010 seeds these; they are configuration, not demo content.
    expect(settings.map((setting) => setting.key)).toContain('dormant.reactivation_days');
  });

  it('are not readable by an ordinary user', async () => {
    const settings = await listPlatformSettings(outsider.actor);
    expect(settings).toEqual([]);
  });

  it('are not readable through a direct query either, so the policy is the boundary', async () => {
    // The application path is only one way in; this asserts the grant itself is gone.
    const { withActor } = await import('@/lib/actor');
    const rows = await withActor(outsider.actor, async (sql) => {
      const result = await sql.query<{ n: number }>(
        `select count(*)::int as n from public.platform_settings where business_id is null`,
      );
      return result.rows[0]?.n ?? -1;
    });
    expect(rows).toBe(0);
  });
});

describe('business-scoped platform settings', () => {
  it('are readable by someone with access to that business', async () => {
    const settings = await listPlatformSettings(admin.actor, BUSINESS_ID);
    const scoped = settings.find((setting) => setting.key === 'dormant.reactivation_days');
    expect(scoped?.value).toBe(30);
  });

  it('are not readable by someone with no access to that business', async () => {
    const settings = await listPlatformSettings(outsider.actor, BUSINESS_ID);
    expect(settings).toEqual([]);
  });
});
