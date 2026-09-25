/**
 * Businesses, domains and the access model that decides what a viewer may see.
 *
 * `listAccessibleBusinesses` is the single source for both the admin business
 * switcher and the Companion's business selector, so the two can never disagree
 * about which businesses exist for a viewer.
 */
import 'server-only';

import { withActor, type Actor, type Viewer } from '../actor';
import type { Db, Row } from '../sql';
import {
  asBoolean,
  asIso,
  asNumber,
  asString,
  asStringArray,
  asStringOrNull,
  describeDbError,
  normalizePaging,
  read,
  readOne,
  type ListParams,
  type Page,
} from './common';

export interface Business {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly focus: string | null;
  readonly regions: readonly string[];
  readonly status: 'active' | 'archived' | 'template';
  readonly isTemplate: boolean;
  readonly notes: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface BusinessSummary extends Business {
  /** Leads visible to the viewer, excluding soft-deleted rows. */
  readonly leadCount: number;
  readonly openTaskCount: number;
  readonly profileQueueCount: number;
  readonly domainCount: number;
}

export interface BusinessDomain {
  readonly id: string;
  readonly businessId: string;
  readonly domain: string;
  readonly normalizedDomain: string;
  readonly domainType: 'primary' | 'alias' | 'parent_source' | 'service';
  readonly isDefault: boolean;
  readonly notes: string | null;
}

/** spec `business_units.business_switcher` — "All Businesses (admin roll-up only)". */
export interface BusinessSwitcherOption {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly isRollUp: boolean;
}

export const ALL_BUSINESSES_ID = '__all__';

function mapBusiness(row: Row): Business {
  return {
    id: asString(row.id),
    key: asString(row.key),
    name: asString(row.name),
    focus: asStringOrNull(row.focus),
    regions: asStringArray(row.regions),
    status: asString(row.status, 'active') as Business['status'],
    isTemplate: asBoolean(row.is_template),
    notes: asStringOrNull(row.notes),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

/**
 * Businesses the viewer may see.
 *
 * RLS decides this: the query has no business filter of its own, so an admin sees
 * every business and a user sees exactly the ones granted to them. Adding a
 * client-side filter here would be redundant and, worse, could disagree with the
 * database.
 */
export async function listBusinesses(actor: Actor): Promise<readonly Business[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, key, name, focus, regions, status, is_template, notes, created_at, updated_at
         from public.businesses
        where deleted_at is null
        order by name`,
    );
    return result.rows.map(mapBusiness);
  });
}

export async function listBusinessSummaries(actor: Actor): Promise<readonly BusinessSummary[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select b.id, b.key, b.name, b.focus, b.regions, b.status, b.is_template, b.notes,
              b.created_at, b.updated_at,
              (select count(*) from public.leads l
                where l.business_id = b.id and l.deleted_at is null) as lead_count,
              (select count(*) from public.tasks t
                where t.business_id = b.id and t.status = 'open' and t.deleted_at is null) as open_task_count,
              (select count(*) from public.profile_capture_queue q
                where q.business_id = b.id and q.state in ('pending', 'in_progress')) as profile_queue_count,
              (select count(*) from public.business_domains d
                where d.business_id = b.id) as domain_count
         from public.businesses b
        where b.deleted_at is null
        order by b.name`,
    );

    return result.rows.map((row: Row) => ({
      ...mapBusiness(row),
      leadCount: asNumber(row.lead_count),
      openTaskCount: asNumber(row.open_task_count),
      profileQueueCount: asNumber(row.profile_queue_count),
      domainCount: asNumber(row.domain_count),
    }));
  });
}

export async function getBusinessBySlug(actor: Actor, slug: string): Promise<Business | null> {
  return readOne(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, key, name, focus, regions, status, is_template, notes, created_at, updated_at
         from public.businesses
        where key = $1 and deleted_at is null`,
      [slug],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapBusiness(row);
  });
}

export async function getBusinessById(actor: Actor, id: string): Promise<Business | null> {
  return readOne(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, key, name, focus, regions, status, is_template, notes, created_at, updated_at
         from public.businesses
        where id = $1 and deleted_at is null`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapBusiness(row);
  });
}

export interface BusinessInput {
  readonly key: string;
  readonly name: string;
  readonly focus?: string | null;
  readonly regions?: readonly string[];
  readonly notes?: string | null;
}

export interface MutationResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly error?: string;
}

