'use server';

/**
 * Duplicate Review mutations (A07).
 *
 * spec `lead_sources.duplicate_review`: "merge into existing", "keep separate
 * only when truly different person/entity", "skip".
 *
 * All three resolutions go through `public.merge_duplicate_candidate`, which
 * moves or soft-deletes the incoming lead, re-points the evidence and writes the
 * audit event in one transaction. This action validates the resolution against the
 * shared vocabulary and refuses anything else, then reports the real counts back
 * so the operator sees what the decision actually did.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { DUPLICATE_RESOLUTIONS, type DuplicateResolution } from '@nexus/core';
import { resolveDuplicate } from '@/lib/repo/duplicates';
import { formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const schema = z.object({
  businessSlug: z.string().trim().min(1).max(120),
  candidateId: z.string().uuid(),
  resolution: z.enum(DUPLICATE_RESOLUTIONS),
});

function describeResolution(
  resolution: DuplicateResolution,
  leadsMoved: number,
  leadsSoftDeleted: number,
): string {
  switch (resolution) {
    case 'merge':
      return `Merged: ${String(leadsMoved)} lead${leadsMoved === 1 ? '' : 's'} re-pointed to the surviving person, ${String(leadsSoftDeleted)} soft-deleted because the surviving person already had an active lead.`;
    case 'keep_separate':
      return 'Kept separate. Both people and both leads remain — correct only when these really are two different people.';
    default:
      return 'Skipped for now. The candidate leaves the review list but nothing was merged or deleted.';
  }
}

export async function resolveDuplicateAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = schema.safeParse({
    businessSlug: formStringOrNull(formData, 'businessSlug'),
    candidateId: formStringOrNull(formData, 'candidateId'),
    resolution: formStringOrNull(formData, 'resolution'),
  });
  if (!parsed.success) {
    return { ok: false, error: 'That duplicate candidate could not be found.' };
  }

  const viewer = await currentViewer();
  if (viewer === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  const resolution: DuplicateResolution = parsed.data.resolution;
  const result = await resolveDuplicate(viewer, parsed.data.candidateId, resolution);
  if (result.ok) {
    revalidatePath(`/b/${parsed.data.businessSlug}/duplicates`);
    revalidatePath(`/b/${parsed.data.businessSlug}/leads`);
    revalidatePath(`/b/${parsed.data.businessSlug}/lead-sources`);
  }

  return {
    ok: result.ok,
    error: result.error,
    message: result.ok ? describeResolution(resolution, result.leadsMoved, result.leadsSoftDeleted) : undefined,
  };
}
