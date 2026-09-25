'use server';

/**
 * U17 — Duplicate Review.
 *
 * Contract: "Merge/keep/skip candidate vs existing canonical record."
 *
 * spec `lead_sources.duplicate_review`: "merge into existing", "keep separate only when
 * truly different person/entity", "skip".
 *
 * All three resolutions go through `lib/repo/duplicates.ts` → `public.merge_duplicate_candidate`,
 * the audited database function that moves evidence, signals, notes, research and social
 * profiles across and soft-deletes the losing lead. This screen cannot invent a different
 * merge semantic, and it never hard-deletes anything.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { DUPLICATE_RESOLUTIONS } from '@nexus/core';
import { resolveDuplicate } from '@/lib/repo/duplicates';
import { formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const notSignedIn: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

const resolveSchema = z.object({
  candidateId: z.string().uuid(),
  resolution: z.enum(DUPLICATE_RESOLUTIONS),
});

export async function resolveDuplicateAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = resolveSchema.safeParse({
    candidateId: formStringOrNull(formData, 'candidateId'),
    resolution: formStringOrNull(formData, 'resolution'),
  });
  if (!parsed.success) return { ok: false, error: 'That duplicate candidate could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await resolveDuplicate(viewer, parsed.data.candidateId, parsed.data.resolution);
  if (!result.ok) return { ok: false, error: result.error ?? 'That decision was refused.' };

  // A merge moves leads, evidence and history, so every list that shows them is stale.
  revalidatePath('/my-duplicates');
  revalidatePath('/my-leads');
  revalidatePath('/my-day');
  revalidatePath('/trash');

  const message =
    parsed.data.resolution === 'merge'
      ? `Merged into the existing record: ${String(result.leadsMoved)} lead(s) moved, ${String(result.leadsSoftDeleted)} soft-deleted and restorable from Trash.`
      : parsed.data.resolution === 'keep_separate'
        ? 'Kept separate. Both people remain canonical and independent.'
        : 'Skipped. The candidate stays open for someone else to review.';

  return { ok: true, error: null, message };
}
