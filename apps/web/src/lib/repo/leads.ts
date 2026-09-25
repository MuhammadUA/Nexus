/**
 * Leads, lead detail, notes, tasks, replies and the soft-delete lifecycle.
 *
 * All reads and writes run through `withActor`, so the row-level policies decide
 * which leads a viewer can see. Nothing here filters by owner in application code:
 * the lead-scope rules (`all` / `assigned` / `own`) are expressed in RLS, which
 * means a screen cannot widen its own visibility by forgetting a WHERE clause.
 */
import 'server-only';

import { withActor, type Actor, type Viewer } from '../actor';
import type { Db, Row } from '../sql';
import {
  asBoolean,
  asIso,
  asNumber,
  asNumberOrNull,
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

/* ------------------------------------------------------------------ types -- */

export interface LeadListItem {
  readonly id: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly personId: string;
  readonly personName: string;
  readonly jobTitle: string | null;
  readonly companyId: string | null;
  readonly companyName: string | null;
  readonly primaryIcpId: string | null;
  readonly primaryIcpName: string | null;
  readonly ownerUserId: string | null;
  readonly ownerName: string | null;
  readonly outreachIdentityId: string | null;
  readonly identityName: string | null;
  readonly status: string;
  readonly sourceType: string | null;
  readonly sourceUrl: string | null;
  readonly nextActionType: string | null;
  readonly nextActionAt: string | null;
  readonly lastActivityAt: string | null;
  readonly needsProfile: boolean;
  readonly isDnc: boolean;
  readonly deletedAt: string | null;
  readonly createdAt: string | null;
}

export interface LeadFilter {
  readonly businessId?: string;
  readonly icpId?: string;
  readonly identityId?: string;
  readonly status?: string;
  readonly sourceType?: string;
  readonly ownerUserId?: string;
  /** Free text over person name, company name and LinkedIn URL. */
  readonly search?: string;
  /** Includes soft-deleted rows (Trash). Requires the trash permission. */
  readonly includeDeleted?: boolean;
  readonly needsProfileOnly?: boolean;
  readonly sort?: LeadSort;
}

export type LeadSort = 'recent_activity' | 'name' | 'company' | 'next_action' | 'created';

export interface LeadCounts {
  readonly total: number;
  readonly needsProfile: number;
  readonly replied: number;
  readonly dormant: number;
  readonly dnc: number;
  readonly deleted: number;
}

export interface LeadDetail extends LeadListItem {
  readonly linkedinUrl: string | null;
  readonly normalizedLinkedinUrl: string | null;
  readonly headline: string | null;
  readonly location: string | null;
  readonly companyDomain: string | null;
  readonly companyIndustry: string | null;
  readonly archivedAt: string | null;
  readonly icpMatches: readonly LeadIcpMatch[];
  readonly contacts: readonly LeadContact[];
}

export interface LeadIcpMatch {
  readonly icpId: string;
  readonly icpName: string;
  readonly isPrimary: boolean;
  readonly matchScore: number | null;
  readonly reason: string | null;
}

export interface LeadContact {
  readonly channel: string;
  readonly state: 'allowed' | 'suppressed';
  readonly reason: string | null;
  readonly createdAt: string | null;
}

export interface TimelineEntry {
  readonly id: string;
  readonly kind: 'outbound' | 'inbound' | 'note' | 'task' | 'connection' | 'state' | 'system';
  readonly at: string;
  readonly actorName: string | null;
  readonly identityName: string | null;
  readonly summary: string | null;
  /** Exact stored content — never re-worded, never summarised. */
  readonly body: string | null;
  readonly outcome: string | null;
  readonly immutable: boolean;
}

/* ------------------------------------------------------------------ reads -- */

const LEAD_SELECT = `
  select l.id, l.business_id, l.person_id, l.company_id, l.primary_icp_id,
         l.owner_user_id, l.outreach_identity_id, l.status, l.source_type, l.source_url,
         l.next_action_type, l.next_action_at, l.last_activity_at,
         l.needs_profile, l.is_dnc, l.deleted_at, l.archived_at, l.created_at,
         p.full_name as person_name, p.job_title, p.headline, p.location,
         p.linkedin_url, p.normalized_linkedin_url,
         c.name as company_name, c.normalized_domain as company_domain, c.industry as company_industry,
         b.name as business_name,
         i.name as primary_icp_name,
         u.full_name as owner_name,
         oi.display_name as identity_name
    from public.leads l
    join public.people p on p.id = l.person_id
    left join public.companies c on c.id = l.company_id
    join public.businesses b on b.id = l.business_id
    left join public.icps i on i.id = l.primary_icp_id
    left join public.users u on u.id = l.owner_user_id
    left join public.outreach_identities oi on oi.id = l.outreach_identity_id`;

function mapLead(row: Row): LeadListItem {
  return {
    id: asString(row.id),
    businessId: asString(row.business_id),
    businessName: asString(row.business_name),
    personId: asString(row.person_id),
    personName: asString(row.person_name),
    jobTitle: asStringOrNull(row.job_title),
    companyId: asStringOrNull(row.company_id),
    companyName: asStringOrNull(row.company_name),
    primaryIcpId: asStringOrNull(row.primary_icp_id),
    primaryIcpName: asStringOrNull(row.primary_icp_name),
    ownerUserId: asStringOrNull(row.owner_user_id),
    ownerName: asStringOrNull(row.owner_name),
    outreachIdentityId: asStringOrNull(row.outreach_identity_id),
    identityName: asStringOrNull(row.identity_name),
    status: asString(row.status, 'new'),
    sourceType: asStringOrNull(row.source_type),
    sourceUrl: asStringOrNull(row.source_url),
    nextActionType: asStringOrNull(row.next_action_type),
    nextActionAt: asIso(row.next_action_at),
    lastActivityAt: asIso(row.last_activity_at),
    needsProfile: asBoolean(row.needs_profile),
    isDnc: asBoolean(row.is_dnc),
    deletedAt: asIso(row.deleted_at),
    createdAt: asIso(row.created_at),
  };
}

/**
 * Builds the WHERE clause and its parameters.
 *
 * Every predicate is an equality or an ILIKE against a bound parameter, so no
 * caller-supplied text is ever interpolated into SQL.
 */
function leadWhere(filter: LeadFilter): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.includeDeleted !== true) conditions.push('l.deleted_at is null');
  if (filter.businessId !== undefined) {
    params.push(filter.businessId);
    conditions.push(`l.business_id = $${String(params.length)}`);
  }
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
  if (filter.sourceType !== undefined) {
    params.push(filter.sourceType);
    conditions.push(`l.source_type = $${String(params.length)}`);
  }
  if (filter.ownerUserId !== undefined) {
    params.push(filter.ownerUserId);
    conditions.push(`l.owner_user_id = $${String(params.length)}`);
  }
  if (filter.needsProfileOnly === true) conditions.push('l.needs_profile = true');

  if (filter.search !== undefined && filter.search.trim().length > 0) {
    params.push(`%${filter.search.trim()}%`);
    const index = `$${String(params.length)}`;
    conditions.push(
      `(p.full_name ilike ${index} or coalesce(c.name, '') ilike ${index} or coalesce(p.linkedin_url, '') ilike ${index})`,
    );
  }

  return {
    clause: conditions.length === 0 ? '' : `where ${conditions.join(' and ')}`,
    params,
  };
}

