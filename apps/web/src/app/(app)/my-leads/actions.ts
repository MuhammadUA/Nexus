'use server';

/**
 * User-surface list actions: saved views and Trash restore.
 *
 * U05 needs "saved-view" filters, and U21 needs restore-and-nothing-else. Both are
 * deliberately thin: the actor comes from `currentViewer()`, every field is validated
 * with Zod, and the write itself runs inside `withActor` in the repository, so the
 * database refuses anything the viewer's grant does not cover.
 *
 * There is intentionally **no** permanent-delete action in this file. spec
 * `roles_and_permissions.user.cannot` — "Permanently delete records" — and the admin
 * path lives on the admin Trash screen behind `lead.permanent_delete`.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { restoreLead } from '@/lib/repo/leads';
import { deleteView, saveView, type LeadViewFilters } from '@/lib/repo/saved-views';
import { formString, formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const notSignedIn: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

const leadFilterSchema = z.object({
  icp: z.string().trim().max(64).nullish(),
  identity: z.string().trim().max(64).nullish(),
  status: z.string().trim().max(64).nullish(),
  source: z.string().trim().max(64).nullish(),
  owner: z.string().trim().max(64).nullish(),
  q: z.string().trim().max(200).nullish(),
  sort: z.string().trim().max(40).nullish(),
});

/** Only the keys the lead list understands, and only non-empty string values. */
function filtersFrom(search: string): LeadViewFilters {
  const parsed = leadFilterSchema.safeParse(Object.fromEntries(new URLSearchParams(search)));
  const data = parsed.success ? parsed.data : {};
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && value.length > 0) filters[key] = value;
  }
  return filters;
}

const saveViewSchema = z.object({
  businessId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  isShared: z.enum(['true', 'false']).nullish(),
  /** The current query string, so the saved view is exactly what is on screen. */
  search: z.string().max(2000).nullish(),
  sort: z.string().trim().max(40).nullish(),
});

/**
 * Saves the current My Leads list state under a name, then lands back on that list.
 *
 * spec `saved_views` (scope `leads`, owner_user_id, name, filters jsonb, sort jsonb,
 * is_shared): the filters are read from the submitted query string rather than from
 * client state, so the stored view replays exactly the URL the operator was looking
 * at. `saved_views_owner_name_key` means repeating a name updates that view.
 */
export async function saveLeadViewAction(formData: FormData): Promise<void> {
  const search = formString(formData, 'search', '');
  const back = new URLSearchParams(search);

  const parsed = saveViewSchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    name: formStringOrNull(formData, 'name'),
    isShared: formStringOrNull(formData, 'isShared'),
    search,
    sort: formStringOrNull(formData, 'sort'),
  });

  const viewer = await currentViewer();
  if (viewer === null) redirect('/login');

  if (!parsed.success) {
    back.set('view-error', 'Give the view a name of up to 120 characters.');
    redirect(`/my-leads?${back.toString()}`);
  }

  const filters = filtersFrom(search);
  const sort =
    parsed.data.sort == null || parsed.data.sort.length === 0 ? {} : { sort: parsed.data.sort };

  const result = await saveView(viewer, {
    businessId: parsed.data.businessId ?? undefined,
    name: parsed.data.name ?? undefined,
    filters,
    sort,
    isShared: parsed.data.isShared === 'true',
  });

  revalidatePath('/my-leads');
  if (!result.ok) {
    back.set('view-error', result.error ?? 'The view could not be saved.');
  } else {
    back.set('view-saved', parsed.data.name);
  }
  redirect(`/my-leads?${back.toString()}`);
}

const deleteViewSchema = z.object({
  viewId: z.string().uuid(),
});

/** Removes one of the viewer's own saved views; RLS refuses anybody else's. */
export async function deleteLeadViewAction(formData: FormData): Promise<void> {
  const parsed = deleteViewSchema.safeParse({ viewId: formStringOrNull(formData, 'viewId') });
  const back = new URLSearchParams(formString(formData, 'search', ''));

  const viewer = await currentViewer();
  if (viewer === null) redirect('/login');

  if (!parsed.success) {
    back.set('view-error', 'That saved view could not be found.');
    redirect(`/my-leads?${back.toString()}`);
  }

  const result = await deleteView(viewer, parsed.data.viewId);
  revalidatePath('/my-leads');
  if (!result.ok) back.set('view-error', result.error ?? 'The view could not be removed.');
  redirect(`/my-leads?${back.toString()}`);
}

const restoreSchema = z.object({ leadId: z.string().uuid() });

/**
 * U21 — restore a soft-deleted lead.
 *
 * `public.restore_lead` re-checks the business scope and the invariant that a person
 * may have only one active lead per business, so a restore that would collide is
 * refused with the real reason instead of silently doing nothing.
 */
export async function restoreLeadAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = restoreSchema.safeParse({ leadId: formStringOrNull(formData, 'leadId') });
  if (!parsed.success) return { ok: false, error: 'That lead could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await restoreLead(viewer, parsed.data.leadId);
  if (!result.ok) return { ok: false, error: result.error ?? 'The lead could not be restored.' };

  revalidatePath('/trash');
  revalidatePath('/my-leads');
  revalidatePath('/my-day');
  return { ok: true, error: null, message: 'Lead restored.' };
}
