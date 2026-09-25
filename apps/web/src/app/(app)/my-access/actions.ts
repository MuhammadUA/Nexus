'use server';

/**
 * A29 — Admin · My Access & Assignment.
 *
 * spec `admin_self_assignment_and_domains.admin_self_assignment`:
 *   - "Admin may grant themselves business access."
 *   - "Admin may self-assign an unassigned outreach identity."
 *   - "If identity is assigned to someone else, require explicit transfer
 *      confirmation and audit event."
 *
 * The actor is always the signed-in user: there is no `userId` field anywhere in this
 * file, so the screen cannot be used to change anybody else's access. Taking over an
 * identity someone else manages is not a silent side effect of a button — it needs the
 * explicit confirmation checkbox, and the repository writes the `identity_transfers`
 * row and the `audit_events` row in the same transaction.
 *
 * Both writes are refused by RLS unless the actor is an admin
 * (`user_business_access_write` and `outreach_identities_update` in migration 0013),
 * so a forged form cannot escalate anybody.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import type { MutationResult } from '@/lib/repo/common';
import { bindIdentityBusiness, selfAssignIdentity } from '@/lib/repo/admin-access';
import { upsertUserGrant } from '@/lib/repo/businesses';
import { formString, formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const notSignedIn: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

function toResult(result: MutationResult, fallback: string): ActionResult {
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? result.message ?? fallback : undefined,
  };
}

/* --------------------------------------------------------- business access -- */

const selfGrantSchema = z.object({
  businessId: z.string().uuid(),
  accessLevel: z.enum(['admin', 'manager', 'user']),
  canManageLeads: z.boolean(),
  canUseLeadSources: z.boolean(),
  canUseProfileQueue: z.boolean(),
  canDeleteLeads: z.boolean(),
});

/**
 * spec: "Admin may grant themselves business access."
 *
 * The grant is written for `viewer.userId` only — a user id is never read from the
 * form. `access_level` is the DB's own vocabulary (`admin | manager | user`), not a
 * UI invention.
 */
export async function grantSelfAccessAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = selfGrantSchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    accessLevel: formString(formData, 'accessLevel', 'user'),
    canManageLeads: formStringOrNull(formData, 'canManageLeads') === 'on',
    canUseLeadSources: formStringOrNull(formData, 'canUseLeadSources') === 'on',
    canUseProfileQueue: formStringOrNull(formData, 'canUseProfileQueue') === 'on',
    canDeleteLeads: formStringOrNull(formData, 'canDeleteLeads') === 'on',
  });
  if (!parsed.success) return { ok: false, error: 'Choose a business and an access level.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;
  if (viewer.userId === null) return notSignedIn;

  const result = toResult(
    await upsertUserGrant(viewer, {
      userId: viewer.userId,
      businessId: parsed.data.businessId ?? undefined,
      accessLevel: parsed.data.accessLevel ?? undefined,
      canManageLeads: parsed.data.canManageLeads ?? undefined,
      canUseLeadSources: parsed.data.canUseLeadSources ?? undefined,
      canUseProfileQueue: parsed.data.canUseProfileQueue ?? undefined,
      canDeleteLeads: parsed.data.canDeleteLeads ?? undefined,
    }),
    'Access granted.',
  );
  if (result.ok) revalidatePath('/my-access');
  return result;
}

/* ------------------------------------------------------- identity transfer -- */

const selfAssignSchema = z.object({
  identityId: z.string().uuid(),
  confirmed: z.boolean(),
  note: z.string().trim().max(500).nullish(),
});

export async function selfAssignIdentityAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = selfAssignSchema.safeParse({
    identityId: formStringOrNull(formData, 'identityId'),
    confirmed: formStringOrNull(formData, 'confirmed') === 'on',
    note: formStringOrNull(formData, 'note'),
  });
  if (!parsed.success) return { ok: false, error: 'That identity could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = toResult(
    await selfAssignIdentity(viewer, parsed.data.identityId, {
      confirmed: parsed.data.confirmed ?? undefined,
      note: parsed.data.note == null || parsed.data.note.length === 0 ? null : parsed.data.note,
    }),
    'Identity assigned to you.',
  );
  if (result.ok) revalidatePath('/my-access');
  return result;
}

/* ------------------------------------------------- identity business bind -- */

const bindSchema = z.object({
  identityId: z.string().uuid(),
  businessId: z.string().uuid(),
});

/**
 * spec `extension_visibility_rule`: Companion visibility is user access INTERSECT the
 * identity's business access, so an identity with no business bound cannot be used.
 */
export async function bindIdentityBusinessAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = bindSchema.safeParse({
    identityId: formStringOrNull(formData, 'identityId'),
    businessId: formStringOrNull(formData, 'businessId'),
  });
  if (!parsed.success) return { ok: false, error: 'Choose the business to bind.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = toResult(
    await bindIdentityBusiness(viewer, parsed.data.identityId, parsed.data.businessId),
    'Business bound to the identity.',
  );
  if (result.ok) revalidatePath('/my-access');
  return result;
}
