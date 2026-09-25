/**
 * Additive repository helpers for the USER lead-source surface (U11 hub, U16, U17).
 *
 * The ingestion pipeline itself is **not** re-implemented here: `lib/repo/ingestion.ts`
 * owns validate → normalize → dedupe → evidence → ICP/rules → lead → queue → audit, and
 * `lib/repo/profile-queue.ts` / `lib/repo/duplicates.ts` own capture and duplicate
 * resolution. The user screens call those same functions, which is what keeps the user
 * surface and the admin surface one implementation of the same behaviour.
 *
 * What is genuinely missing for a user screen is the *cross-business* view: the My Day
 * routes roll up every business the operator can see, so the profile queue and duplicate
 * review have to as well. The two readers below compose the existing per-business
 * repository functions rather than re-querying the tables, so a change to the queue's
 * visibility or ordering can never disagree between the admin and user screens.
 *
 * Nothing here spends money or enriches: there is no Apollo enrichment call, no email or
 * phone lookup and no credit-spending export anywhere in this file — spec
 * `lead_sources.apollo.prohibited_without_explicit_approval` and
 * `apollo.ui_must_label` ("Enrichment OFF").
 */
import 'server-only';

import { normalizeLinkedInUrl, normalizePersonName } from '@nexus/core';

import { withActor, type Actor, type Viewer } from '../actor';
import type { Row } from '../sql';
import {
  asBoolean,
  asIso,
  asNumber,
  asString,
  asStringOrNull,
  describeDbError,
  read,
} from './common';
import type { Business } from './businesses';
import { listDuplicateCandidates, type DuplicateCandidate } from './duplicates';
import { listImportBatches as listIngestionBatches, type ImportBatch } from './ingestion';
import { listIcpOptions } from './leads';
import { listProfileQueue as listQueueForBusiness, type ProfileQueueItem } from './profile-queue';

/* ------------------------------------------------------------- hub reads -- */

export interface UserSourceCounts {
  readonly batches: number;
  readonly importsLast30Days: number;
  readonly profileQueueOpen: number;
  readonly openDuplicates: number;
  readonly needsProfile: number;
}

