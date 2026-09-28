import { cloneElement, createElement, isValidElement, type ReactNode } from 'react';

import {
  OUTREACH_CHANNELS,
  normalizeDiscoverySource,
  type DiscoverySource,
  type EnrichmentState,
  type OutreachChannel,
} from '@nexus/core';
import {
  Card,
  Chip,
  DataTable,
  EmptyState,
  Field,
  LeadStatusChip,
  PageHead,
  Row,
  VisuallyHidden,
  actionLabel,
  type Column,
} from '@nexus/ui';
import { notFound, redirect } from 'next/navigation';

import { AddLeadForm, LeadRowIntelligenceActions } from '@/components/lead-enrichment-workspace';
import {
  discoverySourceLabel,
  discoverySourceOptions,
  enrichmentStateAccent,
  enrichmentStateLabel,
  intelligenceLabel,
  isEnrichmentState,
  missingFieldsText,
  outreachChannelLabel,
  storedSourceValuesFor,
} from '@/components/lead-intelligence-brief';
import { LeadBulkBar } from '@/components/lead-bulk-actions';
import { LeadFilterBar } from '@/components/lead-filter-bar';
import { LeadRowMenu } from '@/components/lead-row-menu';
import { PAGE_SIZE_PARAM, filterHref, pageHref } from '@/lib/filter-url';
import { QUICK_FILTER_CHIPS, QUICK_FILTER_KEYS, chipIsActive } from '@/lib/quick-filter-chips';
import { type Actor } from '@/lib/actor';
import { asNumber, asString, asStringArray, read } from '@/lib/repo/common';
import { listSavedViews, viewHref } from '@/lib/repo/saved-views';
import {
  NEEDS_ATTENTION_STATUSES,
  getLeadCounts,
  listIcpOptions,
  listIdentityOptions,
  listLeadsByIds,
  listOwnerOptions,
  type LeadCounts,
  type LeadListItem,
} from '@/lib/repo/leads';
import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';

import './leads.css';

export const dynamic = 'force-dynamic';

/**
 * The query string this screen reads.
 *
 * Carries an index signature as well as the named keys: every filter belongs in the URL,
 * and both the pager and the filter controls rebuild a link from whatever is in it, so
 * the page has to be able to read a key it did not enumerate.
 */
export type LeadsSearchParams = {
  readonly [key: string]: string | undefined;
  readonly icp?: string;
  readonly identity?: string;
  readonly status?: string;
  readonly source?: string;
  readonly owner?: string;
  readonly ownerNone?: string;
  readonly q?: string;
  readonly sort?: string;
  readonly view?: string;
  readonly needsProfile?: string;
  readonly dnc?: string;
  readonly followups?: string;
  readonly needsAttention?: string;
  /** V1.2 (§68.5): the enrichment state, one of the nine-state vocabulary. */
  readonly enrichment?: string;
  /** V1.2 (§68.5): a channel the lead can actually be contacted on. */
  readonly channel?: string;
  /** V1.2 (§68.5): minimum `lead_enrichment.completeness_score`. */
  readonly minIntelligence?: string;
  /** Renders the add-lead panel open, so the header's "+ Lead" button lands on the form. */
  readonly add?: string;
  readonly page?: string;
  readonly pageSize?: string;
};

/** Rows per page unless the URL asks otherwise. */
const DEFAULT_PAGE_SIZE = 25;

/**
 * Bounds on the `pageSize` override.
 *
 * The upper bound is a load guard rather than a product rule: 100 rows still render
 * quickly, and anything larger is a hand-edited URL rather than a screen anyone asked for.
 */
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 100;

/** The id shared by the bulk form and the row checkboxes that submit into it. */
const BULK_FORM_ID = 'leads-bulk-form';

type LeadSort = 'recent_activity' | 'name' | 'company' | 'next_action' | 'created';

/**
 * The enrichment-status filter values.
 *
 * The nine states plus the derived `NOT_READY` bucket, which is §71.2's "Needs Enrichment":
 * `lead_enrichment.status <> 'READY'`. It is a set rather than a state, so it is expressed as a
 * filter value of its own instead of pretending to be one of the nine.
 */
type EnrichmentFilterValue = EnrichmentState | 'NOT_READY';

/** True when a URL value is one of the nine states or the derived needs-enrichment bucket. */
function parseEnrichmentFilter(value: string): EnrichmentFilterValue | null {
  if (value === 'NOT_READY') return 'NOT_READY';
  return isEnrichmentState(value) ? value : null;
}

function parseSort(value: string | undefined): LeadSort {
  switch (value) {
    case 'name':
    case 'company':
    case 'next_action':
    case 'created':
    case 'recent_activity':
      return value;
    default:
      return 'recent_activity';
  }
}

/**
 * The page size the URL asks for, clamped.
 *
 * This exists so the pager can be exercised and verified at a size smaller than the
 * seeded result set. With 25 rows per page a business of a couple of dozen leads has
 * exactly one page, and a one-page pager proves nothing about whether the records beyond
 * the first page are reachable; `pageSize=5` makes a gap or a duplicate visible.
 */
function parsePageSize(value: string | undefined): number {
  const parsed = Number(value ?? String(DEFAULT_PAGE_SIZE));
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(parsed), MIN_PAGE_SIZE), MAX_PAGE_SIZE);
}

/** True when a boolean-ish flag param is present and not explicitly switched off. */
function flagged(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/** A 0–100 integer from the URL, or null when absent/unusable. */
function parsePercent(value: string | undefined): number | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(Math.round(parsed), 0), 100);
}

/* ------------------------------------------------------ the V1.2 list read -- */

/**
 * The predicates this screen applies, in one place.
 *
 * **Why this exists at all.** The list has to be selected *and* filtered on a column that
 * lives in `public.lead_enrichment` (§68.2), and the repository's `listLeads` cannot express
 * that join. Rather than page the rows and filter what came back — which would make "showing
 * N of M" a lie and hide records behind an inaccessible cap (§68.4) — the selection runs
 * here with the same predicate semantics as `lib/repo/leads.ts`, in one bounded query per
 * request. Row *shape* still comes from the repository (`listLeadsByIds`), so the column set
 * has one definition.
 *
 * The follow-up predicate is the one fragment duplicated from `leadWhere`, because it is
 * private to that module and this file may not edit it. It is reproduced verbatim so the
 * chip's count and this filter cannot drift; a change there must be mirrored here.
 */
