'use server';

/**
 * Team & accounts mutations — A15 (`/team`) and A16 (`/team/[id]`).
 *
 * Every action resolves the viewer from the signed session cookie; a `userId`,
 * `role` or `password` a caller might send is validated as *input*, never trusted
 * as identity. Each write ends up inside `withActor(viewer.actor, …)`, where RLS
 * on `public.users`, `public.user_business_access`, `public.user_lead_scope` and
 * the `public.require_admin` call inside `public.set_user_credential` are the
 * authorization boundary.
 *
 * No action ever returns, logs or revalidates with a password or password hash:
 * `hashPassword`'s output goes straight into the repository call.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { authorizeAction } from '@/lib/route-guard';
import { hashPassword, passwordPolicyError } from '@/lib/password';
import { formString, formStringOrNull } from '@/lib/form-data';
import {
  ACCESS_LEVELS,
  LEAD_SCOPE_MODES,
  USER_ROLES,
  USER_STATUSES,
  createTeamUser,
  removeUserGrant,
  saveUserGrant,
  setUserPassword,
  updateTeamUser,
} from '@/lib/repo/team';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const NOT_SIGNED_IN: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

const uuid = z.string().uuid();

/** Unchecked HTML checkboxes are simply absent from the payload. */
function checkbox(formData: FormData, name: string): boolean {
  return formData.get(name) === 'true' || formData.get(name) === 'on';
}

/** Empty strings from optional text inputs mean "not supplied". */
function optionalText(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

const createUserSchema = z.object({
  email: z.string().trim().email().max(320),
  fullName: z.string().trim().min(1).max(200),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES),
  businessId: uuid.nullish(),
  accessLevel: z.enum(ACCESS_LEVELS),
  password: z.string().max(200).nullish(),
  canManageLeads: z.boolean(),
  canUseLeadSources: z.boolean(),
  canUseProfileQueue: z.boolean(),
  canDeleteLeads: z.boolean(),
});

/**
 * spec `roles_and_permissions.admin.can`: "Create users and assign business
 * visibility."
 *
 * The profile row, the initial grant and the local credential are written in one
 * transaction (see `createTeamUser`), so a rejected password cannot leave behind a
 * user who can never sign in.
 */
export async function createUserAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/team' });
  if (refusal !== null) return refusal;

  const parsed = createUserSchema.safeParse({
    email: formStringOrNull(formData, 'email'),
    fullName: formStringOrNull(formData, 'fullName'),
    role: formString(formData, 'role', 'user'),
    status: formString(formData, 'status', 'active'),
    businessId: optionalText(formData, 'businessId'),
    accessLevel: formString(formData, 'accessLevel', 'user'),
    password: optionalText(formData, 'password'),
    canManageLeads: checkbox(formData, 'canManageLeads'),
    canUseLeadSources: checkbox(formData, 'canUseLeadSources'),
    canUseProfileQueue: checkbox(formData, 'canUseProfileQueue'),
    canDeleteLeads: checkbox(formData, 'canDeleteLeads'),
  });
  if (!parsed.success) {
    return { ok: false, error: 'Check the email address, name and role.' };
  }

  if (parsed.data.password != null) {
    const policyError = passwordPolicyError(parsed.data.password);
    if (policyError !== null) return { ok: false, error: policyError };
  }

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  const result = await createTeamUser(
    viewer,
    {
      email: parsed.data.email ?? undefined,
      fullName: parsed.data.fullName ?? undefined,
      role: parsed.data.role ?? undefined,
      status: parsed.data.status ?? undefined,
      grant:
        parsed.data.businessId == null
          ? null
          : {
              businessId: parsed.data.businessId,
              accessLevel: parsed.data.accessLevel ?? 'user',
              canManageLeads: parsed.data.canManageLeads ?? false,
              canUseLeadSources: parsed.data.canUseLeadSources ?? false,
              canUseProfileQueue: parsed.data.canUseProfileQueue ?? false,
              canDeleteLeads: parsed.data.canDeleteLeads ?? false,
            },
      // passed straight through to hashPassword; never persisted or returned
      ...(parsed.data.password == null ? {} : { password: parsed.data.password }),
    },
    hashPassword,
  );

  if (result.ok) revalidatePath('/team');
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok
      ? parsed.data.password === undefined
        ? 'User created. No local password was set.'
        : 'User created and local password set.'
      : undefined,
  };
}

