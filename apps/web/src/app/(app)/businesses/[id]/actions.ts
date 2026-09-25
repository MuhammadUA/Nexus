'use server';

/**
 * Business lifecycle actions — archive, restore, and the guarded permanent delete.
 *
 * spec `business_units`: a business can be closed without being destroyed. Archiving takes it out of
 * the active selectors and stops new work inside it while preserving every lead, message, reply, task
 * and audit row; permanent deletion is the destructive alternative and is available only where there is
 * nothing to destroy.
 *
 * All three are `business.create` in the route matrix, which is admin-only, and each re-checks
 * authorization because a Server Action is a public endpoint once its module has been rendered anywhere.
 * The database enforces the same rules independently — `businesses_update` and `businesses_delete`
 * require `is_admin()`, `archive_business` calls `require_admin`, and a `BEFORE DELETE` trigger refuses a
 * business that has protected history — so a caller that bypasses this file still cannot do the wrong
 * thing.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { formString, formStringOrNull } from '@/lib/form-data';
import {
  archiveBusiness,
  deleteBusinessPermanently,
  getBusinessProtectedHistory,
  restoreBusiness,
  summariseProtectedHistory,
} from '@/lib/repo/businesses';
import { authorizeAction } from '@/lib/route-guard';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

/**
 * Lifecycle actions carry a stable `errorCode`.
 *
 * `business_has_protected_history` is a different screen state rather than a failure: the UI must offer
 * Archive, which it cannot do from a sentence. The code is the contract; the sentence is for the
 * operator.
 */
export interface LifecycleActionResult extends ActionResult {
  readonly errorCode?: string;
  /** Totals of what a permanent delete would destroy, for the confirmation screen. */
  readonly protectedHistory?: Record<string, number>;
  /** True when the business was already in the requested state, so a retry is not an error. */
  readonly alreadyInState?: boolean;
}

const businessOnlySchema = z.object({
  businessId: z.string().uuid(),
  reason: z.string().trim().max(2000).nullish(),
});

/**
 * Archives a business.
 *
 * State changes, so a frontend can render the result without guessing:
 *
 *   * `businesses.status` becomes `archived`, and the business leaves `listBusinesses()`.
 *   * Active `sequence_enrollments` become `paused`.
 *   * Unsent `message_instances` are invalidated with `regeneration_reason = 'business_archived'`.
 *     `SENT` instances are untouched — they are history.
 *   * A trigger then refuses any new lead, enrolment, message instance or import in the business.
 *   * An `archive_business` audit event records the reason.
 *
 * Nothing is deleted, and it is reversible through `restoreBusinessAction`.
 */
export async function archiveBusinessAction(
  _previous: LifecycleActionResult,
  formData: FormData,
): Promise<LifecycleActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/businesses' });
  if (refusal !== null) return refusal;

  const reason = formStringOrNull(formData, 'reason');
  const parsed = businessOnlySchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    reason: typeof reason === 'string' ? reason : undefined,
  });
  if (!parsed.success) return { ok: false, error: 'That business could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  const result = await archiveBusiness(
    viewer,
    parsed.data.businessId,
    parsed.data.reason == null || parsed.data.reason.length === 0 ? null : parsed.data.reason,
  );

  if (result.ok) {
    revalidatePath('/businesses');
    revalidatePath('/');
  }

  return {
    ok: result.ok,
    error: result.error ?? null,
    message: 'message' in result ? result.message : undefined,
    ...(result.alreadyArchived === undefined ? {} : { alreadyInState: result.alreadyArchived }),
  };
}

/** Reverses an archive. Invalidated drafts are not resurrected; they are regenerated. */
export async function restoreBusinessAction(
  _previous: LifecycleActionResult,
  formData: FormData,
): Promise<LifecycleActionResult> {
  const refusal = await authorizeAction(null, { route: '/businesses' });
  if (refusal !== null) return refusal;

  const businessId = formString(formData, 'businessId', '');
  if (!z.string().uuid().safeParse(businessId).success) {
    return { ok: false, error: 'That business could not be found.' };
  }

  const viewer = await currentViewer();
  if (viewer === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  const result = await restoreBusiness(viewer, businessId);
  if (result.ok) {
    revalidatePath('/businesses');
    revalidatePath('/');
  }

  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.message,
  };
}

const deleteSchema = z.object({
  businessId: z.string().uuid(),
  confirmation: z.string().trim().max(200),
});

/**
 * Permanently deletes a business — only one with no history.
 *
 * `confirmation` must be the business key exactly, because the operation is irreversible and the
 * database cannot ask. When protected history exists the action returns
 * `errorCode: 'business_has_protected_history'` with the counts; the UI is expected to offer Archive.
 *
 * The repository refuses *before* attempting anything, and a `BEFORE DELETE` trigger refuses again, so
 * there is no path on which a cascade runs by mistake.
 */
export async function deleteBusinessAction(
  _previous: LifecycleActionResult,
  formData: FormData,
): Promise<LifecycleActionResult> {
  const refusal = await authorizeAction(null, { route: '/businesses' });
  if (refusal !== null) return refusal;

  const parsed = deleteSchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    confirmation: formString(formData, 'confirmation', ''),
  });
  if (!parsed.success) return { ok: false, error: 'That business could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  // Read the census first so the refusal can be typed and carry its counts. `deleteBusinessPermanently`
  // reads it again inside its own guard; this is for the response shape, not for the decision.
  const history = await getBusinessProtectedHistory(viewer.actor, parsed.data.businessId);
  const { total } = summariseProtectedHistory(history);
  if (total > 0) {
    const result = await deleteBusinessPermanently(viewer, parsed.data.businessId, parsed.data.confirmation);
    return {
      ok: false,
      error: result.error ?? 'This business has protected history.',
      errorCode: 'business_has_protected_history',
      protectedHistory: { ...history },
    };
  }

  const result = await deleteBusinessPermanently(viewer, parsed.data.businessId, parsed.data.confirmation);
  if (result.ok) {
    revalidatePath('/businesses');
    revalidatePath('/');
  }

  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.message,
    // A wrong confirmation string is a distinct, fixable situation for the operator.
    ...(result.ok || result.error === undefined ? {} : { errorCode: 'confirmation_required' }),
  };
}