interface LeadListFilter {
  readonly businessId: string;
  readonly icpId?: string;
  readonly identityId?: string;
  readonly status?: string;
  readonly source?: DiscoverySource;
  readonly ownerUserId?: string | null;
  readonly statusesIn?: readonly string[];
  readonly search?: string;
  readonly needsProfileOnly?: boolean;
  readonly dncOnly?: boolean;
  readonly followupsOnly?: boolean;
  readonly enrichmentStatus?: EnrichmentFilterValue;
  readonly minIntelligence?: number;
  readonly channel?: OutreachChannel;
}

interface SqlFragment {
  readonly clause: string;
  readonly params: readonly unknown[];
}

/** The FROM every list query shares, including the enrichment join. */
const LIST_FROM = `from public.leads l
   join public.people p on p.id = l.person_id
   left join public.companies c on c.id = l.company_id
   left join public.lead_enrichment e on e.lead_id = l.id`;

function listWhere(filter: LeadListFilter): SqlFragment {
  const conditions: string[] = ['l.deleted_at is null'];
  const params: unknown[] = [];

  params.push(filter.businessId);
  conditions.push(`l.business_id = $${String(params.length)}`);

  if (filter.icpId !== undefined) {
    params.push(filter.icpId);
    conditions.push(`l.primary_icp_id = $${String(params.length)}`);
  }
  if (filter.identityId !== undefined) {
    params.push(filter.identityId);
    conditions.push(`l.outreach_identity_id = $${String(params.length)}`);
  }
  if (filter.status !== undefined) {
    params.push(filter.status);
    conditions.push(`l.status = $${String(params.length)}`);
  }
  if (filter.statusesIn !== undefined && filter.statusesIn.length > 0) {
    params.push([...filter.statusesIn]);
    conditions.push(`l.status = any($${String(params.length)}::text[])`);
  }
  if (filter.source !== undefined) {
    params.push(storedSourceValuesFor(filter.source));
    conditions.push(`l.source_type = any($${String(params.length)}::text[])`);
  }
  if (filter.ownerUserId === null) {
    conditions.push('l.owner_user_id is null');
  } else if (filter.ownerUserId !== undefined) {
    params.push(filter.ownerUserId);
    conditions.push(`l.owner_user_id = $${String(params.length)}`);
  }
  if (filter.needsProfileOnly === true) conditions.push('l.needs_profile = true');
  if (filter.dncOnly === true) conditions.push('l.is_dnc = true');
  if (filter.followupsOnly === true) {
    // Mirrors FOLLOWUP_DUE_SQL in `lib/repo/leads.ts` — see the note above.
    conditions.push(
      `(l.status in ('followup_due', 'connection_due', 'message_due', 'cooldown', 'reactivation_due')
        or l.next_action_at is not null)`,
    );
  }

  if (filter.search !== undefined && filter.search.trim().length > 0) {
    params.push(`%${filter.search.trim()}%`);
    const index = `$${String(params.length)}`;
    conditions.push(
      `(p.full_name ilike ${index} or coalesce(c.name, '') ilike ${index} or coalesce(p.linkedin_url, '') ilike ${index})`,
    );
  }

  /*
   * §68.2 — the enrichment state comes from `public.lead_enrichment`, and a missing row reads
   * as MINIMAL. The score is the **stored** `completeness_score`; it is never recomputed in
   * SQL, because a second implementation of the weight table is how two screens start
   * disagreeing about the same lead.
   */
  if (filter.enrichmentStatus !== undefined) {
    if (filter.enrichmentStatus === 'NOT_READY') {
      // §71.2's "Needs Enrichment", expressed as the one predicate the Overview metric uses, so the
      // chip and the metric cannot disagree about which leads need work.
      conditions.push(`coalesce(e.status, 'MINIMAL') <> 'READY'`);
    } else {
      params.push(filter.enrichmentStatus);
      conditions.push(`coalesce(e.status, 'MINIMAL') = $${String(params.length)}`);
    }
  }
  if (filter.minIntelligence !== undefined) {
    params.push(filter.minIntelligence);
    conditions.push(`coalesce(e.completeness_score, 0) >= $${String(params.length)}`);
  }

  /*
   * §20.3 — available channels come from the accounts the business holds and the contact
   * points the person has. Both halves are required: an account with no address is not
   * reachability, and an address with no account is not a sending route. The person's
   * canonical LinkedIn URL counts as the LinkedIn handle (§25.1 keeps it as a person fact).
   */
  if (filter.channel !== undefined) {
    params.push(filter.channel);
    const channel = `$${String(params.length)}`;
    conditions.push(`exists (
      select 1 from public.outreach_identities oi
        join public.outreach_identity_business_access a on a.outreach_identity_id = oi.id
       where a.business_id = l.business_id
         and oi.channel = ${channel}
         and oi.status = 'active'
         and oi.deleted_at is null
    )`);
    conditions.push(`(
      exists (
        select 1 from public.person_contact_points cp
         where cp.person_id = l.person_id and cp.deleted_at is null and cp.kind = ${channel}
      )
      or (${channel} = 'linkedin' and p.normalized_linkedin_url is not null)
    )`);
  }

  return { clause: `where ${conditions.join(' and ')}`, params };
}

/**
 * The `order by` clause, always ended with `l.id`.
 *
 * A total order, not merely a deterministic one: paging with `limit`/`offset` over a
 * non-total order is unsound, and two leads that tie on the visible key could otherwise
 * appear on two pages or on none.
 */
function listOrderBy(sort: LeadSort): string {
  switch (sort) {
    case 'name':
      return 'order by p.full_name, l.id';
    case 'company':
      return 'order by c.name nulls last, p.full_name, l.id';
    case 'next_action':
      return 'order by l.next_action_at asc nulls last, l.id';
    case 'created':
      return 'order by l.created_at desc, l.id';
    case 'recent_activity':
    default:
      return 'order by l.last_activity_at desc nulls last, l.created_at desc, l.id';
  }
}

