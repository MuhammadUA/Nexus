/**
 * Platform settings repository.
 *
 * Regression coverage for a real bug: `platform_settings` carries BOTH
 * `unique (business_id, key)` (NULLS DISTINCT) and a partial
 * `unique (key) where business_id is null`. An `on conflict (business_id, key)`
 * upsert can therefore never match an existing *global* row, so the second save of a
 * global setting tried to insert and violated the partial index. The repository now
 * updates first with `is not distinct from`, which matches NULL correctly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadViewer } from '@/lib/actor';
import { listPlatformSettings, upsertPlatformSetting } from '@/lib/repo/businesses';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;

const ADMIN_ID = 'b0000000-0000-4000-8000-000000000001';

/** Creates the admin row the tests act as. */
async function seedAdmin(): Promise<void> {
  await h.db.exec('set row_security = off');
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'settings-admin@nexus.test', 'Settings Admin', 'admin', 'active')`,
    [ADMIN_ID],
  );
  await h.db.exec('set row_security = on');
}

beforeAll(async () => {
  h = await createAppHarness();
  await seedAdmin();
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('global platform settings', () => {
  it('lists the seeded defaults', async () => {
    const viewer = await loadViewer({ kind: 'user', userId: ADMIN_ID });
    const settings = await listPlatformSettings(viewer.actor);
    const keys = settings.map((setting) => setting.key);

    // Migration 0010 seeds these; they are configuration defaults, not demo content.
    expect(keys).toContain('dormant.reactivation_days');
    expect(keys).toContain('reply.pause_sequence');
    expect(keys).toContain('dnc.suppress_person_across_identities');
  });

  it('updates an existing global setting without violating the partial unique index', async () => {
    const viewer = await loadViewer({ kind: 'user', userId: ADMIN_ID });

    const first = await upsertPlatformSetting(viewer, 'dormant.reactivation_days', 60);
    expect(first.ok).toBe(true);

    // The second save is the one that used to fail: it must update, not insert.
    const second = await upsertPlatformSetting(viewer, 'dormant.reactivation_days', 45);
    expect(second.ok).toBe(true);
    expect(second.error).toBeUndefined();

    const settings = await listPlatformSettings(viewer.actor);
    const stored = settings.find((setting) => setting.key === 'dormant.reactivation_days');
    expect(stored?.value).toBe(45);

    // Exactly one row for the key, globally.
    const rows = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.platform_settings
        where key = 'dormant.reactivation_days' and business_id is null`,
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('inserts a brand-new global setting, then updates it in place', async () => {
    const viewer = await loadViewer({ kind: 'user', userId: ADMIN_ID });

    const created = await upsertPlatformSetting(viewer, 'security.test_key', { enabled: true });
    expect(created.ok).toBe(true);

    const updated = await upsertPlatformSetting(viewer, 'security.test_key', { enabled: false });
    expect(updated.ok).toBe(true);

    const settings = await listPlatformSettings(viewer.actor);
    const stored = settings.find((setting) => setting.key === 'security.test_key');
    expect(stored?.value).toEqual({ enabled: false });

    const rows = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.platform_settings where key = 'security.test_key'`,
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('demonstrates that the naive `on conflict (business_id, key)` form is broken here', async () => {
    // This test exists so the fix cannot be "simplified" back to the broken form.
    // It asserts the *reason* the repository uses UPDATE-then-INSERT: the composite
    // unique constraint is NULLS DISTINCT, so it does not match an existing global
    // row, and the insert then collides with the partial index instead.
    const viewer = await loadViewer({ kind: 'user', userId: ADMIN_ID });
    await upsertPlatformSetting(viewer, 'security.naive_form_probe', 1);

    await expect(
      h.db.query(
        `insert into public.platform_settings (business_id, key, value)
         values (null, 'security.naive_form_probe', '2'::jsonb)
         on conflict (business_id, key) do update set value = excluded.value`,
      ),
    ).rejects.toThrow(/platform_settings_global_key|duplicate key/i);
  });
});

describe('business-scoped platform settings', () => {
  it('keeps a business row separate from the global row of the same key', async () => {
    const viewer = await loadViewer({ kind: 'user', userId: ADMIN_ID });

    const businessId = 'a0000000-0000-4000-8000-000000000001';
    await h.db.exec('set row_security = off');
    await h.db.query(
      `insert into public.businesses (id, key, name) values ($1, 'settings-biz', 'Settings Biz')`,
      [businessId],
    );
    await h.db.exec('set row_security = on');

    const created = await upsertPlatformSetting(viewer, 'dormant.reactivation_days', 30, businessId);
    expect(created.ok).toBe(true);

    const updated = await upsertPlatformSetting(viewer, 'dormant.reactivation_days', 21, businessId);
    expect(updated.ok).toBe(true);

    const businessScoped = await listPlatformSettings(viewer.actor, businessId);
    expect(businessScoped.find((s) => s.key === 'dormant.reactivation_days')?.value).toBe(21);

    // The global value must be untouched by the business-scoped write.
    const global = await listPlatformSettings(viewer.actor);
    expect(global.find((s) => s.key === 'dormant.reactivation_days')?.value).toBe(45);
  });
});