export async function createBusiness(viewer: Viewer, input: BusinessInput): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `insert into public.businesses (key, name, focus, regions, notes, created_by)
         values ($1, $2, $3, $4::text[], $5, $6)
         returning id`,
        [
          input.key,
          input.name,
          input.focus ?? null,
          input.regions === undefined ? [] : [...input.regions],
          input.notes ?? null,
          viewer.userId,
        ],
      );
      const id = result.rows[0]?.id;
      return id === undefined ? { ok: false, error: 'The business was not created.' } : { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function updateBusiness(
  viewer: Viewer,
  id: string,
  input: Partial<BusinessInput> & { readonly status?: Business['status'] },
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `update public.businesses
            set name = coalesce($2, name),
                focus = coalesce($3, focus),
                regions = coalesce($4::text[], regions),
                notes = coalesce($5, notes),
                status = coalesce($6, status),
                updated_at = now()
          where id = $1 and deleted_at is null
          returning id`,
        [
          id,
          input.name ?? null,
          input.focus ?? null,
          input.regions === undefined ? null : [...input.regions],
          input.notes ?? null,
          input.status ?? null,
        ],
      );
      return result.rows[0] === undefined
        ? { ok: false, error: 'That business no longer exists.' }
        : { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/**
 * spec `business_units.clone_behavior`.
 *
 * A clone copies *configuration* only. It must never copy leads, people, company
 * history, conversations, replies, message history or agent runs — so this function
 * copies the ICP/sequence/knowledge skeletons and nothing else. Lists are declared
 * explicitly rather than looped over "all tables", so a future table cannot be
 * cloned by accident.
 */
export async function cloneBusiness(
  viewer: Viewer,
  sourceId: string,
  input: BusinessInput,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      // The insert itself is the authorization check: RLS permits it only for an
      // admin, so a non-admin gets a privilege error rather than a partial clone.
      const created = await sql.query<{ id: string }>(
        `insert into public.businesses (key, name, focus, regions, notes, created_by)
         values ($1, $2, $3, $4::text[], $5, $6)
         returning id`,
        [
          input.key,
          input.name,
          input.focus ?? null,
          input.regions === undefined ? [] : [...input.regions],
          input.notes ?? null,
          viewer.userId,
        ],
      );
      const newId = created.rows[0]?.id;
      if (newId === undefined) return { ok: false, error: 'The business was not created.' };

      // ICP structure, with a map from old to new so default sequences can follow.
      await sql.query(
        `insert into public.icps (business_id, name, description, criteria, is_default, is_active, scoring_overrides, routing)
         select $1, name, description, criteria, is_default, true, scoring_overrides, routing
           from public.icps where business_id = $2 and deleted_at is null`,
        [newId, sourceId],
      );

      // Sequences and their published steps.
      //
      // The steps used to be dropped: only the `sequences` row was copied, and a sequence whose
      // `current_version_id` is null has no steps, so every cloned sequence was an empty shell that
      // could never produce a message. The sequence is created `draft` deliberately — a clone has not
      // been reviewed for this business, and a `draft` sequence produces nothing until it is
      // published — but its version and steps are copied so that publishing it is one action rather
      // than a rewrite.
      const sequences = await sql.query<{ source_id: string; new_id: string }>(
        `with created as (
           insert into public.sequences (business_id, name, description, is_default, status, created_by)
           select $1, s.name, s.description, s.is_default, 'draft', $3
             from public.sequences s
            where s.business_id = $2 and s.deleted_at is null
           returning id, name
         )
         select s.id as source_id, c.id as new_id
           from created c
           join public.sequences s on s.business_id = $2 and s.name = c.name and s.deleted_at is null`,
        [newId, sourceId, viewer.userId],
      );

      for (const pair of sequences.rows) {
        const version = await sql.query<{ id: string }>(
          `insert into public.sequence_versions
             (sequence_id, version, status, published_at, change_summary, created_by)
           select $1, 1, 'published', now(), 'Cloned from ' || $3, $4
             from public.sequences s
            where s.id = $2 and s.current_version_id is not null
           returning id`,
          [pair.new_id, pair.source_id, input.name, viewer.userId],
        );
        const versionId = version.rows[0]?.id;
        if (versionId === undefined) continue;

        await sql.query(
          `insert into public.sequence_steps
             (sequence_version_id, step_order, kind, name, delay_days, delay_basis, goal,
              allowed_context, word_max, cta_style, prohibited_phrases, proof_policy, tone,
              generation_mode, is_active)
           select $1, st.step_order, st.kind, st.name, st.delay_days, st.delay_basis, st.goal,
                  st.allowed_context, st.word_max, st.cta_style, st.prohibited_phrases,
                  st.proof_policy, st.tone, st.generation_mode, st.is_active
             from public.sequence_steps st
             join public.sequences s on s.current_version_id = st.sequence_version_id
            where s.id = $2
            order by st.step_order`,
          [versionId, pair.source_id],
        );

        await sql.query(`update public.sequences set current_version_id = $2 where id = $1`, [
          pair.new_id,
          versionId,
        ]);
      }

      // Scoring rules that were configured globally for the source business.
      await sql.query(
        `insert into public.scoring_rules (target_type, target_id, signal_kind, polarity, points, label, is_active)
         select 'business', $1, signal_kind, polarity, points, label, is_active
           from public.scoring_rules
          where target_type = 'business' and target_id = $2`,
        [newId, sourceId],
      );

      await sql.query(
        `insert into public.audit_events (actor_type, actor_id, business_id, entity_type, entity_id, action, after_json, source_client)
         values ('user', $1, $2, 'businesses', $2, 'clone_business', $3, 'web')`,
        [viewer.userId, newId, JSON.stringify({ cloned_from: sourceId, key: input.key })],
      );

      return { ok: true, id: newId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/* --------------------------------------------------------------- domains -- */

export async function listDomains(actor: Actor, businessId: string): Promise<readonly BusinessDomain[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, business_id, domain, normalized_domain, domain_type, is_default, notes
         from public.business_domains
        where business_id = $1
        order by is_default desc, domain`,
      [businessId],
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      businessId: asString(row.business_id),
      domain: asString(row.domain),
      normalizedDomain: asString(row.normalized_domain),
      domainType: asString(row.domain_type, 'alias') as BusinessDomain['domainType'],
      isDefault: asBoolean(row.is_default),
      notes: asStringOrNull(row.notes),
    }));
  });
}

export interface DomainRow extends BusinessDomain {
  readonly businessName: string;
}

/** Every domain across the businesses the viewer can see (screen A30). */
export async function listAllDomains(actor: Actor): Promise<readonly DomainRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select d.id, d.business_id, d.domain, d.normalized_domain, d.domain_type, d.is_default, d.notes,
              b.name as business_name
         from public.business_domains d
         join public.businesses b on b.id = d.business_id
        where b.deleted_at is null
        order by b.name, d.is_default desc, d.domain`,
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      businessId: asString(row.business_id),
      businessName: asString(row.business_name),
      domain: asString(row.domain),
      normalizedDomain: asString(row.normalized_domain),
      domainType: asString(row.domain_type, 'alias') as BusinessDomain['domainType'],
      isDefault: asBoolean(row.is_default),
      notes: asStringOrNull(row.notes),
    }));
  });
}