/** One page of lead ids, plus the total the same predicate returns. */
async function selectLeadPage(
  actor: Actor,
  filter: LeadListFilter,
  sort: LeadSort,
  limit: number,
  offset: number,
): Promise<{ readonly ids: readonly string[]; readonly total: number }> {
  const where = listWhere(filter);

  return read(actor, async (sql) => {
    const [page, counted] = await Promise.all([
      sql.query<Record<string, unknown>>(
        `select l.id ${LIST_FROM} ${where.clause} ${listOrderBy(sort)}
          limit $${String(where.params.length + 1)} offset $${String(where.params.length + 2)}`,
        [...where.params, limit, offset],
      ),
      sql.query<Record<string, unknown>>(
        `select count(*)::int as n ${LIST_FROM} ${where.clause}`,
        where.params,
      ),
    ]);

    return {
      ids: page.rows.map((row) => asString(row.id)),
      total: asNumber(counted.rows[0]?.n, 0),
    };
  });
}

/* ----------------------------------------------------- the intelligence overlay -- */

interface RowIntelligence {
  readonly enrichmentStatus: string;
  readonly completenessScore: number;
  readonly missingFields: readonly string[];
  readonly lastErrorCode: string | null;
  readonly lastProfileEnrichmentAt: string | null;
  readonly lastCompanyEnrichmentAt: string | null;
  readonly bestFit: number | null;
  readonly primaryReason: string | null;
  readonly qualified: boolean;
  readonly contextVersion: number | null;
  readonly contextCreatedAt: string | null;
  readonly signalKind: string | null;
  readonly signalLabel: string | null;
  readonly signalPolarity: string | null;
  readonly signalObservedAt: string | null;
  readonly contactKinds: readonly string[];
  readonly openJobs: number;
  readonly failedJobs: number;
  /** Facts the V1.2 columns read: the location column, the channel rule and the search links. */
  readonly location: string | null;
  readonly linkedinUrl: string | null;
  readonly companyDomain: string | null;
}

const EMPTY_INTELLIGENCE: RowIntelligence = {
  // §68.2: a lead with no `lead_enrichment` row is read as MINIMAL with 0. §14.3 makes that
  // row impossible, so this is the defect-tolerant side of the same rule rather than a mode.
  enrichmentStatus: 'MINIMAL',
  completenessScore: 0,
  missingFields: [],
  lastErrorCode: null,
  lastProfileEnrichmentAt: null,
  lastCompanyEnrichmentAt: null,
  bestFit: null,
  primaryReason: null,
  qualified: false,
  contextVersion: null,
  contextCreatedAt: null,
  signalKind: null,
  signalLabel: null,
  signalPolarity: null,
  signalObservedAt: null,
  contactKinds: [],
  openJobs: 0,
  failedJobs: 0,
  location: null,
  linkedinUrl: null,
  companyDomain: null,
};

/**
 * Everything the V1.2 columns need for one page of leads, in **one** query.
 *
 * This is the heart of "keep the query count flat": the page's lead ids are the only input,
 * and each dimension is a bounded aggregate joined onto them. There is no per-row query, no
 * raw body, no message history and no timeline — §68.6 allows structured columns only.
 */
async function loadRowIntelligence(
  actor: Actor,
  leadIds: readonly string[],
): Promise<ReadonlyMap<string, RowIntelligence>> {
  if (leadIds.length === 0) return new Map();

  return read(actor, async (sql) => {
    const result = await sql.query<Record<string, unknown>>(
      `with page_leads as (
         select l.id as lead_id, l.person_id, l.company_id
           from public.leads l
          where l.id = any($1::uuid[])
       ),
       latest_signal as (
         select distinct on (s.lead_id) s.lead_id, s.kind, s.label, s.polarity, s.observed_at
           from public.signals s
          where s.is_active and s.lead_id = any($1::uuid[])
          order by s.lead_id, s.observed_at desc
       ),
       qualification as (
         select m.lead_id,
                max(m.match_score) as best_score,
                bool_or(m.is_primary) as has_primary,
                (array_agg(m.reason order by m.is_primary desc, m.match_score desc nulls last))[1] as primary_reason
           from public.lead_icp_matches m
          where m.lead_id = any($1::uuid[])
          group by m.lead_id
       ),
       context as (
         select p.lead_id, max(p.version) as version, max(p.created_at) as created_at
           from public.ai_context_packs p
          where p.lead_id = any($1::uuid[])
          group by p.lead_id
       ),
       jobs as (
         select j.lead_id,
                count(*) filter (where j.status in ('OPEN', 'RUNNING', 'WAITING_AI'))::int as open_jobs,
                count(*) filter (where j.status = 'FAILED')::int as failed_jobs
           from public.agent_jobs j
          where j.lead_id = any($1::uuid[])
          group by j.lead_id
       ),
       contacts as (
         select cp.person_id, array_agg(distinct cp.kind) as kinds
           from public.person_contact_points cp
          where cp.deleted_at is null
            and cp.person_id in (select person_id from page_leads)
          group by cp.person_id
       )
       select pg.lead_id,
              e.status as enrichment_status,
              e.completeness_score,
              e.missing_fields,
              e.last_error_code,
              e.last_profile_enrichment_at,
              e.last_company_enrichment_at,
              q.best_score,
              q.has_primary,
              q.primary_reason,
              ctx.version as context_version,
              ctx.created_at as context_created_at,
              sig.kind as signal_kind,
              sig.label as signal_label,
              sig.polarity as signal_polarity,
              sig.observed_at as signal_observed_at,
              contacts.kinds as contact_kinds,
              coalesce(jobs.open_jobs, 0) as open_jobs,
              coalesce(jobs.failed_jobs, 0) as failed_jobs,
              p.location as person_location,
              p.linkedin_url as person_linkedin_url,
              c.normalized_domain as company_domain
         from page_leads pg
         left join public.people p on p.id = pg.person_id
         left join public.companies c on c.id = pg.company_id
         left join public.lead_enrichment e on e.lead_id = pg.lead_id
         left join qualification q on q.lead_id = pg.lead_id
         left join context ctx on ctx.lead_id = pg.lead_id
         left join latest_signal sig on sig.lead_id = pg.lead_id
         left join contacts on contacts.person_id = pg.person_id
         left join jobs on jobs.lead_id = pg.lead_id`,
      [[...leadIds]],
    );

    const map = new Map<string, RowIntelligence>();
    for (const row of result.rows) {
      const status = asString(row.enrichment_status, 'MINIMAL');
      map.set(asString(row.lead_id), {
        enrichmentStatus: isEnrichmentState(status) ? status : 'MINIMAL',
        completenessScore: asNumber(row.completeness_score, 0),
        missingFields: asStringArray(row.missing_fields),
        lastErrorCode: typeof row.last_error_code === 'string' ? row.last_error_code : null,
        lastProfileEnrichmentAt:
          typeof row.last_profile_enrichment_at === 'string' ? row.last_profile_enrichment_at : null,
        lastCompanyEnrichmentAt:
          typeof row.last_company_enrichment_at === 'string' ? row.last_company_enrichment_at : null,
        bestFit: row.best_score === null || row.best_score === undefined ? null : asNumber(row.best_score),
        primaryReason: typeof row.primary_reason === 'string' ? row.primary_reason : null,
        qualified: row.has_primary === true || row.best_score !== null,
        contextVersion:
          row.context_version === null || row.context_version === undefined
            ? null
            : asNumber(row.context_version),
        contextCreatedAt:
          typeof row.context_created_at === 'string'
            ? row.context_created_at
            : row.context_created_at instanceof Date
              ? row.context_created_at.toISOString()
              : null,
        signalKind: typeof row.signal_kind === 'string' ? row.signal_kind : null,
        signalLabel: typeof row.signal_label === 'string' ? row.signal_label : null,
        signalPolarity: typeof row.signal_polarity === 'string' ? row.signal_polarity : null,
        signalObservedAt:
          typeof row.signal_observed_at === 'string'
            ? row.signal_observed_at
            : row.signal_observed_at instanceof Date
              ? row.signal_observed_at.toISOString()
              : null,
        contactKinds: asStringArray(row.contact_kinds),
        openJobs: asNumber(row.open_jobs, 0),
        failedJobs: asNumber(row.failed_jobs, 0),
        location: typeof row.person_location === 'string' ? row.person_location : null,
        linkedinUrl: typeof row.person_linkedin_url === 'string' ? row.person_linkedin_url : null,
        companyDomain: typeof row.company_domain === 'string' ? row.company_domain : null,
      });
    }
    return map;
  });
}

