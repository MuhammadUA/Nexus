'use server';

/**
 * A30 â€” Admin Â· Business Domains mutations.
 *
 * spec `admin_self_assignment_and_domains.business_domains`:
 *   "Associate owned/official domains with a Nexus business for scoping, matching and
 *    admin defaults â€¦ One primary business context per registered domain. Explicit
 *    aliases are allowed. Never auto-merge leads across businesses because of a
 *    related/parent domain."
 *
 * The database does the enforcing and this file only validates shape:
 *   - `business_domains_normalized_unique (normalized_domain)` â€” a normalized domain
 *     exists once, under exactly one business;
 *   - `business_domains_default_primary_key` â€” at most one default primary per business;
 *   - `trg_business_domains_normalize` â€” lowercases and strips scheme/www/path before
 *     the uniqueness check, so `https://www.Example.com/x` and `example.com` collide.
 *
 * There is deliberately no merge action here: no domain operation touches leads.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { authorizeAction } from '@/lib/route-guard';
import { createDomain, deleteDomain } from '@/lib/repo/businesses';
import { formString, formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const notSignedIn: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

const domainTypeSchema = z.enum(['primary', 'alias', 'parent_source', 'service']);

const createSchema = z.object({
  businessId: z.string().uuid(),
  domain: z
    .string()
    .trim()
    .min(3)
    .max(253)
    .regex(
      /^(https?:\/\/)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(\/\S*)?$/i,
      'Enter a domain such as example.com. A URL is accepted and normalized.',
    ),
  domainType: domainTypeSchema,
  isDefault: z.boolean(),
  notes: z.string().trim().max(500).nullish(),
});

export async function createDomainAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/business-domains' });
  if (refusal !== null) return refusal;

  const parsed = createSchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    domain: formStringOrNull(formData, 'domain'),
    domainType: formString(formData, 'domainType', 'alias'),
    isDefault: formStringOrNull(formData, 'isDefault') === 'on',
    notes: formStringOrNull(formData, 'notes'),
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first?.message ?? 'Check the domain and try again.' };
  }

  // A "default" that is not a primary domain is meaningless: the partial unique index
  // only covers `is_default and domain_type = 'primary'`.
  if (parsed.data.isDefault && parsed.data.domainType !== 'primary') {
    return { ok: false, error: 'Only a primary domain can be the default for a business.' };
  }

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await createDomain(viewer, {
    businessId: parsed.data.businessId ?? undefined,
    domain: parsed.data.domain ?? undefined,
    domainType: parsed.data.domainType ?? undefined,
    isDefault: parsed.data.isDefault ?? undefined,
    notes: parsed.data.notes == null || parsed.data.notes.length === 0 ? null : parsed.data.notes,
  });

  if (result.ok) revalidatePath('/business-domains');
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Domain registered.' : undefined,
  };
}

const deleteSchema = z.object({ id: z.string().uuid() });

/**
 * Removing a domain changes scoping and matching only. spec is explicit that a
 * related/parent domain never merged leads across businesses, so there is nothing to
 * unwind on delete.
 */
export async function deleteDomainAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  // Independently authorized: a Server Action is reachable without its page.
  const refusal = await authorizeAction(null, { route: '/business-domains' });
  if (refusal !== null) return refusal;

  const parsed = deleteSchema.safeParse({ id: formStringOrNull(formData, 'id') });
  if (!parsed.success) return { ok: false, error: 'That domain could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await deleteDomain(viewer, parsed.data.id);
  if (result.ok) revalidatePath('/business-domains');
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Domain removed.' : undefined,
  };
}
