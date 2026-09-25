'use server';

/**
 * A16 — User Permissions mutations.
 *
 * The screen edits one business grant at a time, alongside that user's profile. The
 * viewer is always resolved from the signed session cookie, and each repository call
 * runs inside `withActor(viewer.actor, …)`, so `user_business_access_write` and
 * `user_lead_scope_write` — both `public.is_admin()` — are what actually decide
 * whether a write lands.
 *
 * Grant editing itself lives in `team/actions.ts`: both screens write the same two
 * tables, and duplicating the action would let the two copies drift.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { hashPassword, passwordPolicyError } from '@/lib/password';
import { setUserPassword, updateTeamUser, USER_ROLES, USER_STATUSES } from '@/lib/repo/team';
import { formString, formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const NOT_SIGNED_IN: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

const uuid = z.string().uuid();

const profileSchema = z.object({
  userId: uuid,
  fullName: z.string().trim().min(1).max(200),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES),
  timezone: z.string().trim().min(1).max(60),
});

export async function updateUserProfileAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = profileSchema.safeParse({
    userId: formStringOrNull(formData, 'userId'),
    fullName: formStringOrNull(formData, 'fullName'),
    role: formStringOrNull(formData, 'role'),
    status: formStringOrNull(formData, 'status'),
    timezone: formString(formData, 'timezone', 'UTC'),
  });
  if (!parsed.success) return { ok: false, error: 'Name, role, status and timezone are required.' };

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  const result = await updateTeamUser(viewer, parsed.data.userId, {
    fullName: parsed.data.fullName ?? undefined,
    role: parsed.data.role ?? undefined,
    status: parsed.data.status ?? undefined,
    timezone: parsed.data.timezone ?? undefined,
  });

  if (result.ok) {
    revalidatePath('/team');
    revalidatePath(`/team/${parsed.data.userId}`);
  }
  return { ok: result.ok, error: result.error ?? null, message: result.ok ? 'Profile updated.' : undefined };
}

const passwordSchema = z.object({
  userId: uuid,
  password: z.string().min(1).max(200),
});

/** Local credential path — the hash goes straight into `set_user_credential`. */
export async function setUserPasswordAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = passwordSchema.safeParse({
    userId: formStringOrNull(formData, 'userId'),
    password: formStringOrNull(formData, 'password'),
  });
  if (!parsed.success) return { ok: false, error: 'Enter a password.' };

  const policyError = passwordPolicyError(parsed.data.password);
  if (policyError !== null) return { ok: false, error: policyError };

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  const result = await setUserPassword(viewer, parsed.data.userId, parsed.data.password, hashPassword);
  if (result.ok) revalidatePath(`/team/${parsed.data.userId}`);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Local password set. The previous one no longer works.' : undefined,
  };
}