/** The channels this business can actually send on, from its non-retired accounts. */
async function loadAccountChannels(
  actor: Actor,
  businessId: string,
): Promise<readonly OutreachChannel[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Record<string, unknown>>(
      `select distinct oi.channel
         from public.outreach_identities oi
         join public.outreach_identity_business_access a on a.outreach_identity_id = oi.id
        where a.business_id = $1
          and oi.deleted_at is null
          and oi.status <> 'retired'
        order by oi.channel`,
      [businessId],
    );
    const found = new Set(result.rows.map((row) => asString(row.channel)));
    return OUTREACH_CHANNELS.filter((channel) => found.has(channel));
  });
}

/* -------------------------------------------------------------------- page -- */

/**
 * A03 — Leads (V1.2).
 *
 * Contract: §68 — "Person, Company, title/location, enrichment status, completeness, source,
 * ICP, fit/intent, channels, owner, next action, latest signal, AI context readiness", with
 * the row actions *Open, Find LinkedIn, Enrich, Research Company, Create Agent Job, Draft
 * Outreach*.
 *
 * Four V1.2 rules shape what is on this screen:
 *
 *   1. **The enrichment columns are stored values.** Status and score come from
 *      `public.lead_enrichment` through a LEFT JOIN; the percentage is never computed in SQL
 *      and a missing row reads as MINIMAL with 0 (§68.2).
 *   2. **The search links are deterministic.** Every "Find LinkedIn" is built by
 *      `searchLinks()` from stored facts — no model is asked to compose a query and the link
 *      costs nothing (§30.1). A lead with no name has the action disabled with the missing
 *      field named instead (§30.3.4).
 *   3. **No inaccessible caps.** The count on screen is the count the query returned, the
 *      pager reaches every row, and a page past the end is corrected rather than rendered
 *      empty (§68.4).
 *   4. **No work starts on render.** Nothing here calls a model or creates a job; the row
 *      actions post server actions, and the source and search columns are pure reads (§76.1).
 */
