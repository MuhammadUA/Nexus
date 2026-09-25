'use server';

/**
 * U21 — Trash server actions.
 *
 * One action only: restore. spec `roles_and_permissions.user.cannot` forbids a normal
 * user from permanently deleting a record, so there is no permanent-delete action on
 * this surface at all — the absence is the enforcement, alongside
 * `ADMIN_ONLY_PERMISSIONS` in `@nexus/core` and the `prevent_hard_delete()` trigger.
 *
 * Restoring goes through `public.restore_lead`, which re-checks the "one active Lead
 * per (business, person)" invariant. If another active lead for that person has since
 * been created, the restore is refused and the real reason is surfaced rather than a
 * generic failure.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { restoreLead } from '@/lib/repo/leads';
import { formStringOrNull } from '@/lib/form-data';

export interface TrashActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const restoreSchema = z.object({ leadId: z.string().uuid() });

export async function restoreLeadAction(
  _previous: TrashActionResult,
  formData: FormData,
): Promise<TrashActionResult> {
  const parsed = restoreSchema.safeParse({ leadId: formStringOrNull(formData, 'leadId') });
  if (!parsed.success) {
    return { ok: false, error: 'That lead could not be found.' };
  }

  // The actor comes from the signed session, never from the submitted form.
  const viewer = await currentViewer();
  if (viewer === null) {
    return { ok: false, error: 'Your session has expired. Sign in again.' };
  }

  const result = await restoreLead(viewer, parsed.data.leadId);

  if (result.ok) {
    // The lead reappears in the lists, and leaves this screen.
    revalidatePath('/trash');
    revalidatePath('/my-leads');
    revalidatePath('/my-day');
  }

  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Lead restored.' : undefined,
  };
}