export interface DomainInput {
  readonly businessId: string;
  readonly domain: string;
  readonly domainType: BusinessDomain['domainType'];
  readonly isDefault: boolean;
  readonly notes?: string | null;
}

function normalizeDomainInput(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

export async function createDomain(viewer: Viewer, input: DomainInput): Promise<MutationResult> {
  const normalized = normalizeDomainInput(input.domain);
  if (normalized.length === 0) return { ok: false, error: 'Enter a domain.' };

  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `insert into public.business_domains (business_id, domain, normalized_domain, domain_type, is_default, notes)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [
          input.businessId,
          input.domain.trim(),
          normalized,
          input.domainType,
          input.isDefault,
          input.notes ?? null,
        ],
      );
      const id = result.rows[0]?.id;
      return id === undefined ? { ok: false, error: 'The domain was not added.' } : { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function deleteDomain(viewer: Viewer, id: string): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(`delete from public.business_domains where id = $1`, [id]);
      return result.affectedRows === 0
        ? { ok: false, error: 'That domain no longer exists.' }
        : { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/* ------------------------------------------------------- access & grants -- */

export interface UserBusinessGrantRow {
  readonly businessId: string;
  readonly businessName: string;
  readonly accessLevel: 'admin' | 'manager' | 'user';
  readonly canManageLeads: boolean;
  readonly canUseLeadSources: boolean;
  readonly canUseProfileQueue: boolean;
  readonly canDeleteLeads: boolean;
  readonly leadScope: 'all' | 'assigned' | 'own' | null;
}

export async function listUserGrants(actor: Actor, userId: string): Promise<readonly UserBusinessGrantRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select a.business_id, b.name as business_name, a.access_level,
              a.can_manage_leads, a.can_use_lead_sources, a.can_use_profile_queue, a.can_delete_leads,
              s.mode as lead_scope
         from public.user_business_access a
         join public.businesses b on b.id = a.business_id
         left join public.user_lead_scope s on s.user_id = a.user_id and s.business_id = a.business_id
        where a.user_id = $1
        order by b.name`,
      [userId],
    );
    return result.rows.map((row: Row) => ({
      businessId: asString(row.business_id),
      businessName: asString(row.business_name),
      accessLevel: asString(row.access_level, 'user') as 'admin' | 'manager' | 'user',
      canManageLeads: asBoolean(row.can_manage_leads),
      canUseLeadSources: asBoolean(row.can_use_lead_sources),
      canUseProfileQueue: asBoolean(row.can_use_profile_queue),
      canDeleteLeads: asBoolean(row.can_delete_leads),
      leadScope: asStringOrNull(row.lead_scope) as UserBusinessGrantRow['leadScope'],
    }));
  });
}