export default async function LeadsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<LeadsSearchParams>;
}): Promise<ReactNode> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  const page = Math.max(Number(query.page ?? '1') || 1, 1);
  const pageSize = parsePageSize(query.pageSize);
  const sort = parseSort(query.sort);
  const needsAttention = flagged(query.needsAttention);
  const enrichmentParam = query.enrichment ?? '';
  const enrichmentFilter = parseEnrichmentFilter(enrichmentParam);
  const channelParam = query.channel ?? '';
  const minIntelligence = parsePercent(query.minIntelligence);

  const filter: LeadListFilter = {
    businessId: business.id,
    ...(query.icp === undefined || query.icp.length === 0 ? {} : { icpId: query.icp }),
    ...(query.identity === undefined || query.identity.length === 0
      ? {}
      : { identityId: query.identity }),
    ...(query.status === undefined || query.status.length === 0 ? {} : { status: query.status }),
    // The source filter accepts the V1.2 discovery vocabulary and the legacy one (§18.3).
    ...(query.source === undefined || query.source.length === 0
      ? {}
      : { source: query.source as DiscoverySource }),
    // An explicit owner id wins; "unassigned" is `null`, which is a filter of its own
    // rather than the absence of one.
    ...(query.owner !== undefined && query.owner.length > 0
      ? { ownerUserId: query.owner }
      : flagged(query.ownerNone)
        ? { ownerUserId: null }
        : {}),
    ...(query.q === undefined || query.q.trim().length === 0 ? {} : { search: query.q }),
    ...(flagged(query.needsProfile) ? { needsProfileOnly: true } : {}),
    ...(flagged(query.dnc) ? { dncOnly: true } : {}),
    ...(flagged(query.followups) ? { followupsOnly: true } : {}),
    ...(needsAttention ? { statusesIn: NEEDS_ATTENTION_STATUSES } : {}),
    ...(enrichmentFilter === null ? {} : { enrichmentStatus: enrichmentFilter }),
    ...(minIntelligence === null ? {} : { minIntelligence }),
    ...(channelParam.length === 0 ? {} : { channel: channelParam as OutreachChannel }),
  };

  /**
   * Round one: the page of ids, the total, the aggregate counts, the filter options and the
   * business's own sending accounts. All independent, all in parallel (§76.3).
   */
  const [selection, counts, icps, identities, owners, savedViews, accountChannels] = await Promise.all([
    selectLeadPage(context.viewer.actor, filter, sort, pageSize, (page - 1) * pageSize),
    getLeadCounts(context.viewer.actor, business.id),
    listIcpOptions(context.viewer.actor, business.id),
    listIdentityOptions(context.viewer.actor, business.id),
    listOwnerOptions(context.viewer.actor, business.id),
    listSavedViews(context.viewer.actor, business.id, 'leads', context.viewer.userId),
    loadAccountChannels(context.viewer.actor, business.id),
  ]);

  const total = selection.total;
  const basePath = `/b/${business.key}/leads`;
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);

  /**
   * A page past the end is corrected rather than rendered empty.
   *
   * Rendering the empty state for `page=6` of a five-page result is indistinguishable
   * from a filter that matches nothing, so the operator cannot tell "you overshot" from
   * "there is nothing here" — and an unreachable-tail defect would present as an ordinary
   * empty result set.
   */
  if (page > totalPages) redirect(pageHref(basePath, query, totalPages));

  /**
   * Round two: the row shape from the repository, and the V1.2 overlay for exactly the ids
   * that are on this page. Two bounded reads, no per-row query.
   */
  const [leadRows, intelligenceById] = await Promise.all([
    listLeadsByIds(context.viewer.actor, selection.ids),
    loadRowIntelligence(context.viewer.actor, selection.ids),
  ]);

  // `listLeadsByIds` is unordered by contract, so the page's order is restored from the
  // selection. A row the policy did not return is dropped rather than rendered blank.
  const rowById = new Map(leadRows.map((row) => [row.id, row]));
  const leads = selection.ids
    .map((id) => rowById.get(id))
    .filter((row): row is LeadListItem => row !== undefined);

  /**
   * Whether the viewer may write leads in *this* business.
   *
   * The row menu uses it to decide between offering Archive/Move to Trash and not
   * rendering them. The server action re-checks the fine-grained permission per
   * operation, so this only controls what is offered, never what is allowed.
   */
  const canWriteLeads = context.permissions.has('lead.update');
  const canCreateJobs = canWriteLeads;
  const canCreateLeads = context.permissions.has('lead.create') && context.permissions.has('lead_source.use');

  /**
   * The row selection control.
   *
   * The checkbox has to submit into the bulk form, which is a different `<form>` element
   * (a form cannot nest inside another). Cloning the input with a `form` attribute is
   * what lets the row control and the bulk buttons agree on what is selected without a
   * client-side copy of the list.
   */
  function selectionCell(lead: LeadListItem): ReactNode {
    const input = createElement('input', {
      type: 'checkbox',
      name: 'leadIds',
      value: lead.id,
      'aria-label': `Select ${lead.personName}`,
    });

    const withForm = isValidElement<{ form?: string }>(input)
      ? cloneElement(input, { form: BULK_FORM_ID })
      : input;

    return <div className="nx-stack nx-stack--sm">{withForm}</div>;
  }

  /** Channels this lead can be contacted on: an account **and** a reachable contact point. */
  function availableChannels(intelligence: RowIntelligence): readonly OutreachChannel[] {
    return accountChannels.filter((channel) => {
      if (intelligence.contactKinds.includes(channel)) return true;
      // The canonical LinkedIn URL is the handle for the LinkedIn channel (§25.1 keeps it as a
      // person fact rather than a contact point).
      return channel === 'linkedin' && intelligence.linkedinUrl !== null;
    });
  }

  const columns: readonly Column<LeadListItem>[] = [
    {
      key: 'select',
      header: <VisuallyHidden>Select</VisuallyHidden>,
      width: '34px',
      cell: (lead) => selectionCell(lead),
    },
    {
      key: 'person',
      header: 'Person',
      cell: (lead) => (
        <a className="nx-table__strong" href={`${basePath}/${lead.id}`}>
          {lead.personName}
        </a>
      ),
    },
    {
      key: 'company',
      header: 'Company',
      cell: (lead) => lead.companyName ?? <span className="nx-hint">—</span>,
    },
    {
      key: 'title_location',
      header: 'Title / location',
      cell: (lead) => {
        const intelligence = intelligenceById.get(lead.id) ?? EMPTY_INTELLIGENCE;
        return (
          <div className="nx-stack nx-stack--sm">
            <span>{lead.jobTitle ?? <span className="nx-hint">no title</span>}</span>
            {intelligence.location !== null && <span className="nx-hint">{intelligence.location}</span>}
          </div>
        );
      },
    },
    {
      key: 'enrichment',
      header: 'Enrichment',
      cell: (lead) => {
        const intelligence = intelligenceById.get(lead.id) ?? EMPTY_INTELLIGENCE;
        return (
          <div className="nx-stack nx-stack--sm">
            <Chip
              accent={enrichmentStateAccent(intelligence.enrichmentStatus)}
              dataState={String(intelligence.enrichmentStatus)}
            >
              {enrichmentStateLabel(intelligence.enrichmentStatus)}
            </Chip>
            {intelligence.lastErrorCode !== null && (
              <span className="nx-hint" title={intelligence.lastErrorCode}>
                {intelligence.lastErrorCode}
              </span>
            )}
            {intelligence.openJobs > 0 && (
              <span className="nx-hint">
                {String(intelligence.openJobs)} job{intelligence.openJobs === 1 ? '' : 's'} in flight
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'completeness',
      header: 'Completeness',
      cell: (lead) => {
        const intelligence = intelligenceById.get(lead.id) ?? EMPTY_INTELLIGENCE;
        const missing = missingFieldsText(intelligence.missingFields);
        return (
          <div className="nx-stack nx-stack--sm">
            <span className="nx-intel-value">{intelligenceLabel(intelligence.completenessScore)}</span>
            {/* §29.2: a score below 100 is never rendered without its missing pieces named. */}
            {missing !== null && (
              <span className="nx-hint nx-clamp" title={missing}>
                {missing}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'source',
      header: 'Source',
      cell: (lead) => (
        // §68.2 — the discovery source, never a channel. The stored value is projected onto the
        // V1.2 vocabulary, so a legacy `google_search` reads as Google rather than as itself.
        <span title={lead.sourceUrl ?? lead.sourceType ?? undefined}>
          {discoverySourceLabel(normalizeDiscoverySource(lead.sourceType))}
        </span>
      ),
    },
    {
      key: 'icp',
      header: 'ICP',
      cell: (lead) =>
        lead.primaryIcpName === null ? (
          <Chip accent="amber">unmatched</Chip>
        ) : (
          <Chip accent="indigo">{lead.primaryIcpName}</Chip>
        ),
    },
    {
      key: 'fit',
      header: 'Fit / intent',
      cell: (lead) => {
        const intelligence = intelligenceById.get(lead.id) ?? EMPTY_INTELLIGENCE;
        if (!intelligence.qualified) {
          return <span className="nx-hint">not qualified</span>;
        }
        return (
          <div className="nx-stack nx-stack--sm">
            <Chip accent="indigo">
              fit {intelligence.bestFit === null ? 'recorded' : String(intelligence.bestFit)}
            </Chip>
            {intelligence.primaryReason !== null && (
              <span className="nx-hint nx-clamp" title={intelligence.primaryReason}>
                {intelligence.primaryReason}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'channels',
      header: 'Channels',
      cell: (lead) => {
        const intelligence = intelligenceById.get(lead.id) ?? EMPTY_INTELLIGENCE;
        const channels = availableChannels(intelligence);
        if (channels.length === 0) {
          return (
            <span className="nx-hint" title="No channel account and contact point pair exists for this lead yet">
              no reachable channel
            </span>
          );
        }
        return (
          <Row wrap>
            {channels.map((channel) => (
              <Chip key={channel} accent="cyan">
                {outreachChannelLabel(channel)}
              </Chip>
            ))}
          </Row>
        );
      },
    },
    {
      key: 'owner',
      header: 'Owner',
      cell: (lead) => lead.ownerName ?? <span className="nx-hint">unassigned</span>,
    },
    {
      key: 'next_action',
      header: 'Next action',
      cell: (lead) => (
        <div className="nx-stack nx-stack--sm">
          {/* The sales state and the next action travel together: the V1.2 column list does
              not name a status column, and dropping the state entirely would hide it. */}
          <LeadStatusChip state={lead.status} />
          <span className="nx-hint">
            {actionLabel(lead.nextActionType, null)}
            {lead.nextActionAt === null ? '' : ` · ${lead.nextActionAt.slice(0, 10)}`}
          </span>
        </div>
      ),
    },
    {
      key: 'latest_signal',
      header: 'Latest signal',
      cell: (lead) => {
        const intelligence = intelligenceById.get(lead.id) ?? EMPTY_INTELLIGENCE;
        if (intelligence.signalKind === null) {
          return <span className="nx-hint">no signal</span>;
        }
        return (
          <div className="nx-stack nx-stack--sm">
            <Chip
              accent={
                intelligence.signalPolarity === 'positive'
                  ? 'green'
                  : intelligence.signalPolarity === 'negative'
                    ? 'red'
                    : 'neutral'
              }
            >
              {intelligence.signalKind.replace(/_/g, ' ')}
            </Chip>
            {intelligence.signalLabel !== null && (
              <span className="nx-hint nx-clamp" title={intelligence.signalLabel}>
                {intelligence.signalLabel}
              </span>
            )}
            {intelligence.signalObservedAt !== null && (
              <span className="nx-hint nx-table__mono">{intelligence.signalObservedAt.slice(0, 10)}</span>
            )}
          </div>
        );
      },
    },
    {
      key: 'ai_context',
      header: 'AI context',
      cell: (lead) => {
        const intelligence = intelligenceById.get(lead.id) ?? EMPTY_INTELLIGENCE;
        if (intelligence.contextVersion === null) {
          return <Chip accent="amber">no context</Chip>;
        }
        /*
         * §68.2 — "whether an `ai_context_packs` version exists and whether it is current
         * with the facts". Currency is decided by comparing the pack's build time with the
         * two stored fact-change timestamps, because recomputing the pack's input hash here
         * would be a second implementation of the hash rule (§60.2). The basis is exposed in
         * the title so the operator can see the comparison rather than trust a colour.
         */
        const factTimes = [intelligence.lastProfileEnrichmentAt, intelligence.lastCompanyEnrichmentAt]
          .filter((value): value is string => value !== null)
          .sort();
        const newestFact = factTimes.length === 0 ? null : factTimes[factTimes.length - 1] ?? null;
        const current =
          newestFact === null ||
          intelligence.contextCreatedAt === null ||
          intelligence.contextCreatedAt >= newestFact;
        return (
          <div
            className="nx-stack nx-stack--sm"
            title={`pack built ${intelligence.contextCreatedAt ?? 'unknown'}; newest fact change ${newestFact ?? 'none recorded'}`}
          >
            <Chip accent={current ? 'green' : 'amber'}>pack v{String(intelligence.contextVersion)}</Chip>
            <span className="nx-hint">{current ? 'current' : 'facts changed since'}</span>
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: 'V1.2 actions',
      width: '132px',
      cell: (lead) => {
        const intelligence = intelligenceById.get(lead.id) ?? EMPTY_INTELLIGENCE;
        return (
          <Row wrap>
            <LeadRowIntelligenceActions
              businessSlug={business.key}
              businessId={business.id}
              leadId={lead.id}
              personName={lead.personName}
              facts={{
                fullName: lead.personName,
                companyName: lead.companyName,
                location: intelligence.location,
                companyDomain: intelligence.companyDomain,
                linkedinUrl: intelligence.linkedinUrl,
              }}
              canCreateJobs={canCreateJobs}
              jobTypes={V1_2_ROW_JOB_TYPES}
            />
            <LeadRowMenu
              businessSlug={business.key}
              leadId={lead.id}
              personName={lead.personName}
              canArchive={canWriteLeads}
              canDelete={canWriteLeads}
            />
          </Row>
        );
      },
    },
  ];

  return (
    <>
      <PageHead
        subtitle={`One active lead per person · ${business.name}`}
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/trash`}>
              Trash
            </a>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/lead-sources`}>
              Lead Sources
            </a>
            <a className="nx-btn nx-btn--primary" href={`${basePath}?add=1#add-lead`}>
              + Lead
            </a>
          </Row>
        }
      >
        Leads
      </PageHead>

      {/*
        §2 — a lead may be created with a name and nothing else. The form submits through the
        audited ingest pipeline, so the new lead starts in the enrichment pipeline with its
        own `lead_enrichment` row rather than looking complete.
      */}
      <AddLeadForm
        businessSlug={business.key}
        businessId={business.id}
        sourceOptions={discoverySourceOptions()}
        defaultSource="manual"
        canCreate={canCreateLeads}
        defaultOpen={flagged(query.add)}
      />

      <div style={{ height: 'var(--nx-space-md)' }} />

      {/* The frame puts the search field in the head, beside the title block. */}
      <form
        className="nx-inline-form"
        action={basePath}
        method="get"
        style={{ marginBottom: 'var(--nx-space-lg)' }}
      >
        {query.pageSize === undefined ? null : (
          <input type="hidden" name={PAGE_SIZE_PARAM} value={String(pageSize)} />
        )}
        <Field label="Search" htmlFor="leads-search">
          <input
            id="leads-search"
            className="nx-input"
            type="search"
            name="q"
            defaultValue={query.q ?? ''}
            placeholder="Search leads…"
            style={{ maxWidth: '320px' }}
          />
        </Field>
        <button className="nx-btn nx-btn--secondary" type="submit">
          Search
        </button>
        <span className="nx-hint">
          {String(total)} matching lead{total === 1 ? '' : 's'}
        </span>
      </form>

      <StatusChips counts={counts} basePath={basePath} query={query} />

      <div style={{ height: 'var(--nx-space-md)' }} />

      <LeadFilterBar
        action={basePath}
        query={query}
        current={{
          icp: query.icp ?? '',
          owner: query.owner ?? '',
          identity: query.identity ?? '',
          status: query.status ?? '',
          source: query.source ?? '',
          q: query.q ?? '',
          sort,
          view: query.view ?? '',
          ownerNone: flagged(query.ownerNone),
        }}
        icps={icps}
        owners={owners}
        identities={identities}
        savedViews={savedViews.map((view) => ({
          value: view.id,
          label: view.name,
          href: viewHref(basePath, view),
        }))}
        needsAttentionHref={filterHref(basePath, query, {
          clear: ['status', 'view', 'needsProfile', 'dnc', 'followups'],
          set: { needsAttention: '1' },
        })}
      />

      <div style={{ height: 'var(--nx-space-md)' }} />

      {/*
        The V1.2 filters §68.5 adds: enrichment status, channel and a completeness floor. They
        are a plain GET form so the result set stays in the URL — the same contract the rest of
        the filter model follows — and the page size survives a filter change.
      */}
      <IntelligenceFilters
        action={basePath}
        query={query}
        enrichmentStatus={enrichmentFilter ?? ''}
        channel={channelParam}
        minIntelligence={minIntelligence === null ? '' : String(minIntelligence)}
        accountChannels={accountChannels}
        pageSize={pageSize}
      />

      <div style={{ height: 'var(--nx-space-md)' }} />

      {/*
        The bulk form element belongs to the bar under the table; the table's checkboxes
        submit into it through their `form` attribute, so the two are one control group
        without a nested `<form>`.
      */}
      <Card>
        <DataTable
          columns={columns}
          rows={leads}
          rowKey={(lead) => lead.id}
          caption="Leads visible to you in this business, with their V1.2 intelligence state"
          empty={
            <EmptyState
              title="No leads match these filters"
              body="Adjust the filters, or add a lead — a name is enough to start."
              action={
                <a className="nx-btn nx-btn--primary" href="#add-lead">
                  Add a lead
                </a>
              }
            />
          }
        />

        <div className="nx-card__footer">
          <span className="nx-hint">
            {total === 0
              ? 'No matching leads'
              : `Showing ${String(
                  selection.ids.length === 0 ? 0 : (page - 1) * pageSize + 1,
                )}–${String((page - 1) * pageSize + leads.length)} of ${String(total)} · page ${String(
                  page,
                )} of ${String(totalPages)} · ${String(pageSize)} per page`}
          </span>
          {page > 1 && (
            <a
              className="nx-btn nx-btn--secondary nx-btn--sm"
              href={pageHref(basePath, query, page - 1)}
            >
              Previous
            </a>
          )}
          {page < totalPages && (
            <a
              className="nx-btn nx-btn--secondary nx-btn--sm"
              href={pageHref(basePath, query, page + 1)}
            >
              Next
            </a>
          )}
        </div>
      </Card>

      <div style={{ height: 'var(--nx-space-md)' }} />

      <LeadBulkBar
        businessSlug={business.key}
        formId={BULK_FORM_ID}
        owners={owners}
        icps={icps}
        identities={identities}
        canAssignOwner={context.permissions.has('lead.assign_owner')}
        canChangeIcp={context.permissions.has('lead.change_primary_icp')}
        canChangeSender={context.permissions.has('lead.change_sender_identity')}
        canArchive={context.permissions.has('lead.archive')}
        canDelete={context.permissions.has('lead.soft_delete')}
      />
    </>
  );
}

/**
 * The V1.2 job types a row action may create.
 *
 * A deliberate subset of `AGENT_JOB_TYPES`: the row offers the work an operator actually
 * asks for from a list, and `OTHER` is omitted because a job with no described work is not
 * something to create from one click. The full vocabulary stays available on Lead Detail.
 */
const V1_2_ROW_JOB_TYPES: readonly string[] = [
  'RESEARCH_COMPANY',
  'RESEARCH_PERSON',
  'RESEARCH_SIGNALS',
  'CAPTURE_PROFILE',
  'ENRICH_PROFILE',
  'QUALIFY_LEAD',
  'BUILD_CONTEXT',
  'DRAFT_OUTREACH',
];

/**
 * The V1.2 filter row.
 *
 * A server-rendered `<form method="get">` rather than a client control: the values that shape
 * the result set belong in the URL, and a plain form keeps them there without shipping script.
 */
function IntelligenceFilters({
  action,
  query,
  enrichmentStatus,
  channel,
  minIntelligence,
  accountChannels,
  pageSize,
}: {
  readonly action: string;
  readonly query: LeadsSearchParams;
  readonly enrichmentStatus: string;
  readonly channel: string;
  readonly minIntelligence: string;
  readonly accountChannels: readonly OutreachChannel[];
  readonly pageSize: number;
}): ReactNode {
  return (
    <form className="nx-card" action={action} method="get">
      <div className="nx-card__body">
        <div className="nx-filter-grid">
          {/* Every other filter is carried through so applying one does not clear the rest. */}
          {Object.entries(query).map(([key, value]) =>
            key === 'enrichment' ||
            key === 'channel' ||
            key === 'minIntelligence' ||
            key === 'page' ||
            typeof value !== 'string' ||
            value.length === 0 ? null : (
              <input key={key} type="hidden" name={key} value={value} />
            ),
          )}
          {query.pageSize === undefined ? (
            <input type="hidden" name={PAGE_SIZE_PARAM} value={String(pageSize)} />
          ) : null}

          <Field
            label="Enrichment status"
            htmlFor="filter-enrichment"
            hint="From public.lead_enrichment. A lead with no row reads as Minimal."
          >
            <select
              id="filter-enrichment"
              className="nx-select"
              name="enrichment"
              defaultValue={enrichmentStatus}
            >
              <option value="">All enrichment states</option>
              {/* §71.2's "Needs Enrichment" — every state except READY, as one bucket. */}
              <option value="NOT_READY">Needs enrichment (not Ready)</option>
              <option value="MINIMAL">Minimal</option>
              <option value="NEEDS_PROFILE">Needs profile</option>
              <option value="PROFILE_READY">Profile ready</option>
              <option value="COMPANY_RESEARCH_PENDING">Company research pending</option>
              <option value="AGENT_RESEARCH_PENDING">Agent research pending</option>
              <option value="AI_PROCESSING">AI processing</option>
              <option value="READY">Ready</option>
              <option value="NEEDS_REVIEW">Needs review</option>
              <option value="FAILED">Failed</option>
            </select>
          </Field>

          <Field
            label="Channel"
            htmlFor="filter-channel"
            hint={
              accountChannels.length === 0
                ? 'No channel account is configured for this business, so no channel can be offered.'
                : 'Requires both a channel account here and a contact point on the lead.'
            }
          >
            <select
              id="filter-channel"
              className="nx-select"
              name="channel"
              defaultValue={channel}
              disabled={accountChannels.length === 0}
            >
              <option value="">All channels</option>
              {accountChannels.map((channelOption) => (
                <option key={channelOption} value={channelOption}>
                  {outreachChannelLabel(channelOption)}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Intelligence at least"
            htmlFor="filter-min-intelligence"
            hint="The stored completeness score, 0–100."
          >
            <input
              id="filter-min-intelligence"
              className="nx-input"
              type="number"
              name="minIntelligence"
              min={0}
              max={100}
              defaultValue={minIntelligence}
              placeholder="0"
            />
          </Field>

          <div className="nx-inline-form">
            <button className="nx-btn nx-btn--secondary" type="submit">
              Apply
            </button>
            <a className="nx-btn nx-btn--ghost" href={action}>
              Clear V1.2 filters
            </a>
          </div>
        </div>
        <p className="nx-hint" style={{ marginTop: 'var(--nx-space-sm)' }}>
          Completeness is the stored weighted score with its missing components named — never a
          number computed on this screen.
        </p>
      </div>
    </form>
  );
}

/**
 * The quick-filter chip row.
 *
 * Each chip is a real link that sets exactly one filter key, so the count a chip shows
 * and the list it opens come from the same predicate in the repository. Every count is a
 * `getLeadCounts` aggregate over the database — never a literal.
 *
 * The chip definitions live in `@/lib/quick-filter-chips` rather than in this JSX, because the
 * filter value each chip applies is a correctness fact worth asserting in a unit test — see the
 * note in that module for the `status=1` defect it prevents.
 */
function StatusChips({
  counts,
  basePath,
  query,
}: {
  readonly counts: LeadCounts;
  readonly basePath: string;
  readonly query: LeadsSearchParams;
}): ReactNode {
  return (
    <div className="nx-chip-strip" role="group" aria-label="Quick filters">
      {QUICK_FILTER_CHIPS.map((definition) => {
        const count = counts[definition.countKey];
        const accent = definition.accent;
        return (
          <a
            key={definition.key}
            className={`nx-chip-link${accent.length === 0 ? '' : ` nx-chip-link--${accent}`}`}
            href={filterHref(basePath, query, { clear: QUICK_FILTER_KEYS, set: definition.set })}
            aria-current={chipIsActive(definition, query) ? 'true' : undefined}
            title={`${definition.label}: ${String(count)} lead${count === 1 ? '' : 's'}`}
          >
            {definition.label}
            <span className="nx-chip-link__count">{count}</span>
          </a>
        );
      })}
    </div>
  );
}