/** The hub's headline numbers across every business the viewer can see. */
export async function getUserSourceCounts(
  actor: Actor,
  businessIds: readonly string[],
): Promise<UserSourceCounts> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select
         (select count(*)::int from public.import_batches b
           where b.business_id = any($1::uuid[])) as batches,
         (select count(*)::int from public.import_batches b
           where b.business_id = any($1::uuid[])
             and b.created_at > now() - interval '30 days') as recent,
         (select count(*)::int from public.profile_capture_queue q
           where q.business_id = any($1::uuid[]) and q.state in ('pending', 'in_progress')) as queue_open,
         (select count(*)::int from public.duplicate_candidates d
           where d.business_id = any($1::uuid[]) and d.status = 'open') as open_duplicates,
         (select count(*)::int from public.leads l
           where l.business_id = any($1::uuid[]) and l.needs_profile and l.deleted_at is null) as needs_profile`,
      [businessIds],
    );
    const row = result.rows[0];
    return {
      batches: asNumber(row?.batches),
      importsLast30Days: asNumber(row?.recent),
      profileQueueOpen: asNumber(row?.queue_open),
      openDuplicates: asNumber(row?.open_duplicates),
      needsProfile: asNumber(row?.needs_profile),
    };
  });
}

/** Recent import batches across the viewer's businesses (U11 "recent imports"). */
export async function listRecentImports(
  actor: Actor,
  businessIds: readonly string[],
  limit = 20,
): Promise<readonly (ImportBatch & { readonly businessId: string })[]> {
  const perBusiness = await Promise.all(
    businessIds.map(async (businessId) => {
      const batches = await listIngestionBatches(actor, businessId, limit);
      return batches.map((batch) => ({ ...batch, businessId }));
    }),
  );
  return perBusiness
    .flat()
    .sort((a, b) => (a.createdAt === null || b.createdAt === null ? 0 : b.createdAt.localeCompare(a.createdAt)))
    .slice(0, limit);
}

/* -------------------------------------------------- import wizard context -- */

/**
 * Everything the U11–U15 wizard needs, assembled the same way for all four paths.
 *
 * The ICP list is keyed by business because a Primary ICP only means something inside one
 * business; the wizard's business selector is therefore populated from the viewer's own
 * businesses, and a crafted POST cannot point it at anyone else's.
 */
export async function buildImportProps(
  actor: Actor,
  businesses: readonly Business[],
  permissions: ReadonlySet<string>,
): Promise<{
  readonly businesses: readonly { readonly value: string; readonly label: string; readonly name: string }[];
  readonly icps: readonly { readonly value: string; readonly label: string }[];
  readonly canImport: boolean;
  readonly defaultBusinessId: string;
}> {
  const perBusiness = await Promise.all(
    businesses.map(async (business) => ({
      business,
      icps: await listIcpOptions(actor, business.id),
    })),
  );

  return {
    businesses: perBusiness.map(({ business }) => ({
      value: business.id,
      label: business.name,
      name: business.name,
    })),
    icps: perBusiness.flatMap(({ business, icps }) =>
      icps.map((icp) => ({ value: icp.value, label: `${business.name} · ${icp.label}` })),
    ),
    canImport: permissions.has('lead_source.use'),
    defaultBusinessId: businesses[0]?.id ?? '',
  };
}

/* -------------------------------------------------- cross-business views -- */
export interface UserProfileQueueRow {
  readonly businessId: string;
  readonly businessName: string;
  readonly item: ProfileQueueItem;
}

/** Open profile-queue work across the viewer's businesses. */
export async function listProfileQueueForViewer(
  actor: Actor,
  businesses: readonly Business[],
  limitPerBusiness = 50,
): Promise<readonly UserProfileQueueRow[]> {
  const perBusiness = await Promise.all(
    businesses.map(async (business) => {
      const page = await listQueueForBusiness(
        actor,
        { businessId: business.id },
        { limit: limitPerBusiness },
      );
      return page.items.map((item) => ({
        businessId: business.id,
        businessName: business.name,
        item,
      }));
    }),
  );
  // Failed and pending work first, then oldest — the same triage order the queue uses.
  const order: Readonly<Record<string, number>> = {
    failed: 0,
    pending: 1,
    in_progress: 2,
    skipped: 3,
    captured: 4,
  };
  return perBusiness
    .flat()
    .sort((a, b) => {
      const byState = (order[a.item.state] ?? 9) - (order[b.item.state] ?? 9);
      if (byState !== 0) return byState;
      return (a.item.createdAt ?? '').localeCompare(b.item.createdAt ?? '');
    });
}

export interface UserDuplicateRow {
  readonly businessId: string;
  readonly businessName: string;
  readonly candidate: DuplicateCandidate;
}

/** Open duplicate candidates across the viewer's businesses, most likely first. */
export async function listDuplicatesForViewer(
  actor: Actor,
  businesses: readonly Business[],
  limitPerBusiness = 50,
): Promise<readonly UserDuplicateRow[]> {
  const perBusiness = await Promise.all(
    businesses.map(async (business) => {
      const candidates = await listDuplicateCandidates(actor, business.id, 'open', limitPerBusiness);
      return candidates.map((candidate) => ({
        businessId: business.id,
        businessName: business.name,
        candidate,
      }));
    }),
  );
  return perBusiness
    .flat()
    .sort((a, b) => (b.candidate.confidence ?? 0) - (a.candidate.confidence ?? 0));
}

/* ------------------------------------------------------------ soft delete -- */

export interface TrashedLead {
  readonly id: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly personName: string;
  readonly companyName: string | null;
  readonly jobTitle: string | null;
  readonly status: string;
  readonly deletedAt: string | null;
  readonly ownerName: string | null;
  readonly canRestore: boolean;
}

/**
 * U21 — soft-deleted leads across the viewer's businesses.
 *
 * `public.restore_lead` refuses a lead the actor neither owns nor created (unless they
 * can delete leads in that business), so the screen reports the same condition up front
 * instead of offering a button that is guaranteed to fail.
 */
export async function listTrashedLeads(
  actor: Actor,
  businessIds: readonly string[],
  viewerUserId: string | null,
): Promise<readonly TrashedLead[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select l.id, l.business_id, b.name as business_name, p.full_name as person_name,
              c.name as company_name, p.job_title, l.status, l.deleted_at, l.owner_user_id,
              l.created_by, u.full_name as owner_name
         from public.leads l
         join public.people p on p.id = l.person_id
         join public.businesses b on b.id = l.business_id
         left join public.companies c on c.id = l.company_id
         left join public.users u on u.id = l.owner_user_id
        where l.deleted_at is not null
          and l.business_id = any($1::uuid[])
        order by l.deleted_at desc
        limit 300`,
      [businessIds],
    );
    return result.rows.map((row: Row) => {
      const ownerUserId = asStringOrNull(row.owner_user_id);
      const createdBy = asStringOrNull(row.created_by);
      return {
        id: asString(row.id),
        businessId: asString(row.business_id),
        businessName: asString(row.business_name),
        personName: asString(row.person_name),
        companyName: asStringOrNull(row.company_name),
        jobTitle: asStringOrNull(row.job_title),
        status: asString(row.status, 'deleted'),
        deletedAt: asIso(row.deleted_at),
        ownerName: asStringOrNull(row.owner_name),
        canRestore:
          viewerUserId === null
            ? false
            : ownerUserId === viewerUserId || createdBy === viewerUserId,
      };
    });
  });
}