function leadOrderBy(sort: LeadSort | undefined): string {
  switch (sort) {
    case 'name':
      return 'order by p.full_name';
    case 'company':
      return 'order by c.name nulls last, p.full_name';
    case 'next_action':
      // Nulls last so leads with no scheduled action do not crowd the top.
      return 'order by l.next_action_at asc nulls last';
    case 'created':
      return 'order by l.created_at desc';
    case 'recent_activity':
    default:
      return 'order by l.last_activity_at desc nulls last, l.created_at desc';
  }
}

export async function listLeads(
  actor: Actor,
  filter: LeadFilter = {},
  params: ListParams = {},
): Promise<Page<LeadListItem>> {
  const { limit, offset } = normalizePaging(params);
  const where = leadWhere(filter);

  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `${LEAD_SELECT}
       ${where.clause}
       ${leadOrderBy(filter.sort)}
       limit $${String(where.params.length + 1)} offset $${String(where.params.length + 2)}`,
      [...where.params, limit, offset],
    );

    const counted = await sql.query<{ n: number }>(
      `select count(*)::int as n
         from public.leads l
         join public.people p on p.id = l.person_id
         left join public.companies c on c.id = l.company_id
        ${where.clause}`,
      where.params,
    );

    return {
      items: result.rows.map(mapLead),
      total: asNumber(counted.rows[0]?.n),
      limit,
      offset,
    };
  });
}

