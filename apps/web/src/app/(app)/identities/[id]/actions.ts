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
 *
 * Assignment names a recipient, and only a recipient. An empty `toUserId` used to stand for
 * "unassign" and was funnelled through `assignIdentityManager`; releasing an identity now has its own
 * action (`unassignIdentityAction`) and this one rejects anything that is not a user id.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { authorizeAction } from '@/lib/route-guard';
import { formString, formStringOrNull } from '@/lib/form-data';
import { withActor, type Viewer } from '@/lib/actor';
import { describeDbError } from '@/lib/repo/common';
import { CHANNEL_ACCOUNT_CHANNELS } from '@/lib/channel-vocabulary';
import {
  IDENTITY_PLATFORMS,
  IDENTITY_STATUSES,
  archiveIdentity,
  assignIdentityManager,
  createIdentity,
  deleteIdentitySafely,
  grantIdentityBusiness,
  revokeIdentityBusiness,
  unassignIdentity,
  updateIdentity,
} from '@/lib/repo/identities';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const NOT_SIGNED_IN: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

const uuid = z.string().uuid();

/**
 * The channel choices as a mutable tuple.
 *
 * `z.enum` needs a tuple with at least one element, and `CHANNEL_ACCOUNT_CHANNELS`
 * is a readonly array — the copy states the one property zod requires without
 * re-listing the channels, so the enum cannot drift from the vocabulary the form and
 * the screens offer.
 */
const channelEnum = z.enum([...CHANNEL_ACCOUNT_CHANNELS] as [string, ...string[]]);

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
  channel: channelEnum,
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
  const channel = formString(formData, 'channel', 'linkedin');
  const parsed = createSchema.safeParse({
    displayName: formStringOrNull(formData, 'displayName'),
    channel,
    /*
     * The legacy `platform` is kept in step with the channel when the operator did
     * not state one, because every pre-V1.2 reader of this table — the reporting
     * views, the exports and the historical attribution — still reads `platform`.
     * Leaving it at a hard-coded `linkedin` would misattribute an email or Upwork
     * account created today.
     */
    platform: formString(formData, 'platform', channel),
    status: formString(formData, 'status', 'active'),
    dailyTarget: formStringOrNull(formData, 'dailyTarget') ?? 0,
    profileUrl: optionalText(formData, 'profileUrl'),
    managedByUserId:
      typeof managedByUserId === 'string' && managedByUserId.length > 0 ? managedByUserId : undefined,
  });
  if (!parsed.success) return { ok: false, error: 'Give the channel account a display name and a daily target.' };

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
    /*
     * `createIdentity` writes the row through the identities repository, which
     * predates `channel`. The column is set in a second statement rather than by
     * reaching into that repository's insert: the insert is also used by the seed
     * and the Companion, and adding a column there would change a shared contract
     * for one screen's convenience.
     */
    if (result.id === undefined) {
      return { ok: false, error: 'The channel account was created but its channel could not be set.' };
    }
    const channelWrite = await writeChannel(viewer, result.id, parsed.data.channel);
    if (channelWrite !== null) return { ok: false, error: channelWrite };

    revalidatePath('/identities');
    revalidatePath('/team');
  }
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Channel account created.' : undefined,
  };
}

const updateSchema = z.object({
  identityId: uuid,
  displayName: z.string().trim().min(1).max(200),
  channel: channelEnum,
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
    channel: formStringOrNull(formData, 'channel'),
    platform: formStringOrNull(formData, 'platform'),
    status: formStringOrNull(formData, 'status'),
    dailyTarget: formStringOrNull(formData, 'dailyTarget'),
    profileUrl: typeof profileUrl === 'string' ? profileUrl : undefined,
    notes: typeof notes === 'string' ? notes : undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: 'Check the display name, channel, platform, status and daily target.' };
  }

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
    const channelWrite = await writeChannel(viewer, parsed.data.identityId, parsed.data.channel);
    if (channelWrite !== null) return { ok: false, error: channelWrite };

    revalidatePath(`/identities/${parsed.data.identityId}`);
    revalidatePath('/identities');
  }
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Channel account updated.' : undefined,
  };
}

/**
 * Writes `outreach_identities.channel`.
 *
 * Separate from `updateIdentity` / `createIdentity` on purpose: `@/lib/repo/identities`
 * is the long-standing identity repository that the Companion binding, the seed and
 * the team screens all go through, and it predates the `channel` column that
 * migration 0030 added. Changing its input shape would change a shared contract to
 * serve one screen. This statement is written here because `channel` is this
 * screen's own vocabulary, and it is **scoped by the same rule**: it runs through
 * `withActor`, so the update policy — and `restrict_identity_self_update`, which
 * confines a non-admin owner to presentation fields — decide whether it is allowed.
 *
 * Returns an operator-facing message on failure, or null on success, so the caller
 * cannot accidentally report a half-applied edit as a success.
 */