export interface GrantInput {
  readonly userId: string;
  readonly businessId: string;
  readonly accessLevel: 'admin' | 'manager' | 'user';
  readonly canManageLeads: boolean;
  readonly canUseLeadSources: boolean;
  readonly canUseProfileQueue: boolean;
  readonly canDeleteLeads: boolean;
}

/**
 * Grants (or updates) a user's access to one business. Admin-only, enforced by RLS
 * on `user_business_access`.
 */
export async function upsertUserGrant(viewer: Viewer, input: GrantInput): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ business_id: string }>(
        `insert into public.user_business_access
           (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources, can_use_profile_queue, can_delete_leads, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (user_id, business_id) do update
           set access_level = excluded.access_level,
               can_manage_leads = excluded.can_manage_leads,
               can_use_lead_sources = excluded.can_use_lead_sources,
               can_use_profile_queue = excluded.can_use_profile_queue,
               can_delete_leads = excluded.can_delete_leads
         returning business_id`,
        [
          input.userId,
          input.businessId,
          input.accessLevel,
          input.canManageLeads,
          input.canUseLeadSources,
          input.canUseProfileQueue,
          input.canDeleteLeads,
          viewer.userId,
        ],
      );
      return result.rows[0] === undefined
        ? { ok: false, error: 'The access grant was not saved.' }
        : { ok: true, id: result.rows[0].business_id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function revokeUserGrant(
  viewer: Viewer,
  userId: string,
  businessId: string,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `delete from public.user_business_access where user_id = $1 and business_id = $2`,
        [userId, businessId],
      );
      return result.affectedRows === 0
        ? { ok: false, error: 'That grant no longer exists.' }
        : { ok: true };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/** Business switcher options, honouring the admin-only "All Businesses" roll-up. */
export function switcherOptions(
  businesses: readonly Business[],
  role: Viewer['role'],
): readonly BusinessSwitcherOption[] {
  const options = businesses.map((business) => ({
    id: business.id,
    slug: business.key,
    name: business.name,
    isRollUp: false,
  }));

  if (role !== 'admin') return options;

  return [
    { id: ALL_BUSINESSES_ID, slug: ALL_BUSINESSES_ID, name: 'All Businesses', isRollUp: true },
    ...options,
  ];
}

/* ------------------------------------------------------------- settings -- */

export interface PlatformSetting {
  readonly key: string;
  readonly value: unknown;
  readonly businessId: string | null;
}

export async function listPlatformSettings(actor: Actor, businessId?: string): Promise<readonly PlatformSetting[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select key, value, business_id
         from public.platform_settings
        where business_id is not distinct from $1
        order by key`,
      [businessId ?? null],
    );
    return result.rows.map((row: Row) => ({
      key: asString(row.key),
      value: row.value,
      businessId: asStringOrNull(row.business_id),
    }));
  });
}

/**
 * Saves a platform setting, global (`businessId` omitted) or business-scoped.
 *
 * Deliberately an UPDATE-then-INSERT rather than `on conflict`.
 *
 * The table carries two constraints that `on conflict (business_id, key)` cannot
 * satisfy for a global row:
 *
 *   unique (business_id, key)                 -- NULLS DISTINCT by default
 *   unique (key) where business_id is null    -- the partial index that actually
 *                                                enforces "one global row per key"
 *
 * Because the first constraint treats NULL as distinct, an existing global row is
 * never a conflict target for it, so the insert proceeds and then violates the
 * partial index — every second save of a global setting would fail. Updating first
 * with `is not distinct from` (which *does* match NULL) is correct for both scopes,
 * and the partial index still protects against a concurrent double insert.
 */
export async function upsertPlatformSetting(
  viewer: Viewer,
  key: string,
  value: unknown,
  businessId?: string,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const target = businessId ?? null;

      const updated = await sql.query(
        `update public.platform_settings
            set value = $3::jsonb, updated_by = $4, updated_at = now()
          where key = $2 and business_id is not distinct from $1`,
        [target, key, JSON.stringify(value), viewer.userId],
      );

      if (updated.affectedRows === 0) {
        await sql.query(
          `insert into public.platform_settings (business_id, key, value, updated_by, updated_at)
           values ($1, $2, $3::jsonb, $4, now())`,
          [target, key, JSON.stringify(value), viewer.userId],
        );
      }

      return { ok: true };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/** Paged business list, used by the admin hub table. */
export async function pageBusinesses(
  actor: Actor,
  params: ListParams = {},
): Promise<Page<BusinessSummary>> {
  const { limit, offset } = normalizePaging(params);
  const all = await listBusinessSummaries(actor);
  return { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
}

export type { Db };