const updateUserSchema = z.object({
  userId: uuid,
  fullName: z.string().trim().min(1).max(200),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES),
  timezone: z.string().trim().min(1).max(60),
});

export async function updateUserAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/team' });
  if (refusal !== null) return refusal;

  const parsed = updateUserSchema.safeParse({
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
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Profile updated.' : undefined,
  };
}

const setPasswordSchema = z.object({
  userId: uuid,
  password: z.string().min(1).max(200),
});

/**
 * Local credential path (`0015_local_credentials.sql`).
 *
 * `public.set_user_credential` is SECURITY DEFINER and calls
 * `public.require_admin`, so the signed-in admin's identity — set by `withActor` —
 * is what authorises it. Nothing about the password is echoed back.
 */
export async function setPasswordAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/team' });
  if (refusal !== null) return refusal;

  const parsed = setPasswordSchema.safeParse({
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

const grantSchema = z.object({
  userId: uuid,
  businessId: uuid,
  accessLevel: z.enum(ACCESS_LEVELS),
  leadScopeMode: z.enum(LEAD_SCOPE_MODES),
  canManageLeads: z.boolean(),
  canUseLeadSources: z.boolean(),
  canUseProfileQueue: z.boolean(),
  canDeleteLeads: z.boolean(),
});

/**
 * Saves one business grant together with its lead scope.
 *
 * The permission check is deliberately only a courtesy: the real refusal comes
 * from `user_business_access_write`, which permits the write to `public.is_admin()`
 * alone.
 */
export async function saveGrantAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/team' });
  if (refusal !== null) return refusal;

  const parsed = grantSchema.safeParse({
    userId: formStringOrNull(formData, 'userId'),
    businessId: formStringOrNull(formData, 'businessId'),
    accessLevel: formString(formData, 'accessLevel', 'user'),
    leadScopeMode: formString(formData, 'leadScopeMode', 'all'),
    canManageLeads: checkbox(formData, 'canManageLeads'),
    canUseLeadSources: checkbox(formData, 'canUseLeadSources'),
    canUseProfileQueue: checkbox(formData, 'canUseProfileQueue'),
    canDeleteLeads: checkbox(formData, 'canDeleteLeads'),
  });
  if (!parsed.success) return { ok: false, error: 'Choose a business and an access level.' };

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  // `icpIds` narrows the lead scope to specific ICPs; an empty list means every ICP.
  const icpIds = formData
    .getAll('icpIds')
    .filter((value): value is string => typeof value === 'string' && uuid.safeParse(value).success);

  const result = await saveUserGrant(viewer, {
    userId: parsed.data.userId ?? undefined,
    businessId: parsed.data.businessId ?? undefined,
    accessLevel: parsed.data.accessLevel ?? undefined,
    canManageLeads: parsed.data.canManageLeads ?? undefined,
    canUseLeadSources: parsed.data.canUseLeadSources ?? undefined,
    canUseProfileQueue: parsed.data.canUseProfileQueue ?? undefined,
    canDeleteLeads: parsed.data.canDeleteLeads ?? undefined,
    leadScopeMode: parsed.data.leadScopeMode ?? undefined,
    icpIds,
  });

  if (result.ok) revalidatePath(`/team/${parsed.data.userId}`);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Business access saved.' : undefined,
  };
}

export async function revokeGrantAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/team' });
  if (refusal !== null) return refusal;

  const parsed = z.object({ userId: uuid, businessId: uuid }).safeParse({
    userId: formStringOrNull(formData, 'userId'),
    businessId: formStringOrNull(formData, 'businessId'),
  });
  if (!parsed.success) return { ok: false, error: 'That grant could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  const result = await removeUserGrant(viewer, parsed.data.userId, parsed.data.businessId);
  if (result.ok) revalidatePath(`/team/${parsed.data.userId}`);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Business access revoked.' : undefined,
  };
}