async function writeChannel(
  viewer: Viewer,
  identityId: string,
  channel: string,
): Promise<string | null> {
  if (identityId.length === 0) return 'That channel account could not be found.';
  try {
    const written = await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `update public.outreach_identities
            set channel = $2, updated_at = now()
          where id = $1 and deleted_at is null
          returning id`,
        [identityId, channel],
      );
      return result.rows.length > 0;
    });
    return written ? null : 'That channel account no longer exists.';
  } catch (error) {
    return describeDbError(error, 'writeChannel');
  }
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
  /*
   * A real user, always.
   *
   * This used to accept `''` as an "unassign" sentinel, because an HTML select cannot submit
   * `null`. That made releasing an identity a *transfer to nobody*: it went through
   * `assignIdentityManager`, which records an `identity_transfers` row — a table whose rows name a
   * recipient. Releasing is `unassignIdentityAction` below, which audits `identity_unassign` and
   * deliberately writes no transfer row, so the sentinel is gone rather than merely unused.
   */
  toUserId: uuid,
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
    toUserId: formStringOrNull(formData, 'toUserId'),
    note: typeof note === 'string' ? note : undefined,
    confirmed: checkbox(formData, 'confirmed'),
  });
  if (!parsed.success) return { ok: false, error: 'Choose the user who should manage this identity.' };

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  const result = await assignIdentityManager(viewer, parsed.data.identityId, parsed.data.toUserId, {
    confirmed: parsed.data.confirmed ?? undefined,
    note: parsed.data.note == null || parsed.data.note.length === 0 ? null : parsed.data.note,
  });

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

/* ------------------------------------------------------- lifecycle actions -- */

/**
 * Lifecycle actions carry a stable `errorCode`.
 *
 * The lifecycle refusals are not all failures. "This identity has history, archive it instead" is a
 * *different screen state*, not an error to display: the UI has to offer the archive control, which it
 * cannot do from a sentence. Matching on message text would break the moment a sentence is reworded, so
 * the code is part of the contract and the sentence is for the operator.
 *
 * Every action here requires `identity.manage` (admin-only), and each re-checks authorization because a
 * Server Action is a public endpoint once its module has been rendered anywhere.
 */
export interface LifecycleActionResult extends ActionResult {
  readonly errorCode?: string;
  /** Present with `errorCode: 'identity_has_attribution'`: what archiving would preserve. */
  readonly attribution?: Record<string, number>;
}

const identityOnlySchema = z.object({
  identityId: uuid,
  note: z.string().trim().max(2000).nullish(),
});

/** Releases an identity from its operator without transferring it to anyone. */
export async function unassignIdentityAction(
  _previous: LifecycleActionResult,
  formData: FormData,
): Promise<LifecycleActionResult> {
  const refusal = await authorizeAction(null, { route: '/identities' });
  if (refusal !== null) return refusal;

  const note = formStringOrNull(formData, 'note');
  const parsed = identityOnlySchema.safeParse({
    identityId: formStringOrNull(formData, 'identityId'),
    note: typeof note === 'string' ? note : undefined,
  });
  if (!parsed.success) return { ok: false, error: 'That identity could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  const result = await unassignIdentity(
    viewer,
    parsed.data.identityId,
    parsed.data.note == null || parsed.data.note.length === 0 ? null : parsed.data.note,
  );
  if (result.ok) revalidatePath('/identities');

  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? result.message : undefined,
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  };
}

/**
 * Archives an identity: `status` becomes `retired`, live browser sessions are revoked, and it leaves
 * every sender and binding selector. Terminal — an archived identity cannot be reactivated.
 */
export async function archiveIdentityAction(
  _previous: LifecycleActionResult,
  formData: FormData,
): Promise<LifecycleActionResult> {
  const refusal = await authorizeAction(null, { route: '/identities' });
  if (refusal !== null) return refusal;

  const note = formStringOrNull(formData, 'note');
  const parsed = identityOnlySchema.safeParse({
    identityId: formStringOrNull(formData, 'identityId'),
    note: typeof note === 'string' ? note : undefined,
  });
  if (!parsed.success) return { ok: false, error: 'That identity could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  const result = await archiveIdentity(
    viewer,
    parsed.data.identityId,
    parsed.data.note == null || parsed.data.note.length === 0 ? null : parsed.data.note,
  );
  if (result.ok) {
    revalidatePath(`/identities/${parsed.data.identityId}`);
    revalidatePath('/identities');
    revalidatePath('/team');
  }

  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? result.message : undefined,
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  };
}

const deleteIdentitySchema = z.object({
  identityId: uuid,
  confirmation: z.string().trim().max(200),
});

/**
 * Deletes an identity — only one that never sent anything and carries no attribution.
 *
 * Returns `errorCode: 'identity_has_attribution'` with the counts when history references it, which is
 * the signal for the UI to offer Archive instead. It is not a validation failure: the request was
 * well-formed and the operation is genuinely unavailable.
 */
export async function deleteIdentityAction(
  _previous: LifecycleActionResult,
  formData: FormData,
): Promise<LifecycleActionResult> {
  const refusal = await authorizeAction(null, { route: '/identities' });
  if (refusal !== null) return refusal;

  const parsed = deleteIdentitySchema.safeParse({
    identityId: formStringOrNull(formData, 'identityId'),
    confirmation: formString(formData, 'confirmation', ''),
  });
  if (!parsed.success) return { ok: false, error: 'That identity could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return NOT_SIGNED_IN;

  const result = await deleteIdentitySafely(viewer, parsed.data.identityId, parsed.data.confirmation);
  if (result.ok) revalidatePath('/identities');

  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? result.message : undefined,
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    ...(result.attribution === undefined ? {} : { attribution: { ...result.attribution } }),
  };
}