export async function getLeadCounts(actor: Actor, businessId?: string): Promise<LeadCounts> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select
         count(*) filter (where l.deleted_at is null) as total,
         count(*) filter (where l.deleted_at is null and l.needs_profile) as needs_profile,
         count(*) filter (where l.deleted_at is null and l.status = 'replied') as replied,
         count(*) filter (where l.deleted_at is null and l.status = 'dormant') as dormant,
         count(*) filter (where l.deleted_at is null and l.is_dnc) as dnc,
         count(*) filter (where l.deleted_at is not null) as deleted
       from public.leads l
       where ($1::uuid is null or l.business_id = $1)`,
      [businessId ?? null],
    );
    const row = result.rows[0];
    return {
      total: asNumber(row?.total),
      needsProfile: asNumber(row?.needs_profile),
      replied: asNumber(row?.replied),
      dormant: asNumber(row?.dormant),
      dnc: asNumber(row?.dnc),
      deleted: asNumber(row?.deleted),
    };
  });
}

export async function getLead(actor: Actor, leadId: string): Promise<LeadDetail | null> {
  return readOne(actor, async (sql) => {
    const result = await sql.query<Row>(`${LEAD_SELECT} where l.id = $1`, [leadId]);
    const row = result.rows[0];
    if (row === undefined) return null;

    const matches = await sql.query<Row>(
      `select m.icp_id, i.name as icp_name, m.is_primary, m.match_score, m.reason
         from public.lead_icp_matches m
         join public.icps i on i.id = m.icp_id
        where m.lead_id = $1
        order by m.is_primary desc, i.name`,
      [leadId],
    );

    // Suppressions are person+channel and global by design, so this is the list
    // that proves DNC follows the person across every sender identity.
    const contacts = await sql.query<Row>(
      `select channel, reason, created_at
         from public.contact_suppressions
        where person_id = $1 and active
        order by created_at desc`,
      [asString(row.person_id)],
    );

    return {
      ...mapLead(row),
      linkedinUrl: asStringOrNull(row.linkedin_url),
      normalizedLinkedinUrl: asStringOrNull(row.normalized_linkedin_url),
      headline: asStringOrNull(row.headline),
      location: asStringOrNull(row.location),
      companyDomain: asStringOrNull(row.company_domain),
      companyIndustry: asStringOrNull(row.company_industry),
      archivedAt: asIso(row.archived_at),
      icpMatches: matches.rows.map((match: Row) => ({
        icpId: asString(match.icp_id),
        icpName: asString(match.icp_name),
        isPrimary: asBoolean(match.is_primary),
        matchScore: asNumberOrNull(match.match_score),
        reason: asStringOrNull(match.reason),
      })),
      contacts: contacts.rows.map((contact: Row) => ({
        channel: asString(contact.channel),
        state: 'suppressed' as const,
        reason: asStringOrNull(contact.reason),
        createdAt: asIso(contact.created_at),
      })),
    };
  });
}

/**
 * The lead timeline.
 *
 * spec `reply_and_notes.history_rule`: outbound messages, inbound replies, internal
 * notes, tasks, connection events, sequence state changes and the sender identity
 * must all be distinguishable. Each source is mapped to an explicit `kind` rather
 * than being merged into an untyped blob.
 */
export async function getLeadTimeline(
  actor: Actor,
  leadId: string,
  limit = 100,
): Promise<readonly TimelineEntry[]> {
  const capped = Math.min(Math.max(limit, 1), 500);

  return read(actor, async (sql) => {
    const entries: TimelineEntry[] = [];

    const interactions = await sql.query<Row>(
      `select i.id, i.type, i.direction, i.summary, i.occurred_at, i.payload,
              u.full_name as actor_name, oi.display_name as identity_name
         from public.interactions i
         left join public.users u on u.id = i.actor_user_id
         left join public.outreach_identities oi on oi.id = i.outreach_identity_id
        where i.lead_id = $1
        order by i.occurred_at desc
        limit $2`,
      [leadId, capped],
    );
    for (const row of interactions.rows) {
      const type = asString(row.type);
      // spec `reply_and_notes.history_rule`: the timeline has to distinguish an inbound reply
      // from everything else, and a reply shown only as a truncated summary is not the reply.
      // The verbatim text is kept on the interaction payload, so it is read back out here and
      // rendered as the entry body.
      const payload = (row.payload ?? {}) as { body?: unknown };
      const verbatim = typeof payload.body === 'string' ? payload.body : null;
      entries.push({
        id: `interaction:${asString(row.id)}`,
        kind: type === 'connection_event' ? 'connection' : asString(row.direction) === 'inbound' ? 'inbound' : 'outbound',
        at: asIso(row.occurred_at) ?? '',
        actorName: asStringOrNull(row.actor_name),
        identityName: asStringOrNull(row.identity_name),
        summary: asStringOrNull(row.summary),
        body: verbatim,
        outcome: null,
        immutable: false,
      });
    }

    // Sent message versions are immutable history; only SENT instances appear here.
    const messages = await sql.query<Row>(
      `select m.id, m.sent_at, mv.content, mv.version_no, oi.display_name as identity_name,
              u.full_name as actor_name, e.event_type
         from public.message_instances m
         join public.message_versions mv on mv.id = m.current_version_id
         left join public.outreach_identities oi on oi.id = (
           select me.outreach_identity_id from public.message_events me
            where me.message_instance_id = m.id and me.outreach_identity_id is not null
            order by me.created_at desc limit 1)
         left join public.users u on u.id = mv.created_by
         left join lateral (
           select me.event_type from public.message_events me
            where me.message_instance_id = m.id
            order by me.created_at desc limit 1) e on true
        where m.lead_id = $1 and m.state = 'SENT'
        order by m.sent_at desc nulls last
        limit $2`,
      [leadId, capped],
    );
    for (const row of messages.rows) {
      entries.push({
        id: `message:${asString(row.id)}`,
        kind: 'outbound',
        at: asIso(row.sent_at) ?? '',
        actorName: asStringOrNull(row.actor_name),
        identityName: asStringOrNull(row.identity_name),
        summary: `Message sent (version ${String(asNumber(row.version_no, 1))})`,
        body: asStringOrNull(row.content),
        outcome: null,
        // spec `sequence_engine.message_states`: SENT is immutable history.
        immutable: true,
      });
    }

    const replies = await sql.query<Row>(
      `select o.id, o.outcome, o.reason, o.created_at, u.full_name as actor_name
         from public.conversation_outcomes o
         left join public.users u on u.id = o.actor_user_id
        where o.lead_id = $1
        order by o.created_at desc
        limit $2`,
      [leadId, capped],
    );
    for (const row of replies.rows) {
      entries.push({
        id: `outcome:${asString(row.id)}`,
        kind: 'inbound',
        at: asIso(row.created_at) ?? '',
        actorName: asStringOrNull(row.actor_name),
        identityName: null,
        summary: 'Reply recorded',
        // The exact inbound text is stored on the interaction payload and is never
        // re-worded; `reason` carries the operator's own note.
        body: asStringOrNull(row.reason),
        outcome: asStringOrNull(row.outcome),
        immutable: true,
      });
    }

    const notes = await sql.query<Row>(
      `select n.id, n.body, n.created_at, u.full_name as author_name
         from public.notes n
         left join public.users u on u.id = n.author_user_id
        where n.lead_id = $1 and n.deleted_at is null
        order by n.created_at desc
        limit $2`,
      [leadId, capped],
    );
    for (const row of notes.rows) {
      entries.push({
        id: `note:${asString(row.id)}`,
        kind: 'note',
        at: asIso(row.created_at) ?? '',
        actorName: asStringOrNull(row.author_name),
        identityName: null,
        summary: 'Internal note',
        body: asStringOrNull(row.body),
        outcome: null,
        immutable: false,
      });
    }

    const tasks = await sql.query<Row>(
      `select t.id, t.title, t.status, t.due_at, t.created_at, u.full_name as owner_name
         from public.tasks t
         left join public.users u on u.id = t.owner_user_id
        where t.lead_id = $1 and t.deleted_at is null
        order by t.created_at desc
        limit $2`,
      [leadId, capped],
    );
    for (const row of tasks.rows) {
      entries.push({
        id: `task:${asString(row.id)}`,
        kind: 'task',
        at: asIso(row.due_at) ?? asIso(row.created_at) ?? '',
        actorName: asStringOrNull(row.owner_name),
        identityName: null,
        summary: `Task ${asString(row.status, 'open')}: ${asString(row.title)}`,
        body: null,
        outcome: null,
        immutable: false,
      });
    }

    const audits = await sql.query<Row>(
      `select a.id, a.action, a.created_at, a.actor_type
         from public.audit_events a
        where a.entity_type = 'leads' and a.entity_id = $1
        order by a.created_at desc
        limit $2`,
      [leadId, capped],
    );
    for (const row of audits.rows) {
      entries.push({
        id: `audit:${asString(row.id)}`,
        kind: 'state',
        at: asIso(row.created_at) ?? '',
        actorName: null,
        identityName: null,
        summary: `Lead ${asString(row.action)} by ${asString(row.actor_type, 'system')}`,
        body: null,
        outcome: null,
        immutable: true,
      });
    }

    return entries
      .filter((entry) => entry.at.length > 0)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, capped);
  });
}

/* ----------------------------------------------------------------- writes -- */

export interface MutationResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly error?: string;
}

async function attempt(
  viewer: Viewer,
  fn: (sql: Db) => Promise<string | undefined>,
): Promise<MutationResult> {
  try {
    const id = await withActor(viewer.actor, fn);
    return id === undefined ? { ok: true } : { ok: true, id };
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function addNote(viewer: Viewer, leadId: string, body: string): Promise<MutationResult> {
  if (body.trim().length === 0) return { ok: false, error: 'Write a note first.' };
  return attempt(viewer, async (sql) => {
    const result = await sql.query<{ id: string }>(
      `insert into public.notes (business_id, lead_id, person_id, author_user_id, body, is_internal)
       select l.business_id, l.id, l.person_id, $2, $3, true
         from public.leads l where l.id = $1
       returning id`,
      [leadId, viewer.userId, body],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('The lead could not be found.');
    return id;
  });
}

export interface TaskInput {
  readonly leadId: string;
  readonly title: string;
  readonly type: string;
  readonly dueAt: string | null;
  readonly priority: string;
  readonly reminderAt?: string | null;
  readonly note?: string | null;
}

export async function createTask(viewer: Viewer, input: TaskInput): Promise<MutationResult> {
  if (input.title.trim().length === 0) return { ok: false, error: 'Give the task a title.' };
  return attempt(viewer, async (sql) => {
    const result = await sql.query<{ id: string }>(
      `insert into public.tasks (lead_id, business_id, owner_user_id, type, title, due_at, priority, reminder_at, status, note, source, created_by)
       select l.id, l.business_id, coalesce(l.owner_user_id, $2), $3, $4, $5, $6, $7, 'open', $8, 'user', $2
         from public.leads l where l.id = $1
       returning id`,
      [
        input.leadId,
        viewer.userId,
        input.type,
        input.title.trim(),
        input.dueAt,
        input.priority,
        input.reminderAt ?? null,
        input.note ?? null,
      ],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('The lead could not be found.');
    return id;
  });
}

export async function completeTask(viewer: Viewer, taskId: string): Promise<MutationResult> {
  return attempt(viewer, async (sql) => {
    const result = await sql.query(
      `update public.tasks
          set status = 'done', completed_at = now(), updated_at = now()
        where id = $1 and status <> 'done'`,
      [taskId],
    );
    if (result.affectedRows === 0) throw new Error('That task is already done or no longer exists.');
    return taskId;
  });
}

/**
 * spec `lead_sources.duplicate_review` and `lead_lifecycle.reply`.
 *
 * The exact inbound text is stored verbatim on the interaction payload and passed
 * to `capture_reply`, which records the outcome, pauses the sequence and creates the
 * DNC suppression when the outcome calls for it.
 */
export interface ReplyInput {
  readonly leadId: string;
  readonly exactText: string;
  readonly outcome: string;
  readonly note?: string | null;
  readonly sourceClient?: string;
}

export async function captureReply(viewer: Viewer, input: ReplyInput): Promise<MutationResult> {
  if (input.exactText.trim().length === 0) {
    return { ok: false, error: 'Paste the exact reply before saving.' };
  }
  return attempt(viewer, async (sql) => {
    const result = await sql.query<{ result: { outcome_recorded?: boolean } }>(
      `select public.capture_reply($1, $2, $3, $4, $5, now()) as result`,
      [
        input.leadId,
        input.exactText,
        input.outcome,
        input.note ?? null,
        input.sourceClient ?? 'web',
      ],
    );
    return result.rows[0] === undefined ? undefined : input.leadId;
  });
}

/** spec `companion_extension.connection_action` — with or without a note. */
export async function markConnectionSent(
  viewer: Viewer,
  leadId: string,
  identityId: string,
  withNote: boolean,
): Promise<MutationResult> {
  return attempt(viewer, async (sql) => {
    await sql.query(`select public.mark_connection_sent($1, $2, $3, $4)`, [
      leadId,
      identityId,
      withNote ? 'with_note' : 'without_note',
      'web',
    ]);
    return leadId;
  });
}

export async function markMessageSent(
  viewer: Viewer,
  messageInstanceId: string,
  identityId: string,
): Promise<MutationResult> {
  return attempt(viewer, async (sql) => {
    await sql.query(`select public.mark_message_sent($1, $2, $3)`, [
      messageInstanceId,
      identityId,
      'web',
    ]);
    return messageInstanceId;
  });
}

export async function softDeleteLead(viewer: Viewer, leadId: string): Promise<MutationResult> {
  return attempt(viewer, async (sql) => {
    await sql.query(`select public.soft_delete_lead($1, $2)`, [leadId, viewer.userId]);
    return leadId;
  });
}

export async function restoreLead(viewer: Viewer, leadId: string): Promise<MutationResult> {
  return attempt(viewer, async (sql) => {
    await sql.query(`select public.restore_lead($1, $2)`, [leadId, viewer.userId]);
    return leadId;
  });
}

/**
 * spec `roles_and_permissions.user.cannot`: "Permanently delete records".
 *
 * The literal confirmation string is required by the database function as well, so
 * a UI that skipped this check still could not delete permanently.
 */
export async function permanentDeleteLead(
  viewer: Viewer,
  leadId: string,
  confirmation: string,
): Promise<MutationResult> {
  return attempt(viewer, async (sql) => {
    await sql.query(`select public.permanent_delete_lead($1, $2, $3)`, [
      leadId,
      viewer.userId,
      confirmation,
    ]);
    return leadId;
  });
}

export interface LeadEditInput {
  readonly primaryIcpId?: string | null;
  readonly ownerUserId?: string | null;
  readonly outreachIdentityId?: string | null;
  readonly status?: string | null;
}

export async function updateLead(
  viewer: Viewer,
  leadId: string,
  input: LeadEditInput,
): Promise<MutationResult> {
  return attempt(viewer, async (sql) => {
    // Changing the Primary ICP goes through the audited RPC rather than a direct
    // column write, so the `lead_icp_matches` invariant stays satisfied.
    if (input.primaryIcpId !== undefined && input.primaryIcpId !== null) {
      await sql.query(`select public.set_primary_icp($1, $2)`, [leadId, input.primaryIcpId]);
    }

    if (
      input.ownerUserId !== undefined ||
      input.outreachIdentityId !== undefined ||
      input.status !== undefined
    ) {
      const result = await sql.query(
        `update public.leads
            set owner_user_id = coalesce($2, owner_user_id),
                outreach_identity_id = coalesce($3, outreach_identity_id),
                status = coalesce($4, status),
                last_activity_at = now()
          where id = $1`,
        [leadId, input.ownerUserId ?? null, input.outreachIdentityId ?? null, input.status ?? null],
      );
      if (result.affectedRows === 0) throw new Error('That lead no longer exists.');
    }
    return leadId;
  });
}

export interface SnoozeInput {
  readonly leadId: string;
  readonly until: string;
  readonly reason?: string | null;
}

/**
 * spec `tasks_and_my_day.today_engine_inputs` — "Snooze/reschedule".
 *
 * Moves the lead's next action and any pending message instance together, so a
 * snoozed lead does not immediately reappear from the message queue.
 */
export async function snoozeLead(viewer: Viewer, input: SnoozeInput): Promise<MutationResult> {
  return attempt(viewer, async (sql) => {
    await sql.query(
      `update public.leads
          set next_action_at = $2, last_activity_at = now()
        where id = $1`,
      [input.leadId, input.until],
    );
    await sql.query(
      `update public.message_instances
          set snoozed_until = $2, due_at = $2, updated_at = now()
        where lead_id = $1 and state in ('DYNAMIC', 'LOCKED') and sent_at is null`,
      [input.leadId, input.until],
    );
    await sql.query(
      `update public.tasks
          set snoozed_until = $2, due_at = $2, status = 'snoozed', updated_at = now()
        where lead_id = $1 and status = 'open'`,
      [input.leadId, input.until],
    );
    await sql.query(
      `insert into public.interactions (business_id, lead_id, person_id, type, actor_user_id, direction, summary, source_client, occurred_at)
       select l.business_id, l.id, l.person_id, 'snooze', $2, 'internal', $3, 'web', now()
         from public.leads l where l.id = $1`,
      [input.leadId, viewer.userId, `Snoozed until ${input.until}${input.reason ? `: ${input.reason}` : ''}`],
    );
    return input.leadId;
  });
}

/** Starts a dormancy review early, for the Reactivation screens. */
export async function startReactivation(viewer: Viewer, leadId: string): Promise<MutationResult> {
  return attempt(viewer, async (sql) => {
    const result = await sql.query(
      `update public.sequence_enrollments
          set state = 'reactivation_due', updated_at = now()
        where lead_id = $1 and state in ('dormant', 'completed')`,
      [leadId],
    );
    if (result.affectedRows === 0) {
      throw new Error('This lead is not dormant, so there is nothing to reactivate.');
    }
    await sql.query(
      `update public.leads
          set status = 'reactivation_due', next_action_type = 'reactivation',
              next_action_at = now(), last_activity_at = now()
        where id = $1`,
      [leadId],
    );
    return leadId;
  });
}

/** People matching a free-text search within the viewer's visible businesses. */
export async function listLeadsByIds(actor: Actor, ids: readonly string[]): Promise<readonly LeadListItem[]> {
  if (ids.length === 0) return [];
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(`${LEAD_SELECT} where l.id = any($1::uuid[])`, [ids]);
    return result.rows.map((row: Row) => mapLead(row));
  });
}

export interface Option {
  readonly value: string;
  readonly label: string;
}

/** ICP filter options for one business. */
export async function listIcpOptions(actor: Actor, businessId: string): Promise<readonly Option[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, name from public.icps
        where business_id = $1 and deleted_at is null
        order by is_default desc, name`,
      [businessId],
    );
    return result.rows.map((row: Row) => ({ value: asString(row.id), label: asString(row.name) }));
  });
}

