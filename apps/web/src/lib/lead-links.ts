import 'server-only';

import { withActor, type Actor } from './actor';

/**
 * Canonical lead links.
 *
 * There is exactly one lead-detail implementation — `/b/:businessSlug/leads/:leadId` (spec
 * `companion_extension.shared_lead_detail`) — and the user-facing `/my-leads/:leadId` is an alias
 * onto it. Every server-side link, redirect and `revalidatePath` that targets a lead therefore has
 * to name the business that owns it, and a screen holding only a lead id cannot guess the slug:
 * hard-coding one would send an operator in business B to a 404 in business A, and picking the
 * viewer's first business would leak a lead across businesses.
 *
 * These helpers resolve the slug through the same RLS-scoped read as everything else, so an
 * invisible lead resolves to `null` and the caller decides what to do (redirect to the list,
 * revalidate nothing) rather than producing a URL that 404s.
 */
async function mapLeadBusinessKeys(
  actor: Actor,
  leadIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(leadIds.filter((id) => id.length > 0))];
  if (unique.length === 0) return new Map();

  return withActor(actor, async (sql) => {
    const result = await sql.query<{ lead_id: string; key: string }>(
      `select l.id as lead_id, b.key
         from public.leads l
         join public.businesses b on b.id = l.business_id
        where l.id = any ($1::uuid[])`,
      [unique],
    );
    return new Map(result.rows.map((row) => [String(row.lead_id), String(row.key)]));
  });
}

/** The canonical `/b/:slug/leads/:id` path for a lead, or null when it is not visible to the actor. */
export async function canonicalLeadPath(actor: Actor, leadId: string): Promise<string | null> {
  const key = (await mapLeadBusinessKeys(actor, [leadId])).get(leadId);
  return key === undefined ? null : leadDetailPath(key, leadId);
}

/** The same resolution for a list screen, in one query rather than one per row. */
export async function canonicalLeadPaths(
  actor: Actor,
  leadIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const keys = await mapLeadBusinessKeys(actor, leadIds);
  const paths = new Map<string, string>();
  for (const [leadId, key] of keys) paths.set(leadId, leadDetailPath(key, leadId));
  return paths;
}

/** The business key that owns a lead, for a redirect that has to pick a context. */
export async function leadBusinessKey(actor: Actor, leadId: string): Promise<string | null> {
  return (await mapLeadBusinessKeys(actor, [leadId])).get(leadId) ?? null;
}

/** Pure builders, so a client component with a slug (or a page with both) needs no lookup. */
export function leadDetailPath(businessSlug: string, leadId: string): string {
  return `/b/${businessSlug}/leads/${leadId}`;
}

export function leadEditPath(businessSlug: string, leadId: string): string {
  return `/b/${businessSlug}/leads/${leadId}/edit`;
}

export function leadTaskPath(leadId: string): string {
  return `/tasks/new?lead=${encodeURIComponent(leadId)}`;
}

export function leadSnoozePath(leadId: string): string {
  return `/snooze?lead=${encodeURIComponent(leadId)}`;
}
