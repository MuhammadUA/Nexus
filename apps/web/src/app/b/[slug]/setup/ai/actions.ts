'use server';

/**
 * Server actions for the Business Setup · AI tab (spec §63).
 *
 * One action, and it is the only mutation this screen has: activating a prompt version. It is
 * independently authorized (`authorizeAction` repeats the route's requirement, because a Server
 * Action is reachable without its page) and it is admin-only, twice over: this check refuses a
 * non-admin before anything else runs, and `activatePromptVersion` refuses one again — so a
 * forged activation request is refused even if the control that would normally render it never
 * did.
 *
 * Nothing here can create, edit or delete a prompt version. Version history is the point of
 * versioning, and the write policy on `prompt_versions` requires `is_admin()` for any write at
 * all; activation is the single transition this screen offers.
 */
import { revalidatePath } from 'next/cache';
import { routePermissionsFor } from '@nexus/core';
import { z } from 'zod';

import { activatePromptVersion } from '@/lib/ai/prompts';
import { formString } from '@/lib/form-data';
import { authorizeAction } from '@/lib/route-guard';
import { loadViewerContext } from '@/lib/viewer-context';

export interface AiSettingsActionResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly message?: string;
}

const ADMIN_ONLY: AiSettingsActionResult = {
  ok: false,
  error: 'Only an administrator can activate a prompt version.',
};

const uuid = z.string().uuid();
const slugSchema = z.string().trim().min(1).max(120);

/**
 * The route pattern this screen is judged against.
 *
 * `packages/core` owns the route → permission matrix and is being extended by the agent that
 * owns that package; `/b/:businessSlug/setup/ai` is not in it yet. The guard fails closed on an
 * undeclared route, so until the entry lands the AI tab is judged by the requirement of the
 * Business Setup section it is the sixth tab of (§72.1). `routePermissionsFor` is consulted
 * first, so the tab follows the matrix the moment the entry exists. See the delivery report.
 */
const AI_ROUTE: string =
  routePermissionsFor('/b/:businessSlug/setup/ai') === null
    ? '/b/:businessSlug/setup'
    : '/b/:businessSlug/setup/ai';

export async function activatePromptVersionAction(
  _previous: AiSettingsActionResult,
  formData: FormData,
): Promise<AiSettingsActionResult> {
  const businessId = uuid.safeParse(formString(formData, 'businessId', ''));
  if (!businessId.success) {
    return { ok: false, error: 'That business could not be identified.' };
  }

  const context = await loadViewerContext();
  const refusal = await authorizeAction(context, {
    route: AI_ROUTE,
    businessId: businessId.data,
  });
  if (refusal !== null) return refusal;

  // The control is only rendered for an administrator; this is what makes that presentation
  // rather than protection.
  if (context.viewer.role !== 'admin') return ADMIN_ONLY;

  const versionId = uuid.safeParse(formString(formData, 'versionId', ''));
  if (!versionId.success) {
    return { ok: false, error: 'That prompt version could not be identified.' };
  }

  const result = await activatePromptVersion(context.viewer, versionId.data);
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'That prompt version could not be activated.' };
  }

  const slug = slugSchema.safeParse(formString(formData, 'businessSlug', ''));
  const promptKey = formString(formData, 'promptKey', 'this prompt');
  if (slug.success) revalidatePath(`/b/${slug.data}/setup/ai`);

  return {
    ok: true,
    error: null,
    // The cache key includes the prompt version (§60.1), so activation invalidates the AI
    // cache structurally — there is nothing to flush and nothing for the operator to remember.
    message: `Activated for ${promptKey}. New calls use it, and the AI cache key changes with it.`,
  };
}