/** Sender identities an operator may filter by in this business. */
export async function listIdentityOptions(actor: Actor, businessId: string): Promise<readonly Option[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select i.id, i.display_name
         from public.outreach_identities i
         join public.outreach_identity_business_access a on a.outreach_identity_id = i.id
        where a.business_id = $1 and i.deleted_at is null
        order by i.display_name`,
      [businessId],
    );
    return result.rows.map((row: Row) => ({
      value: asString(row.id),
      label: asString(row.display_name),
    }));
  });
}

/** Users who can own a lead in this business. */
export async function listOwnerOptions(actor: Actor, businessId: string): Promise<readonly Option[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select u.id, u.full_name, u.email
         from public.users u
         join public.user_business_access a on a.user_id = u.id
        where a.business_id = $1 and u.deleted_at is null
        order by u.full_name nulls last, u.email`,
      [businessId],
    );
    return result.rows.map((row: Row) => ({
      value: asString(row.id),
      label: asStringOrNull(row.full_name) ?? asString(row.email),
    }));
  });
}

export function leadStatusTone(status: string): 'cyan' | 'green' | 'amber' | 'red' | 'indigo' | 'neutral' {
  const map: Record<string, 'cyan' | 'green' | 'amber' | 'red' | 'indigo' | 'neutral'> = {
    new: 'cyan',
    needs_profile: 'cyan',
    ready: 'green',
    connection_due: 'cyan',
    connection_sent: 'cyan',
    connection_accepted: 'green',
    message_due: 'green',
    followup_due: 'amber',
    replied: 'green',
    paused: 'neutral',
    cooldown: 'amber',
    dormant: 'neutral',
    reactivation_due: 'amber',
    interested: 'green',
    wrong_person: 'red',
    do_not_contact: 'red',
    archived: 'neutral',
    deleted: 'red',
  };
  return map[status] ?? 'neutral';
}

export { asStringArray };
