'use server';

/**
 * Reactivation mutations (A09).
 *
 * spec `lead_lifecycle.reactivation`: "Prefer a fresh buying signal/new angle. Do
 * not blindly repeat the old sequence."
 *
 * This action does not generate copy. It opens the reactivation review on the
 * lead through `startReactivation` from the existing leads repository, which moves
 * the enrollment to `reactivation_due` and schedules the lead's next action.
 * Writing the new angle stays a human decision made on the screen, with the
 * previous outreach in front of the operator.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { startReactivation } from '@/lib/repo/leads';
import { formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const schema = z.object({
  businessSlug: z.string().trim().min(1).max(120),
  leadId: z.string().uuid(),
});

export async function openReactivationAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = schema.safeParse({
    businessSlug: formStringOrNull(formData, 'businessSlug'),
    leadId: formStringOrNull(formData, 'leadId'),
  });
  if (!parsed.success) return { ok: false, error: 'That lead could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  const result = await startReactivation(viewer, parsed.data.leadId);
  if (result.ok) {
    revalidatePath(`/b/${parsed.data.businessSlug}/reactivation`);
    revalidatePath(`/b/${parsed.data.businessSlug}/leads/${parsed.data.leadId}`);
    revalidatePath('/my-day');
  }

  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok
      ? 'Reactivation opened on this lead. Write a new angle — the previous sequence is shown above and must not be repeated.'
      : undefined,
  };
}
