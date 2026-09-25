/**
 * Profile Queue (A06) — imported leads that lack a full LinkedIn profile capture.
 *
 * spec `lead_sources.profile_queue_flow`: "Open search/profile, capture LinkedIn
 * URL + full copied profile data, update the existing partial lead rather than
 * creating a new lead."
 *
 * That sentence is the whole contract of this module, and it is enforced three
 * ways:
 *   1. Every write targets `leads.id` supplied by the screen; nothing here
 *      inserts a lead or a person.
 *   2. The captured page content is parsed with `profileCaptureSchema`
 *      (`zUntrustedContent`), so scraped text can never arrive unbounded and is
 *      never interpreted — it is stored as provenance.
 *   3. The capture is recorded as `source_evidence` with source
 *      'LinkedIn manual import', observed/captured timestamps, a content hash and
 *      a confidence, per spec invariant 18.
 */
import 'server-only';

import {
  contentHash,
  matchCompany,
  normalizeCompanyName,
  normalizeDomain,
  normalizeLinkedInUrl,
  normalizePersonName,
  profileCaptureSchema,
} from '@nexus/core';

import { withActor, type Actor, type Viewer } from '../actor';
import type { Db, Row } from '../sql';
import {
  asIso,
  asNumber,
  asString,
  asStringOrNull,
  describeDbError,
  read,
  readOne,
  type ListParams,
  type MutationResult,
  type Page,
  normalizePaging,
} from './common';

export const PROFILE_QUEUE_STATES = [
  'pending',
  'in_progress',
  'captured',
  'skipped',
  'failed',
] as const;
export type ProfileQueueState = (typeof PROFILE_QUEUE_STATES)[number];

export interface ProfileQueueItem {
  readonly id: string;
  readonly businessId: string;
  readonly leadId: string;
  readonly personId: string | null;
  readonly state: string;
  readonly reason: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly capturedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly assignedUserId: string | null;
  readonly assignedUserName: string | null;
  readonly personName: string | null;
  readonly jobTitle: string | null;
  readonly companyName: string | null;
  readonly linkedinUrl: string | null;
  readonly leadStatus: string | null;
  readonly needsProfile: boolean;
}

export interface ProfileQueueCounts {
  readonly pending: number;
  readonly inProgress: number;
  readonly captured: number;
  readonly skipped: number;
  readonly failed: number;
  readonly needsProfile: number;
}

const QUEUE_SELECT = `
  select q.id, q.business_id, q.lead_id, q.person_id, q.state, q.reason, q.attempts,
         q.last_error, q.captured_at, q.created_at, q.updated_at, q.assigned_user_id,
         u.full_name as assigned_user_name,
         p.full_name as person_name, p.job_title, p.linkedin_url,
         c.name as company_name, l.status as lead_status, l.needs_profile
    from public.profile_capture_queue q
    left join public.people p on p.id = q.person_id
    left join public.companies c on c.id = p.company_id
    left join public.leads l on l.id = q.lead_id
    left join public.users u on u.id = q.assigned_user_id`;

function mapItem(row: Row): ProfileQueueItem {
  return {
    id: asString(row.id),
    businessId: asString(row.business_id),
    leadId: asString(row.lead_id),
    personId: asStringOrNull(row.person_id),
    state: asString(row.state, 'pending'),
    reason: asStringOrNull(row.reason),
    attempts: asNumber(row.attempts),
    lastError: asStringOrNull(row.last_error),
    capturedAt: asIso(row.captured_at),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    assignedUserId: asStringOrNull(row.assigned_user_id),
    assignedUserName: asStringOrNull(row.assigned_user_name),
    personName: asStringOrNull(row.person_name),
    jobTitle: asStringOrNull(row.job_title),
    companyName: asStringOrNull(row.company_name),
    linkedinUrl: asStringOrNull(row.linkedin_url),
    leadStatus: asStringOrNull(row.lead_status),
    needsProfile: row.needs_profile === true,
  };
}