/* ------------------------------------------------------------ lead editing -- */

export interface BoundLead {
  readonly id: string;
  readonly fullName: string;
  readonly companyName: string | null;
  readonly jobTitle: string | null;
  readonly businessId: string;
  readonly businessKey: string;
  readonly businessName: string;
  readonly status: string;
  readonly nextActionAt: string | null;
}

/**
 * Minimal lead context for a screen that was opened *about* one lead.
 *
 * U18 (`/tasks/new?lead=…`), U19 (`/snooze?lead=…`) and the Companion's focus routes
 * all need to say which lead the operator is acting on, and nothing more. This reads
 * one row through RLS: a lead outside the viewer's scope simply does not resolve.
 */
export async function getBoundLead(actor: Actor, leadId: string): Promise<BoundLead | null> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select l.id, l.status, l.next_action_at, p.full_name, p.job_title,
              c.name as company_name, b.id as business_id, b.key as business_key, b.name as business_name
         from public.leads l
         join public.people p on p.id = l.person_id
         join public.businesses b on b.id = l.business_id
         left join public.companies c on c.id = l.company_id
        where l.id = $1 and l.deleted_at is null`,
      [leadId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: asString(row.id),
      fullName: asString(row.full_name),
      companyName: asStringOrNull(row.company_name),
      jobTitle: asStringOrNull(row.job_title),
      businessId: asString(row.business_id),
      businessKey: asString(row.business_key),
      businessName: asString(row.business_name),
      status: asString(row.status, 'new'),
      nextActionAt: asIso(row.next_action_at),
    };
  });
}

export interface LeadEditContext {
  readonly leadId: string;
  readonly businessId: string;
  readonly businessKey: string;
  readonly businessName: string;
  readonly personId: string;
  readonly fullName: string;
  readonly jobTitle: string | null;
  readonly headline: string | null;
  readonly location: string | null;
  readonly linkedinUrl: string | null;
  readonly companyName: string | null;
  readonly primaryIcpId: string | null;
  readonly primaryIcpName: string | null;
  readonly ownerUserId: string | null;
  readonly ownerName: string | null;
  readonly outreachIdentityId: string | null;
  readonly identityName: string | null;
  readonly status: string;
  readonly needsProfile: boolean;
}

/** The lead context U20 edits, resolved through RLS. */
export async function getLeadEditContext(
  actor: Actor,
  leadId: string,
): Promise<LeadEditContext | null> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select l.id, l.business_id, b.key as business_key, b.name as business_name, l.person_id,
              l.primary_icp_id, l.owner_user_id, l.outreach_identity_id, l.status, l.needs_profile,
              p.full_name, p.job_title, p.headline, p.location, p.linkedin_url,
              c.name as company_name, i.name as primary_icp_name,
              u.full_name as owner_name, oi.display_name as identity_name
         from public.leads l
         join public.people p on p.id = l.person_id
         join public.businesses b on b.id = l.business_id
         left join public.companies c on c.id = l.company_id
         left join public.icps i on i.id = l.primary_icp_id
         left join public.users u on u.id = l.owner_user_id
         left join public.outreach_identities oi on oi.id = l.outreach_identity_id
        where l.id = $1`,
      [leadId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      leadId: asString(row.id),
      businessId: asString(row.business_id),
      businessKey: asString(row.business_key),
      businessName: asString(row.business_name),
      personId: asString(row.person_id),
      fullName: asString(row.full_name),
      jobTitle: asStringOrNull(row.job_title),
      headline: asStringOrNull(row.headline),
      location: asStringOrNull(row.location),
      linkedinUrl: asStringOrNull(row.linkedin_url),
      companyName: asStringOrNull(row.company_name),
      primaryIcpId: asStringOrNull(row.primary_icp_id),
      primaryIcpName: asStringOrNull(row.primary_icp_name),
      ownerUserId: asStringOrNull(row.owner_user_id),
      ownerName: asStringOrNull(row.owner_name),
      outreachIdentityId: asStringOrNull(row.outreach_identity_id),
      identityName: asStringOrNull(row.identity_name),
      status: asString(row.status, 'new'),
      needsProfile: asBoolean(row.needs_profile),
    };
  });
}

export interface LeadProfileInput {
  readonly fullName?: string;
  readonly jobTitle?: string | null;
  readonly headline?: string | null;
  readonly location?: string | null;
  readonly linkedinUrl?: string | null;
  readonly companyName?: string | null;
}

/** Local result shape so an action does not depend on another module's write type. */
export interface WriteResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly message?: string;
}

