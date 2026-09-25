'use server';

/**
 * Trash mutations (A08).
 *
 * spec `screen_inventory A08`: "Restore soft-deleted leads/import artifacts;
 * permanent delete remains auditable/admin-only."
 *
 * Three rules are load-bearing here and each one is enforced below the UI as
 * well as in it:
 *   - restoring runs through `public.restore_lead`, which re-checks invariant 1
 *     ("within the same business, a Person may have only one active Lead");
 *   - permanent deletion is refused unless the viewer holds
 *     `lead.permanent_delete`, and the database additionally requires the literal
 *     confirmation string and an admin actor;
 *   - undoing an import calls `public.undo_import`, which preserves any record
 *     that has moved on since the import.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import type { Viewer } from '@/lib/actor';
import { permanentDeleteLead, restoreLead } from '@/lib/repo/leads';
import { undoImport } from '@/lib/repo/ingestion';
import { formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const notSignedIn: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

const uuidSchema = z.string().uuid();
const slugSchema = z.string().trim().min(1).max(120);

function revalidateTrash(slug: string): void {
  revalidatePath(`/b/${slug}/trash`);
  revalidatePath(`/b/${slug}/leads`);
  revalidatePath(`/b/${slug}/lead-sources`);
}

/**
 * Restores one soft-deleted lead.
 *
 * `restoreLead` and `permanentDeleteLead` both live in the existing leads
 * repository; they are reused rather than re-implemented so the Trash screen and
 * the lead screen cannot diverge.
 */
export async function restoreFromTrashAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = z
    .object({ leadId: uuidSchema, businessSlug: slugSchema })
    .safeParse({ leadId: formStringOrNull(formData, 'leadId'), businessSlug: formStringOrNull(formData, 'businessSlug') });
  if (!parsed.success) return { ok: false, error: 'That lead could not be found.' };

  const viewer: Viewer | null = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await restoreLead(viewer, parsed.data.leadId);
  if (result.ok) revalidateTrash(parsed.data.businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Lead restored to its business.' : undefined,
  };
}

/**
 * Permanent deletion.
 *
 * The literal confirmation string is required by the database function as well,
 * so removing this check would not make the operation reachable — it would only
 * make the refusal less clear.
 */
export async function permanentDeleteAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = z
    .object({
      leadId: uuidSchema,
      businessSlug: slugSchema,
      confirmation: z.string(),
    })
    .safeParse({
      leadId: formStringOrNull(formData, 'leadId'),
      businessSlug: formStringOrNull(formData, 'businessSlug'),
      confirmation: formStringOrNull(formData, 'confirmation'),
    });
  if (!parsed.success) return { ok: false, error: 'That lead could not be found.' };

  if (parsed.data.confirmation !== 'DELETE PERMANENTLY') {
    return { ok: false, error: 'Type DELETE PERMANENTLY exactly to confirm.' };
  }

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await permanentDeleteLead(viewer, parsed.data.leadId, parsed.data.confirmation);
  if (result.ok) revalidateTrash(parsed.data.businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Lead permanently deleted. The deletion is in the audit log.' : undefined,
  };
}

/**
 * Undoes a recent import.
 *
 * spec `import_batch.undo`: reverting is a database decision (which rows were
 * created exclusively by the batch and have no history), not a UI one — the
 * counts come back so the operator learns exactly what was reverted and what was
 * deliberately kept.
 */
export async function undoImportAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = z
    .object({ batchId: uuidSchema, businessSlug: slugSchema })
    .safeParse({ batchId: formStringOrNull(formData, 'batchId'), businessSlug: formStringOrNull(formData, 'businessSlug') });
  if (!parsed.success) return { ok: false, error: 'That import batch could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await undoImport(viewer, parsed.data.batchId);
  if (result.ok) revalidateTrash(parsed.data.businessSlug);
  return {
    ok: result.ok,
    error: result.error,
    message: result.ok
      ? `Import undone: ${String(result.reverted)} lead${result.reverted === 1 ? '' : 's'} moved to Trash, ${String(result.kept)} kept because they have history.`
      : undefined,
  };
}
