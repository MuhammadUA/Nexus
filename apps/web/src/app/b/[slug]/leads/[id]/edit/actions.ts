'use server';

/**
 * U20 — Edit Lead.
 *
 * Contract: "Editable lead fields within user permissions."
 *
 * Two different things are edited here and they are deliberately separate calls:
 *
 *   - `updateLead` (existing repository) writes the *business-scoped lead*: Primary ICP,
 *     owner, sender identity, status. Changing the Primary ICP goes through
 *     `public.set_primary_icp`, the audited RPC, because `lead_icp_matches` has a
 *     one-primary invariant that a plain column write would break.
 *   - `updateLeadProfile` (this surface's repository addition) writes the *canonical
 *     person/company*: name, title, headline, location, LinkedIn URL, company.
 *
 * "Within user permissions" is enforced by RLS, not by hiding the fields: the owner and
 * sender-identity selects are only read when the viewer actually holds
 * `lead.assign_owner` / `lead.change_sender_identity`, and the database refuses the write
 * either way.
 *
 * The file lives beside the canonical page it belongs to (`/b/:slug/leads/:id/edit`) rather than
 * with the legacy alias, and on success it redirects back to the canonical lead detail — the round
 * trip an operator expects after saving, with no intermediate page to get stranded on.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { LEAD_STATES } from '@nexus/core';

import { currentViewer } from '@/lib/current-viewer';
import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { authorizeAction } from '@/lib/route-guard';
import { canonicalLeadPath } from '@/lib/lead-links';
import { updateLead } from '@/lib/repo/leads';
import { updateLeadProfile } from '@/lib/repo/user-sources';
import { formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const optionalUuid = z
  .string()
  .trim()
  .nullish()
  .transform((value) => (value == null || value.length === 0 ? undefined : value))
  .refine((value) => value === undefined || z.string().uuid().safeParse(value).success, {
    message: 'That selection is not valid.',
  });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === undefined ? '' : value));

const editSchema = z.object({
  leadId: z.string().uuid(),
  businessSlug: z.string().trim().min(1).max(200),
  fullName: optionalText(200),
  jobTitle: optionalText(200),
  headline: optionalText(400),
  location: optionalText(200),
  companyName: optionalText(200),
  linkedinUrl: optionalText(400),
  primaryIcpId: optionalUuid,
  ownerUserId: optionalUuid,
  outreachIdentityId: optionalUuid,
  status: z.enum(LEAD_STATES).nullish(),
});

export async function updateLeadAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = editSchema.safeParse({
    leadId: formStringOrNull(formData, 'leadId'),
    businessSlug: formStringOrNull(formData, 'businessSlug'),
    fullName: formStringOrNull(formData, 'fullName'),
    jobTitle: formStringOrNull(formData, 'jobTitle'),
    headline: formStringOrNull(formData, 'headline'),
    location: formStringOrNull(formData, 'location'),
    companyName: formStringOrNull(formData, 'companyName'),
    linkedinUrl: formStringOrNull(formData, 'linkedinUrl'),
    primaryIcpId: formStringOrNull(formData, 'primaryIcpId'),
    ownerUserId: formStringOrNull(formData, 'ownerUserId'),
    outreachIdentityId: formStringOrNull(formData, 'outreachIdentityId'),
    status: formStringOrNull(formData, 'status'),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message;
    return {
      ok: false,
      error:
        issue !== undefined && issue.length > 0 && issue !== 'Invalid input'
          ? issue
          : 'Some of those values are not valid.',
    };
  }

  const viewer = await currentViewer();
  if (viewer === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  /**
   * The action is a public endpoint once its page has rendered anywhere, so it verifies the same
   * route requirement its page declares — against the business named in the form, resolved through
   * the viewer's own visible businesses. A posted slug the viewer cannot see is refused, not merely
   * unlisted. `authorizeAction` returns a typed refusal rather than a 404, because an action has no
   * page to not find.
   */
  const context = await loadViewerContext();
  const business = resolveBusiness(context, parsed.data.businessSlug);
  if (business === null) return { ok: false, error: 'That lead could not be found.' };
  const refusal = await authorizeAction(context, {
    route: '/b/:businessSlug/leads/:leadId/edit',
    businessId: business.id,
  });
  if (refusal !== null) return { ok: false, error: refusal.error };

  // 1. Canonical person/company fields.
  const profile = await updateLeadProfile(viewer, parsed.data.leadId, {
    fullName: parsed.data.fullName ?? undefined,
    jobTitle: parsed.data.jobTitle ?? undefined,
    headline: parsed.data.headline ?? undefined,
    location: parsed.data.location ?? undefined,
    linkedinUrl: parsed.data.linkedinUrl ?? undefined,
    companyName: parsed.data.companyName ?? undefined,
  });
  if (!profile.ok) return { ok: false, error: profile.error ?? 'The lead could not be updated.' };

  // 2. Business-scoped lead fields. Only the keys the operator actually supplied are
  //    sent, so an untouched select means "leave unchanged" rather than "clear this
  //    field" — the same rule the admin lead screen follows.
  const leadFields = {
    ...(parsed.data.primaryIcpId === undefined ? {} : { primaryIcpId: parsed.data.primaryIcpId }),
    ...(parsed.data.ownerUserId === undefined ? {} : { ownerUserId: parsed.data.ownerUserId }),
    ...(parsed.data.outreachIdentityId === undefined
      ? {}
      : { outreachIdentityId: parsed.data.outreachIdentityId }),
    ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
  };

  if (Object.keys(leadFields).length > 0) {
    const lead = await updateLead(viewer, parsed.data.leadId, leadFields);
    if (!lead.ok) return { ok: false, error: lead.error ?? 'The lead could not be updated.' };
  }

  // Revalidate the paths that actually exist, resolved rather than assumed: a `revalidatePath` for
  // a route that is not a page is a silent no-op, which is how the previous `/leads/:id` target
  // never refreshed anything.
  const canonical = await canonicalLeadPath(context.viewer.actor, parsed.data.leadId);
  if (canonical !== null) {
    revalidatePath(canonical);
    revalidatePath(`${canonical}/edit`);
  }
  revalidatePath('/my-leads');
  revalidatePath('/my-day');
  revalidatePath(`/b/${business.key}/leads`);

  if (canonical === null) {
    return { ok: true, error: null, message: 'Lead updated.' };
  }
  redirect(canonical);
}
