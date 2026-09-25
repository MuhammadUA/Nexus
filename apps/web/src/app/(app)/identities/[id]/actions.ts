'use server';

/**
 * Outreach identity mutations — A17 (`/identities/[id]`).
 *
 * The interesting action here is `assignIdentityManagerAction`. spec
 * `admin_self_assignment_and_domains.admin_self_assignment` allows an admin to
 * self-assign an *unassigned* identity, but taking one that belongs to someone else
 * "requires explicit transfer confirmation and audit event". Both are enforced in
 * `assignIdentityManager`, in one transaction, so a transfer cannot be recorded
 * without its audit row.
 *
 * The `confirmed` checkbox is a confirmation, not an authorization: removing it from
 * the form would only produce a refusal from the repository.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { authorizeAction } from '@/lib/route-guard';
import { formString, formStringOrNull } from '@/lib/form-data';
import {
  IDENTITY_PLATFORMS,
  IDENTITY_STATUSES,
  assignIdentityManager,
  createIdentity,
  grantIdentityBusiness,
  revokeIdentityBusiness,
  updateIdentity,
} from '@/lib/repo/identities';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const NOT_SIGNED_IN: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

const uuid = z.string().uuid();

function checkbox(formData: FormData, name: string): boolean {
  return formData.get(name) === 'true' || formData.get(name) === 'on';
}

/** Empty strings from optional text inputs mean "not supplied". */
function optionalText(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

const createSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  platform: z.enum(IDENTITY_PLATFORMS),
  status: z.enum(IDENTITY_STATUSES),
  dailyTarget: z.coerce.number().int().min(0).max(1000),
  profileUrl: z.string().trim().max(500).nullish(),
  managedByUserId: uuid.nullish(),
});

export async function createIdentityAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/identities' });
  if (refusal !== null) return refusal;

  const managedByUserId = formStringOrNull(formData, 'managedByUserId');
  const parsed = createSchema.safeParse({
    displayName: formStringOrNull(formData, 'displayName'),
    platform: formString(formData, 'platform', 'linkedin'),
    status: formString(formData, 'status', 'active'),
    dailyTarget: formStringOrNull(formData, 'dailyTarget') ?? 0,
    profileUrl: optionalText(formData, 'profileUrl'),
    managedByUserId:
      typeof managedByUserId === 'string' && managedByUserId.length > 0 ? managedByUserId : undefined,
  });
  if (!parsed.success) return { ok: false, error: 'Give the identity a display name and a daily target.' };

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  const result = await createIdentity(viewer, {
    displayName: parsed.data.displayName ?? undefined,
    platform: parsed.data.platform ?? undefined,
    status: parsed.data.status ?? undefined,
    dailyTarget: parsed.data.dailyTarget ?? undefined,
    profileUrl: parsed.data.profileUrl === undefined ? null : parsed.data.profileUrl,
    notes: null,
    managedByUserId: parsed.data.managedByUserId ?? null,
  });

  if (result.ok) {
    revalidatePath('/identities');
    revalidatePath('/team');
  }
  return { ok: result.ok, error: result.error ?? null, message: result.ok ? 'Identity created.' : undefined };
}

const updateSchema = z.object({
  identityId: uuid,
  displayName: z.string().trim().min(1).max(200),
  platform: z.enum(IDENTITY_PLATFORMS),
  status: z.enum(IDENTITY_STATUSES),
  dailyTarget: z.coerce.number().int().min(0).max(1000),
  profileUrl: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(4000).nullish(),
});