/**
 * U20 — edits the profile fields of a lead, including the canonical company link.
 *
 * spec `lead_invariants`: a Person is global and is deduped on the normalized LinkedIn
 * URL, so a URL that already belongs to somebody else is refused here and left to
 * Duplicate Review. Editing company/person rows requires `can_use_lead_sources` in RLS,
 * exactly as the admin screens do — there is no second write path.
 */
export async function updateLeadProfile(
  viewer: Viewer,
  leadId: string,
  input: LeadProfileInput,
): Promise<WriteResult> {
  if (viewer.userId === null) {
    return { ok: false, error: 'Your session has expired. Sign in again.' };
  }

  const linkedinRaw = (input.linkedinUrl ?? '').trim();
  const normalized = normalizeLinkedInUrl(linkedinRaw.length === 0 ? null : linkedinRaw);
  if (linkedinRaw.length > 0 && normalized.canonicalUrl === null) {
    return {
      ok: false,
      error: 'That LinkedIn URL could not be read. Use the full https://www.linkedin.com/in/… form.',
    };
  }

  try {
    return await withActor(viewer.actor, async (sql) => {
      const lead = await sql.query<Row>(
        `select person_id, business_id from public.leads where id = $1`,
        [leadId],
      );
      const row = lead.rows[0];
      if (row === undefined) return { ok: false, error: 'That lead is not available to you.' };
      const personId = asString(row.person_id);
      const businessId = asString(row.business_id);

      if (normalized.canonicalUrl !== null) {
        const clash = await sql.query<Row>(
          `select full_name from public.people
            where normalized_linkedin_url = $1 and id <> $2 and deleted_at is null
            limit 1`,
          [normalized.canonicalUrl, personId],
        );
        const owner = clash.rows[0];
        if (owner !== undefined) {
          return {
            ok: false,
            error: `That LinkedIn URL already belongs to ${asString(owner.full_name)}. Resolve it in Duplicate Review.`,
          };
        }
      }

      let companyId: string | null = null;
      const companyName = (input.companyName ?? '').trim().slice(0, 200);
      if (companyName.length > 0) {
        const existing = await sql.query<Row>(
          `select id from public.companies where normalized_name = $1 and deleted_at is null limit 1`,
          [normalizeCompanyName(companyName)],
        );
        companyId = asStringOrNull(existing.rows[0]?.id);
        if (companyId === null) {
          const created = await sql.query<Row>(
            `insert into public.companies (name, normalized_name, created_by) values ($1, $2, $3) returning id`,
            [companyName, normalizeCompanyName(companyName), viewer.userId],
          );
          companyId = asStringOrNull(created.rows[0]?.id);
        }
      }

      await sql.query(
        `update public.people
            set full_name = coalesce(nullif($2, ''), full_name),
                normalized_name = coalesce(nullif($3, ''), normalized_name),
                job_title = $4,
                headline = $5,
                location = $6,
                linkedin_url = coalesce($7, linkedin_url),
                normalized_linkedin_url = coalesce($7, normalized_linkedin_url),
                company_id = coalesce($8, company_id),
                updated_at = now()
          where id = $1`,
        [
          personId,
          (input.fullName ?? '').trim().slice(0, 200),
          (input.fullName ?? '').trim().length === 0 ? '' : normalizePersonName(input.fullName ?? ''),
          (input.jobTitle ?? '').trim().slice(0, 200) || null,
          (input.headline ?? '').trim().slice(0, 400) || null,
          (input.location ?? '').trim().slice(0, 200) || null,
          normalized.canonicalUrl,
          companyId,
        ],
      );

      if (normalized.canonicalUrl !== null) {
        await sql.query(
          `insert into public.social_profiles (person_id, platform, profile_url, normalized_url, source, last_seen_at)
           values ($1, 'linkedin', $2, $2, 'lead_edit', now())
           on conflict (platform, normalized_url) do update set last_seen_at = now()`,
          [personId, normalized.canonicalUrl],
        );
      }

      if (companyId !== null) {
        await sql.query(`update public.leads set company_id = $2, updated_at = now() where id = $1`, [
          leadId,
          companyId,
        ]);
      }

      await sql.query(
        `insert into public.interactions
           (business_id, lead_id, person_id, type, actor_user_id, direction, summary, payload, source_client, occurred_at)
         values ($1, $2, $3, 'system', $4, 'internal', 'Lead details edited', $5::jsonb, 'web', now())`,
        [
          businessId,
          leadId,
          personId,
          viewer.userId,
          JSON.stringify({
            linkedin_url: normalized.canonicalUrl,
            company: companyName.length > 0 ? companyName : null,
          }),
        ],
      );

      return { ok: true, message: 'Lead details updated.' };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/** `updateLeadProfile` reuses the canonical company key, so it lives with it. */
function normalizeCompanyName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}


/** The number of rows one submission may carry; shared by the user import actions. */
export const MAX_IMPORT_ROWS = 2000;
