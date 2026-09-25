'use server';

/**
 * Lead Sources hub mutations (A05).
 *
 * spec `lead_sources.import_batch.undo`: "Support undo for recent import by
 * reverting records created exclusively by that import while preserving
 * pre-existing records/history."
 *
 * The workflow that decides "exclusively by that import" lives in
 * `public.undo_import` — a lead with a sent message or a reply recorded after the
 * import is kept. This action only validates input, checks the viewer's
 * permission so the UI reports the real reason, and calls it.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { undoImport } from '@/lib/repo/ingestion';
import { formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const schema = z.object({
  batchId: z.string().uuid(),
  businessSlug: z.string().trim().min(1).max(120),
});

export async function undoImportAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = schema.safeParse({
    batchId: formStringOrNull(formData, 'batchId'),
    businessSlug: formStringOrNull(formData, 'businessSlug'),
  });
  if (!parsed.success) return { ok: false, error: 'That import batch could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  const result = await undoImport(viewer, parsed.data.batchId);
  if (result.ok) {
    revalidatePath(`/b/${parsed.data.businessSlug}/lead-sources`);
    revalidatePath(`/b/${parsed.data.businessSlug}/leads`);
    revalidatePath(`/b/${parsed.data.businessSlug}/trash`);
  }

  return {
    ok: result.ok,
    error: result.error,
    message: result.ok
      ? `Import undone: ${String(result.reverted)} lead${result.reverted === 1 ? '' : 's'} moved to Trash, ${String(result.kept)} kept because they already have history.`
      : undefined,
  };
}