export interface ProfileQueueFilter {
  readonly businessId: string;
  /** Restrict to one state; omitted means "everything except captured". */
  readonly state?: string;
  readonly includeCaptured?: boolean;
}

export async function listProfileQueue(
  actor: Actor,
  filter: ProfileQueueFilter,
  params: ListParams = {},
): Promise<Page<ProfileQueueItem>> {
  const { limit, offset } = normalizePaging(params);

  const conditions = ['q.business_id = $1'];
  const values: unknown[] = [filter.businessId];

  if (filter.state !== undefined && filter.state.length > 0) {
    values.push(filter.state);
    conditions.push(`q.state = $${String(values.length)}`);
  } else if (filter.includeCaptured !== true) {
    conditions.push(`q.state <> 'captured'`);
  }

  const where = `where ${conditions.join(' and ')}`;

  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `${QUEUE_SELECT}
        ${where}
        order by case q.state when 'failed' then 0 when 'pending' then 1 when 'in_progress' then 2 else 3 end,
                 q.created_at
        limit $${String(values.length + 1)} offset $${String(values.length + 2)}`,
      [...values, limit, offset],
    );
    const counted = await sql.query<Row>(
      `select count(*)::int as n from public.profile_capture_queue q ${where}`,
      values,
    );
    return {
      items: result.rows.map(mapItem),
      total: asNumber(counted.rows[0]?.n),
      limit,
      offset,
    };
  });
}

export async function getProfileQueueItem(
  actor: Actor,
  queueId: string,
): Promise<ProfileQueueItem | null> {
  return readOne(actor, async (sql) => {
    const result = await sql.query<Row>(`${QUEUE_SELECT} where q.id = $1`, [queueId]);
    const row = result.rows[0];
    return row === undefined ? null : mapItem(row);
  });
}

export async function getProfileQueueCounts(
  actor: Actor,
  businessId: string,
): Promise<ProfileQueueCounts> {
  return read(actor, async (sql) => {
    const queue = await sql.query<Row>(
      `select
         count(*) filter (where state = 'pending')::int as pending,
         count(*) filter (where state = 'in_progress')::int as in_progress,
         count(*) filter (where state = 'captured')::int as captured,
         count(*) filter (where state = 'skipped')::int as skipped,
         count(*) filter (where state = 'failed')::int as failed
       from public.profile_capture_queue
       where business_id = $1`,
      [businessId],
    );
    const leads = await sql.query<Row>(
      `select count(*) filter (where needs_profile)::int as needs_profile
         from public.leads
        where business_id = $1 and deleted_at is null`,
      [businessId],
    );
    return {
      pending: asNumber(queue.rows[0]?.pending),
      inProgress: asNumber(queue.rows[0]?.in_progress),
      captured: asNumber(queue.rows[0]?.captured),
      skipped: asNumber(queue.rows[0]?.skipped),
      failed: asNumber(queue.rows[0]?.failed),
      needsProfile: asNumber(leads.rows[0]?.needs_profile),
    };
  });
}

/* ------------------------------------------------------------ the capture - */

export interface ProfileCaptureInput {
  readonly leadId: string;
  readonly linkedinUrl: string;
  /** The full copied profile page. Untrusted: bounded, stored, never executed. */
  readonly pageContent: string;
  readonly extractorConfidence?: number | null;
  readonly capturedAt?: string | null;
}

export interface ProfileCapturePlan {
  readonly ok: boolean;
  readonly error: string | null;
  readonly leadId: string;
  readonly personId: string | null;
  readonly personName: string | null;
  readonly canonicalUrl: string | null;
  readonly alreadyComplete: boolean;
  /** Present only when the URL is already the dedupe key of a different person. */
  readonly conflictPersonName: string | null;
  readonly contentHash: string | null;
  readonly contentLength: number;
  readonly matchedCompanyId: string | null;
  readonly willCreateCompany: boolean;
  readonly queueState: string | null;
  readonly needsProfile: boolean;
}