export async function updateIdentityAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/identities' });
  if (refusal !== null) return refusal;

  const profileUrl = formStringOrNull(formData, 'profileUrl');
  const notes = formStringOrNull(formData, 'notes');
  const parsed = updateSchema.safeParse({
    identityId: formStringOrNull(formData, 'identityId'),
    displayName: formStringOrNull(formData, 'displayName'),
    platform: formStringOrNull(formData, 'platform'),
    status: formStringOrNull(formData, 'status'),
    dailyTarget: formStringOrNull(formData, 'dailyTarget'),
    profileUrl: typeof profileUrl === 'string' ? profileUrl : undefined,
    notes: typeof notes === 'string' ? notes : undefined,
  });  if (!parsed.success) return { ok: false, error: 'Check the display name, platform, status and daily target.' };

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  const result = await updateIdentity(viewer, parsed.data.identityId, {
    displayName: parsed.data.displayName ?? undefined,
    platform: parsed.data.platform ?? undefined,
    status: parsed.data.status ?? undefined,
    dailyTarget: parsed.data.dailyTarget ?? undefined,
    // An emptied text field is an explicit request to clear the column.
    profileUrl: parsed.data.profileUrl === undefined ? null : parsed.data.profileUrl,
    notes: parsed.data.notes === undefined ? null : parsed.data.notes,
  });

  if (result.ok) {
    revalidatePath(`/identities/${parsed.data.identityId}`);
    revalidatePath('/identities');
  }
  return { ok: result.ok, error: result.error ?? null, message: result.ok ? 'Identity updated.' : undefined };
}

const businessSchema = z.object({ identityId: uuid, businessId: uuid });

export async function grantBusinessAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/identities' });
  if (refusal !== null) return refusal;

  const parsed = businessSchema.safeParse({
    identityId: formStringOrNull(formData, 'identityId'),
    businessId: formStringOrNull(formData, 'businessId'),
  });
  if (!parsed.success) return { ok: false, error: 'Choose a business to grant.' };

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  const result = await grantIdentityBusiness(viewer, parsed.data.identityId, parsed.data.businessId);
  if (result.ok) revalidatePath(`/identities/${parsed.data.identityId}`);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Business access granted to this identity.' : undefined,
  };
}

export async function revokeBusinessAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/identities' });
  if (refusal !== null) return refusal;

  const parsed = businessSchema.safeParse({
    identityId: formStringOrNull(formData, 'identityId'),
    businessId: formStringOrNull(formData, 'businessId'),
  });
  if (!parsed.success) return { ok: false, error: 'That business grant could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  const result = await revokeIdentityBusiness(viewer, parsed.data.identityId, parsed.data.businessId);
  if (result.ok) revalidatePath(`/identities/${parsed.data.identityId}`);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Business access revoked from this identity.' : undefined,
  };
}

const assignSchema = z.object({
  identityId: uuid,
  // The empty string is the "unassign" sentinel, because an HTML select cannot
  // submit `null`.
  toUserId: z.union([uuid, z.literal('')]),
  note: z.string().trim().max(2000).nullish(),
  confirmed: z.boolean(),
});

export async function assignIdentityManagerAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/identities' });
  if (refusal !== null) return refusal;

  const note = formStringOrNull(formData, 'note');
  const parsed = assignSchema.safeParse({
    identityId: formStringOrNull(formData, 'identityId'),
    toUserId: formString(formData, 'toUserId', ''),
    note: typeof note === 'string' ? note : undefined,
    confirmed: checkbox(formData, 'confirmed'),
  });
  if (!parsed.success) return { ok: false, error: 'Choose the user who should manage this identity.' };

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  const result = await assignIdentityManager(
    viewer,
    parsed.data.identityId,
    parsed.data.toUserId === '' ? null : parsed.data.toUserId,
    {
      confirmed: parsed.data.confirmed ?? undefined,
      note: parsed.data.note == null || parsed.data.note.length === 0 ? null : parsed.data.note,
    },
  );

  if (result.ok) {
    revalidatePath(`/identities/${parsed.data.identityId}`);
    revalidatePath('/identities');
    revalidatePath('/team');
  }
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok
      ? 'Manager updated. The change is recorded in the transfer history and the audit log.'
      : undefined,
  };
}
