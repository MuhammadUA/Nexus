'use server';

/**
 * A22 — platform settings mutations.
 *
 * Two scopes, one writer: global rows (`business_id IS NULL`) are the defaults, and
 * a business row overrides its own default. Values are always submitted through a
 * typed control — a checkbox, a number field or a "days" list — and coerced here
 * against the authoritative catalogue in `lib/repo/admin-access.ts`, so a raw JSON
 * blob can never be posted into `platform_settings`.
 *
 * The write policy on `platform_settings` requires `public.is_admin()`, so a
 * non-admin gets a privilege error rather than a silent no-op.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { authorizeAction } from '@/lib/route-guard';
import type { MutationResult } from '@/lib/repo/common';
import { formString, formStringOrNull } from '@/lib/form-data';
import {
  PLATFORM_SETTING_DEFS,
  savePlatformSettings,
  type PlatformSettingEntry,
  type PlatformSettingKind,
  type PlatformSettingValue,
} from '@/lib/repo/admin-access';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const notSignedIn: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

const businessIdSchema = z.string().uuid();
const overrideModeSchema = z.enum(['inherit', 'true', 'false', 'set']);

/** A whole non-negative number of days/steps, bounded so a typo cannot reach SQL. */
const wholeNumber = z
  .string()
  .trim()
  .regex(/^\d{1,6}$/, 'Enter a whole number.');

/** `3, 4, 7` — the follow-up gap list. */
const dayList = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\s*,\s*\d{1,3})*$/, 'Enter comma-separated days, for example 3, 4, 7.');

type Coerced = { readonly ok: true; readonly value: PlatformSettingValue } | { readonly ok: false; readonly error: string };

function coerce(kind: PlatformSettingKind, raw: string): Coerced {
  if (kind === 'boolean') {
    const parsed = z.enum(['true', 'false']).safeParse(raw);
    return parsed.success
      ? { ok: true, value: parsed.data === 'true' }
      : { ok: false, error: 'Choose on or off.' };
  }

  if (kind === 'number') {
    const parsed = wholeNumber.safeParse(raw);
    return parsed.success
      ? { ok: true, value: Number(parsed.data) }
      : { ok: false, error: 'Enter a whole number.' };
  }

  const parsed = dayList.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'Enter comma-separated days, for example 3, 4, 7.' };
  const days = parsed.data
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((value) => Number.isFinite(value));
  if (days.length === 0 || days.length > 10) {
    return { ok: false, error: 'Enter between one and ten day values.' };
  }
  return { ok: true, value: days };
}

function report(result: MutationResult, fallback: string): ActionResult {
  return { ok: result.ok, error: result.error ?? null, message: result.ok ? result.message ?? fallback : undefined };
}

function revalidateSettings(): void {
  revalidatePath('/settings');
}

/* ------------------------------------------------------------ global rows -- */

/**
 * Global defaults. Every editable key is posted by name, so an absent checkbox is
 * an explicit "off" rather than a missing field.
 */
export async function saveGlobalSettingsAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/settings' });
  if (refusal !== null) return refusal;

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const upserts: PlatformSettingEntry[] = [];

  for (const def of PLATFORM_SETTING_DEFS) {
    if (def.kind === 'boolean') {
      upserts.push({ key: def.key, value: formStringOrNull(formData, `g:${def.key}`) !== null });
      continue;
    }
    const raw = formString(formData, `g:${def.key}`, '');
    const coerced = coerce(def.kind, raw);
    if (!coerced.ok) return { ok: false, error: `${def.label}: ${coerced.error}` };
    upserts.push({ key: def.key, value: coerced.value });
  }

  const result = report(await savePlatformSettings(viewer, null, upserts), 'Global defaults saved.');
  if (result.ok) revalidateSettings();
  return result;
}

/* ---------------------------------------------------------- business rows -- */

const businessSettingsSchema = z.object({ businessId: businessIdSchema });

/**
 * Business-level overrides.
 *
 * Per key: `ovr:<key>` is the tri-state mode (`inherit`, `true`/`false` for booleans,
 * `set` for numbers) and `ovrval:<key>` carries the typed value. `inherit` deletes the
 * row so the global default applies again — that is the only way an override can be
 * undone.
 */
export async function saveBusinessSettingsAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/settings' });
  if (refusal !== null) return refusal;

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const parsedScope = businessSettingsSchema.safeParse({ businessId: formStringOrNull(formData, 'businessId') });
  if (!parsedScope.success) return { ok: false, error: 'That business could not be found.' };

  const upserts: PlatformSettingEntry[] = [];
  const clears: string[] = [];

  for (const def of PLATFORM_SETTING_DEFS) {
    const mode = overrideModeSchema.safeParse(formString(formData, `ovr:${def.key}`, 'inherit'));
    if (!mode.success) return { ok: false, error: `${def.label}: choose whether to inherit or override.` };

    if (mode.data === 'inherit') {
      clears.push(def.key);
      continue;
    }

    if (def.kind === 'boolean') {
      // For a boolean the mode itself is the value; `set` is not offered.
      const coerced = coerce(def.kind, mode.data);
      if (!coerced.ok) return { ok: false, error: `${def.label}: ${coerced.error}` };
      upserts.push({ key: def.key, value: coerced.value });
      continue;
    }

    const raw = formString(formData, `ovrval:${def.key}`, '');
    const coerced = coerce(def.kind, raw);
    if (!coerced.ok) return { ok: false, error: `${def.label}: ${coerced.error}` };
    upserts.push({ key: def.key, value: coerced.value });
  }

  const result = report(
    await savePlatformSettings(viewer, parsedScope.data.businessId, upserts, clears),
    'Business overrides saved.',
  );
  if (result.ok) revalidateSettings();
  return result;
}