interface LeadContext {
  readonly leadId: string;
  readonly businessId: string;
  readonly personId: string;
  readonly personName: string;
  readonly linkedinUrl: string | null;
  readonly normalizedLinkedinUrl: string | null;
  readonly needsProfile: boolean;
}

async function loadLeadContext(sql: Db, leadId: string): Promise<LeadContext | null> {
  const result = await sql.query<Row>(
    `select l.id, l.business_id, l.person_id, l.needs_profile,
            p.full_name as person_name, p.linkedin_url, p.normalized_linkedin_url
       from public.leads l
       join public.people p on p.id = l.person_id
      where l.id = $1`,
    [leadId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    leadId: asString(row.id),
    businessId: asString(row.business_id),
    personId: asString(row.person_id),
    personName: asString(row.person_name),
    linkedinUrl: asStringOrNull(row.linkedin_url),
    normalizedLinkedinUrl: asStringOrNull(row.normalized_linkedin_url),
    needsProfile: row.needs_profile === true,
  };
}

/**
 * Validates a capture and reports exactly what it would do, without writing.
 *
 * The plan is what the operator confirms on screen; `captureProfile` re-runs the
 * same checks inside the write transaction.
 */
export async function planProfileCapture(
  actor: Actor,
  input: ProfileCaptureInput,
): Promise<ProfileCapturePlan> {
  return read(actor, async (sql) => {
    const context = await loadLeadContext(sql, input.leadId);
    if (context === null) {
      return {
        ok: false,
        error: 'That lead is not available to you.',
        leadId: input.leadId,
        personId: null,
        personName: null,
        canonicalUrl: null,
        alreadyComplete: false,
        conflictPersonName: null,
        contentHash: null,
        contentLength: input.pageContent.length,
        matchedCompanyId: null,
        willCreateCompany: false,
        queueState: null,
        needsProfile: false,
      };
    }

    const parsed = profileCaptureSchema.safeParse({
      lead_id: input.leadId,
      linkedin_url: input.linkedinUrl,
      page_content: input.pageContent,
      business_id: context.businessId,
      source_client: 'web',
      ...(input.capturedAt === undefined ? {} : { captured_at: input.capturedAt }),
      ...(input.extractorConfidence === undefined
        ? {}
        : { extractor_confidence: input.extractorConfidence }),
      capture_method: 'manual_paste',
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: describeCaptureIssue(parsed.error.issues[0]?.path.join('.'), parsed.error.issues[0]?.message),
        leadId: input.leadId,
        personId: context.personId,
        personName: context.personName,
        canonicalUrl: null,
        alreadyComplete: false,
        conflictPersonName: null,
        contentHash: null,
        contentLength: input.pageContent.length,
        matchedCompanyId: null,
        willCreateCompany: false,
        queueState: null,
        needsProfile: context.needsProfile,
      };
    }

    const canonicalUrl = normalizeLinkedInUrl(parsed.data.linkedin_url).canonicalUrl;
    if (canonicalUrl === null) {
      return {
        ok: false,
        error: 'That is not a LinkedIn member profile URL (expected linkedin.com/in/…).',
        leadId: context.leadId,
        personId: context.personId,
        personName: context.personName,
        canonicalUrl: null,
        alreadyComplete: false,
        conflictPersonName: null,
        contentHash: null,
        contentLength: parsed.data.page_content.length,
        matchedCompanyId: null,
        willCreateCompany: false,
        queueState: null,
        needsProfile: context.needsProfile,
      };
    }

    // The capture must update THIS lead. If the URL already belongs to a different
    // person, capturing here would silently merge two people, so it is refused and
    // pointed at Duplicate Review instead.
    const owner = await sql.query<Row>(
      `select id, full_name from public.people
        where normalized_linkedin_url = $1 and id <> $2
        limit 1`,
      [canonicalUrl, context.personId],
    );
    const conflict = owner.rows[0];
    if (conflict !== undefined) {
      return {
        ok: false,
        error: `That LinkedIn URL already belongs to ${asString(conflict.full_name)}. Resolve it in Duplicate Review instead — a profile capture must never fork or merge people.`,
        leadId: context.leadId,
        personId: context.personId,
        personName: context.personName,
        canonicalUrl,
        alreadyComplete: false,
        conflictPersonName: asString(conflict.full_name),
        contentHash: null,
        contentLength: parsed.data.page_content.length,
        matchedCompanyId: null,
        willCreateCompany: false,
        queueState: null,
        needsProfile: context.needsProfile,
      };
    }

    const queue = await sql.query<Row>(
      `select state from public.profile_capture_queue where lead_id = $1 order by updated_at desc limit 1`,
      [context.leadId],
    );

    const domain = normalizeDomain(parsed.data.extracted?.company_domain ?? null).domain;
    const company = await sql.query<Row>(
      `select id, name, normalized_name, normalized_domain from public.companies
        where deleted_at is null and ($1::text is not null and normalized_domain = $1)
        limit 1`,
      [domain],
    );
    const matchedCompanyId = asStringOrNull(company.rows[0]?.id);

    return {
      ok: true,
      error: null,
      leadId: context.leadId,
      personId: context.personId,
      personName: context.personName,
      canonicalUrl,
      alreadyComplete: context.normalizedLinkedinUrl === canonicalUrl && !context.needsProfile,
      conflictPersonName: null,
      contentHash: contentHash({
        source: 'LinkedIn manual import',
        lead_id: context.leadId,
        url: canonicalUrl,
        content: parsed.data.page_content,
      }),
      contentLength: parsed.data.page_content.length,
      matchedCompanyId,
      willCreateCompany: matchedCompanyId === null && (parsed.data.extracted?.company_domain ?? null) !== null,
      queueState: asStringOrNull(queue.rows[0]?.state),
      needsProfile: context.needsProfile,
    };
  });
}

/**
 * Records the capture and updates the existing lead.
 *
 * Writes: the person's profile fields, `source_evidence`, `leads.needs_profile =
 * false`, the linked company, the queue row, and a `profile_capture` interaction.
 * It never inserts a person or a lead.
 */
export async function captureProfile(
  viewer: Viewer,
  input: ProfileCaptureInput,
): Promise<MutationResult> {
  const plan = await planProfileCapture(viewer.actor, input);
  if (!plan.ok || plan.canonicalUrl === null || plan.contentHash === null) {
    return { ok: false, error: plan.error ?? 'The capture could not be validated.' };
  }

  try {
    return await withActor(viewer.actor, async (sql) => {
      await sql.exec(`select set_config('nexus.source_client', 'web', true)`);

      const context = await loadLeadContext(sql, input.leadId);
      if (context === null) throw new Error('That lead is no longer available.');

      const parsed = profileCaptureSchema.parse({
        lead_id: input.leadId,
        linkedin_url: input.linkedinUrl,
        page_content: input.pageContent,
        business_id: context.businessId,
        source_client: 'web',
        ...(input.capturedAt === undefined ? {} : { captured_at: input.capturedAt }),
        ...(input.extractorConfidence === undefined
          ? {}
          : { extractor_confidence: input.extractorConfidence }),
        capture_method: 'manual_paste',
      });

      const canonicalUrl = normalizeLinkedInUrl(parsed.linkedin_url).canonicalUrl;
      if (canonicalUrl === null) throw new Error('That is not a LinkedIn member profile URL.');

      // Re-check inside the transaction: the URL may have been claimed since the
      // plan was built, and a capture must never steal another person's identity.
      const owner = await sql.query<Row>(
        `select id, full_name from public.people
          where normalized_linkedin_url = $1 and id <> $2 limit 1`,
        [canonicalUrl, context.personId],
      );
      if (owner.rows[0] !== undefined) {
        throw new Error(
          `That LinkedIn URL already belongs to ${asString(owner.rows[0].full_name)}. Resolve it in Duplicate Review.`,
        );
      }

      const extracted = parsed.extracted ?? {};
      const capturedAt = parsed.captured_at ?? new Date();
      const capturedIso = capturedAt.toISOString();

      // ---- company (resolve, never fork) ---------------------------------
      const domain = normalizeDomain(extracted.company_domain ?? null).domain;
      let companyId: string | null = null;
      if (extracted.company_name !== undefined || domain !== null) {
        const existing = await sql.query<Row>(
          `select id, name, normalized_name, normalized_domain from public.companies
            where deleted_at is null
              and (($1::text is not null and normalized_domain = $1)
                   or ($2::text is not null and normalized_name = $2))
            limit 1`,
          [
            domain,
            extracted.company_name === undefined ? null : normalizeCompanyName(extracted.company_name),
          ],
        );
        const match = matchCompany(
          extracted.company_name ?? null,
          domain,
          existing.rows.map((row: Row) => ({
            id: asString(row.id),
            name: asString(row.name),
            normalized_name: asStringOrNull(row.normalized_name),
            normalized_domain: asStringOrNull(row.normalized_domain),
          })),
        );
        companyId = match.companyId;
        if (companyId === null && extracted.company_name !== undefined) {
          const inserted = await sql.query<Row>(
            `insert into public.companies (name, normalized_name, primary_domain, normalized_domain, industry, created_by)
             values ($1, $2, $3, $3, $4, $5)
             returning id`,
            [
              extracted.company_name,
              normalizeCompanyName(extracted.company_name),
              domain,
              extracted.company_industry ?? null,
              viewer.userId,
            ],
          );
          companyId = asStringOrNull(inserted.rows[0]?.id);
        }
      }

      // ---- the existing person is UPDATED, never re-created --------------
      await sql.query(
        `update public.people p
            set full_name = coalesce($2, p.full_name),
                normalized_name = coalesce($3, p.normalized_name),
                headline = coalesce($4, p.headline),
                job_title = coalesce($5, p.job_title),
                location = coalesce($6, p.location),
                linkedin_url = $7,
                normalized_linkedin_url = $7,
                company_id = coalesce($8, p.company_id),
                profile_captured_at = $9,
                deleted_at = null,
                updated_at = now()
          where p.id = $1`,
        [
          context.personId,
          extracted.full_name ?? null,
          extracted.full_name === undefined ? null : normalizePersonName(extracted.full_name),
          extracted.headline ?? null,
          extracted.job_title ?? null,
          extracted.location ?? null,
          canonicalUrl,
          companyId,
          capturedIso,
        ],
      );

      // ---- provenance ----------------------------------------------------
      // spec invariant 18: source, observed/captured time, content hash and
      // confidence are all required on evidence. The content hash includes the
      // capture time, so re-capturing the same page is a new, auditable fact.
      await sql.query(
        `insert into public.source_evidence
           (business_id, person_id, company_id, lead_id, source, source_url,
            raw_text_or_json, content_hash, observed_at, captured_at, confidence, created_by)
         values ($1, $2, $3, $4, 'LinkedIn manual import', $5, $6, $7, $8, $9, $10, $11)
         on conflict on constraint source_evidence_business_hash_key do nothing`,
        [
          context.businessId,
          context.personId,
          companyId,
          context.leadId,
          canonicalUrl,
          parsed.page_content,
          plan.contentHash,
          capturedIso,
          capturedIso,
          parsed.extractor_confidence ?? 1,
          viewer.userId,
        ],
      );

      // ---- spec: clear Needs Profile on the existing lead ----------------
      await sql.query(
        `update public.leads
            set needs_profile = false,
                status = case when status = 'needs_profile' then 'new' else status end,
                next_action_type = case when next_action_type = 'capture_profile' then 'none' else next_action_type end,
                next_action_at = case when next_action_type = 'capture_profile' then null else next_action_at end,
                last_activity_at = now(),
                updated_at = now()
          where id = $1`,
        [context.leadId],
      );

      // ---- queue ---------------------------------------------------------
      // One open item per lead (`profile_capture_queue_open_lead_key`), so the open
      // item is closed in place. A lead that was never queued gets a captured row so
      // the history still shows the capture happened.
      const closed = await sql.query(
        `update public.profile_capture_queue
            set state = 'captured',
                captured_at = $2,
                attempts = attempts + 1,
                last_error = null,
                reason = 'Profile captured manually from LinkedIn',
                updated_at = now()
          where lead_id = $1 and state in ('pending', 'in_progress')`,
        [context.leadId, capturedIso],
      );
      if (closed.affectedRows === 0) {
        await sql.query(
          `insert into public.profile_capture_queue
             (business_id, lead_id, person_id, state, reason, captured_at, attempts, last_error, updated_at)
           values ($1, $2, $3, 'captured', 'Profile captured manually from LinkedIn', $4, 1, null, now())`,
          [context.businessId, context.leadId, context.personId, capturedIso],
        );
      }

      // ---- audited history ----------------------------------------------
      await sql.query(
        `insert into public.interactions
           (business_id, lead_id, person_id, type, actor_user_id, direction, summary, payload, source_client, occurred_at)
         values ($1, $2, $3, 'profile_capture', $4, 'internal', $5, $6::jsonb, 'web', now())`,
        [
          context.businessId,
          context.leadId,
          context.personId,
          viewer.userId,
          `Profile captured from LinkedIn (${String(parsed.page_content.length)} characters)`,
          JSON.stringify({
            linkedin_url: canonicalUrl,
            content_hash: plan.contentHash,
            captured_at: capturedIso,
            confidence: parsed.extractor_confidence ?? 1,
          }),
        ],
      );

      return {
        ok: true,
        id: context.leadId,
        message: `Profile captured and applied to ${context.personName}. The existing lead was updated.`,
        needsProfileCleared: true,
      };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/** Marks a queue item in progress when the operator opens the capture form. */
export async function markQueueInProgress(viewer: Viewer, queueId: string): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `update public.profile_capture_queue
            set state = 'in_progress', updated_at = now(),
                attempts = attempts + 1,
                assigned_user_id = coalesce(assigned_user_id, $2)
          where id = $1 and state = 'pending'`,
        [queueId, viewer.userId],
      );
      if (result.affectedRows === 0) {
        throw new Error('That queue item is no longer pending.');
      }
      return { ok: true, id: queueId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/** Marks a queue item skipped — no capture is possible for this lead. */
export async function skipQueueItem(
  viewer: Viewer,
  queueId: string,
  reason: string,
): Promise<MutationResult> {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return { ok: false, error: 'Give a reason for skipping this lead.' };
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `update public.profile_capture_queue
            set state = 'skipped', reason = $2, updated_at = now()
          where id = $1 and state in ('pending', 'in_progress')`,
        [queueId, trimmed.slice(0, 500)],
      );
      if (result.affectedRows === 0) {
        throw new Error('That queue item is already resolved.');
      }
      return { ok: true, id: queueId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/** Re-queues a failed capture so it is attempted again. */
export async function retryQueueItem(viewer: Viewer, queueId: string): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `update public.profile_capture_queue
            set state = 'pending', last_error = null, updated_at = now()
          where id = $1 and state = 'failed'`,
        [queueId],
      );
      if (result.affectedRows === 0) throw new Error('That queue item is not in a failed state.');
      return { ok: true, id: queueId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

function describeCaptureIssue(path: string | undefined, message: string | undefined): string {
  const field = path ?? '';
  if (field.includes('page_content')) {
    return message ?? 'Paste the full copied profile content.';
  }
  if (field.includes('linkedin_url')) {
    return 'Enter the full LinkedIn profile URL (https://www.linkedin.com/in/…).';
  }
  return message ?? 'The capture could not be validated.';
}
