/**
 * The AI Context Pack — the compact, versioned bundle a drafting call is given
 * instead of the whole world (spec §59).
 *
 * The design rule is one sentence: **a pack contains permanent facts and nothing
 * else.** It is built from `people`, `companies`, `signals`, `lead_icp_matches`,
 * the committed `research_snapshots` summary, `opportunities`, approved offers and
 * claims, `person_contact_points`, message counts and `conversation_outcomes`. It
 * never reads `raw_staging` (which is unreadable by a tenant anyway) and never
 * reads `source_evidence.raw_text_or_json`, so there is no path by which a deleted
 * raw body can reappear inside a pack.
 *
 * Two mechanical consequences:
 *
 *   * `inputHash` is the hash of the **normalised fact set**, not of row order and
 *     not of the pack's own timestamp, so "same facts" reproduces the same hash
 *     and a changed fact cannot silently reuse a stale pack.
 *   * the model may rewrite only narrative fields. Every identifier, score, signal
 *     and claim in the committed pack is copied from the database by
 *     `reconcilePack`, because a model that restated an id would otherwise be able
 *     to point a pack at the wrong person.
 */
import 'server-only';

import {
  OUTREACH_CHANNELS,
  SIGNAL_KINDS,
  SIGNAL_POLARITIES,
  type OutreachChannel,
  type SignalKind,
  type SignalPolarity,
} from '@nexus/core';
import { z } from 'zod';

import { withActor, type Viewer } from '../actor';
import type { Db } from '../sql';
import { asIso, asNumber, asNumberOrNull } from '../repo/common';
import { recordContextBuild } from '../repo/enrichment';
import { hashAiInput, runAiTask } from './runner';
import type { AiProvider } from './types';

export interface ContextPackPerson {
  readonly id: string;
  readonly fullName: string;
  readonly headline: string | null;
  readonly jobTitle: string | null;
  readonly location: string | null;
  readonly linkedinUrl: string | null;
  readonly seniority: string | null;
  readonly department: string | null;
  /** Narrative only. Everything else on this object is copied from the database. */
  readonly summary: string | null;
}

export interface ContextPackCompany {
  readonly id: string | null;
  readonly name: string | null;
  readonly domain: string | null;
  readonly website: string | null;
  readonly industry: string | null;
  readonly employeeCount: number | null;
  readonly summary: string | null;
  readonly services: readonly string[];
  readonly locations: readonly string[];
}

export interface ContextPackSignal {
  readonly kind: SignalKind;
  readonly polarity: SignalPolarity;
  readonly strength: number;
  readonly label: string;
  readonly detail: string | null;
  readonly observedAt: string;
}

export interface ContextPackIcp {
  readonly id: string;
  readonly name: string;
  readonly matchScore: number | null;
  readonly recommendedAngle: string | null;
}

export interface ContextPackFit {
  readonly score: number | null;
  readonly reasons: readonly string[];
  readonly disqualifiers: readonly string[];
}

export interface ContextPackIntent {
  readonly score: number | null;
  readonly assessment: string | null;
}

export interface ContextPackOpportunity {
  readonly id: string;
  readonly name: string;
  readonly stage: string;
  readonly value: number | null;
  readonly currency: string;
}

export interface ContextPackOffer {
  readonly id: string;
  readonly name: string;
  readonly positioning: string | null;
}

export interface ContextPackPriorOutreach {
  readonly messagesSent: number;
  readonly lastOutboundAt: string | null;
  readonly replies: number;
  readonly lastReplySummary: string | null;
}

export interface ContextPack {
  readonly person: ContextPackPerson;
  readonly company: ContextPackCompany;
  readonly signals: readonly ContextPackSignal[];
  readonly icp: ContextPackIcp | null;
  readonly fit: ContextPackFit | null;
  readonly intent: ContextPackIntent | null;
  readonly opportunity: ContextPackOpportunity | null;
  readonly offer: ContextPackOffer | null;
  readonly approvedClaims: readonly string[];
  readonly channels: readonly OutreachChannel[];
  readonly priorOutreach: ContextPackPriorOutreach;
  readonly builtAt: string;
}

/* ------------------------------------------------------------- the schema - */

const packPersonSchema = z
  .object({
    id: z.string().min(1),
    fullName: z.string().min(1),
    headline: z.string().nullable(),
    jobTitle: z.string().nullable(),
    location: z.string().nullable(),
    linkedinUrl: z.string().nullable(),
    seniority: z.string().nullable(),
    department: z.string().nullable(),
    summary: z.string().nullable(),
  })
  .strict();

const packCompanySchema = z
  .object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    domain: z.string().nullable(),
    website: z.string().nullable(),
    industry: z.string().nullable(),
    employeeCount: z.number().nullable(),
    summary: z.string().nullable(),
    services: z.array(z.string()),
    locations: z.array(z.string()),
  })
  .strict();

const packSignalSchema = z
  .object({
    kind: z.enum(SIGNAL_KINDS),
    polarity: z.enum(SIGNAL_POLARITIES),
    strength: z.number().int().min(-100).max(100),
    label: z.string().min(1),
    detail: z.string().nullable(),
    observedAt: z.string().min(1),
  })
  .strict();

const packIcpSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    matchScore: z.number().nullable(),
    recommendedAngle: z.string().nullable(),
  })
  .strict();

const packFitSchema = z
  .object({
    score: z.number().nullable(),
    reasons: z.array(z.string()),
    disqualifiers: z.array(z.string()),
  })
  .strict();

const packIntentSchema = z
  .object({ score: z.number().nullable(), assessment: z.string().nullable() })
  .strict();

const packOpportunitySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    stage: z.string().min(1),
    value: z.number().nullable(),
    currency: z.string().min(1),
  })
  .strict();

const packOfferSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    positioning: z.string().nullable(),
  })
  .strict();

const packPriorOutreachSchema = z
  .object({
    messagesSent: z.number().int().min(0),
    lastOutboundAt: z.string().nullable(),
    replies: z.number().int().min(0),
    lastReplySummary: z.string().nullable(),
  })
  .strict();

/**
 * The Context Pack body. Strict, and every field explicit: an answer with an
 * unexpected key is refused rather than stored, because a pack that carries an
 * unknown shape cannot be rendered or cached deterministically.
 */
export const contextPackSchema: z.ZodType<ContextPack> = z
  .object({
    person: packPersonSchema,
    company: packCompanySchema,
    signals: z.array(packSignalSchema),
    icp: packIcpSchema.nullable(),
    fit: packFitSchema.nullable(),
    intent: packIntentSchema.nullable(),
    opportunity: packOpportunitySchema.nullable(),
    offer: packOfferSchema.nullable(),
    approvedClaims: z.array(z.string()),
    channels: z.array(z.enum(OUTREACH_CHANNELS)),
    priorOutreach: packPriorOutreachSchema,
    builtAt: z.string().min(1),
  })
  .strict();

/* ------------------------------------------------------------- boundings - */

/** A narrative string, truncated. Nothing unbounded may enter a pack. */
function boundedText(value: string | null | undefined, max = 600): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** A narrative list, bounded in both length and item size. */
function boundedList(value: readonly string[] | undefined, maxItems = 12): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
    .slice(0, maxItems)
    .map((item) => (item.length > 120 ? `${item.slice(0, 119)}…` : item));
}

/* ------------------------------------------------------ build from facts - */

type PackFactRow = {
  lead_id: string;
  business_id: string;
  person_id: string;
  company_id: string | null;
  primary_icp_id: string | null;
  full_name: string;
  headline: string | null;
  job_title: string | null;
  location: string | null;
  linkedin_url: string | null;
  company_name: string | null;
  company_domain: string | null;
  company_website: string | null;
  industry: string | null;
  employee_count: number | null;
  company_description: string | null;
  icp_name: string | null;
  match_score: number | string | null;
  match_reason: string | null;
}

export interface ContextPackInput {
  readonly businessId: string;
  readonly pack: ContextPack;
  readonly inputHash: string;
  readonly sourceSummary: Record<string, unknown>;
}

/**
 * Assembles the deterministic pack from permanent facts.
 *
 * Returns null when the lead is not visible to the actor — RLS is the tenancy
 * boundary, so there is no separate "may I" check to forget.
 */
export async function buildContextPackInput(
  viewer: Viewer,
  leadId: string,
): Promise<ContextPackInput | null> {
  return withActor(viewer.actor, async (sql) => {
    const facts = await sql.query<PackFactRow>(
      `select l.id as lead_id,
              l.business_id,
              l.person_id,
              l.company_id,
              l.primary_icp_id,
              p.full_name,
              p.headline,
              p.job_title,
              p.location,
              p.linkedin_url,
              c.name as company_name,
              coalesce(c.primary_domain, c.normalized_domain) as company_domain,
              c.primary_domain as company_website,
              c.industry,
              c.employee_count,
              c.description as company_description,
              i.name as icp_name,
              m.match_score,
              m.reason as match_reason
         from public.leads l
         join public.people p on p.id = l.person_id
         left join public.companies c on c.id = l.company_id
         left join public.icps i on i.id = l.primary_icp_id
         left join public.lead_icp_matches m
                on m.lead_id = l.id and m.icp_id = l.primary_icp_id
        where l.id = $1
          and l.deleted_at is null`,
      [leadId],
    );

    const row = facts.rows[0];
    if (row === undefined) return null;

    const signalRows = await sql.query<{
      kind: string;
      polarity: string;
      strength: number;
      label: string | null;
      detail: string | null;
      observed_at: unknown;
    }>(
      `select kind, polarity, strength, label, detail, observed_at
         from public.signals
        where is_active
          and (lead_id = $1 or person_id = $2 or ($3::uuid is not null and company_id = $3))
        order by strength desc, observed_at desc
        limit 20`,
      [String(row.lead_id), String(row.person_id), row.company_id],
    );

    const contacts = await sql.query<{ kind: string; confirmed_by_user: boolean }>(
      `select kind, confirmed_by_user
         from public.person_contact_points
        where person_id = $1 and deleted_at is null
        order by is_primary desc, confidence desc
        limit 20`,
      [String(row.person_id)],
    );

    const snapshot = await sql.query<{ summary: string | null; created_at: unknown }>(
      `select summary, created_at
         from public.research_snapshots
        where lead_id = $1 or ($2::uuid is not null and company_id = $2)
        order by created_at desc
        limit 1`,
      [String(row.lead_id), row.company_id],
    );

    const offer = await sql.query<{ id: string; name: string; positioning: string | null }>(
      `select id, name, positioning
         from public.offers
        where business_id = $1 and approved and deleted_at is null
        order by updated_at desc
        limit 1`,
      [String(row.business_id)],
    );

    // Bounded retrieval, never the whole Business Brain (spec §62.3): at most eight
    // approved claims, and an asset contributes only when it is approved *and*
    // cleared for AI use.
    const claims = await sql.query<{ claim: string }>(
      `select claim from (
         select vp.statement as claim, vp.updated_at
           from public.value_propositions vp
          where vp.business_id = $1 and vp.approved and vp.deleted_at is null
         union all
         select coalesce(ka.title, ka.description) as claim, ka.updated_at
           from public.knowledge_assets ka
          where ka.business_id = $1
            and ka.deleted_at is null
            and ka.approval_state = 'approved'
            and ka.ai_use_allowed = true
       ) c
       where c.claim is not null
       order by c.updated_at desc
       limit 8`,
      [String(row.business_id)],
    );

    const outreach = await sql.query<{
      messages_sent: number;
      last_outbound_at: unknown;
      replies: number;
    }>(
      `select
         (select count(*)::int from public.message_instances mi
           where mi.lead_id = $1 and mi.state = 'SENT') as messages_sent,
         (select max(mi.sent_at) from public.message_instances mi
           where mi.lead_id = $1 and mi.state = 'SENT') as last_outbound_at,
         (select count(*)::int from public.conversation_outcomes co
           where co.lead_id = $1) as replies`,
      [String(row.lead_id)],
    );

    const lastOutcome = await sql.query<{ outcome: string; reason: string | null }>(
      `select outcome, reason
         from public.conversation_outcomes
        where lead_id = $1
        order by created_at desc
        limit 1`,
      [String(row.lead_id)],
    );

    const opportunity = await sql.query<{
      id: string;
      name: string;
      stage: string;
      value: number | string | null;
      currency: string;
    }>(
      `select id, name, stage, value, currency
         from public.opportunities
        where lead_id = $1 and deleted_at is null
        order by updated_at desc
        limit 1`,
      [String(row.lead_id)],
    );

    const enrollment = await sql.query<{ state: string }>(
      `select state from public.sequence_enrollments where lead_id = $1 order by created_at desc limit 1`,
      [String(row.lead_id)],
    );

    const signals: readonly ContextPackSignal[] = signalRows.rows.map((signal) => ({
      kind: (SIGNAL_KINDS as readonly string[]).includes(signal.kind)
        ? (signal.kind as SignalKind)
        : 'custom',
      polarity:
        signal.polarity === 'positive' || signal.polarity === 'negative'
          ? signal.polarity
          : 'neutral',
      strength: asNumber(signal.strength, 0),
      label: signal.label ?? 'Signal',
      detail: signal.detail,
      observedAt: asIso(signal.observed_at) ?? new Date().toISOString(),
    }));

    const outcomeRow = lastOutcome.rows[0];
    const replySummary =
      outcomeRow === undefined
        ? null
        : boundedText(
            outcomeRow.reason === null ? outcomeRow.outcome : `${outcomeRow.outcome} — ${outcomeRow.reason}`,
            300,
          );

    const icpRow = row.primary_icp_id === null || row.icp_name === null ? null : row.primary_icp_id;

    const pack: ContextPack = {
      person: {
        id: String(row.person_id),
        fullName: row.full_name,
        headline: row.headline,
        jobTitle: row.job_title,
        location: row.location,
        linkedinUrl: row.linkedin_url,
        seniority: null,
        department: null,
        summary: null,
      },
      company: {
        id: row.company_id === null ? null : String(row.company_id),
        name: row.company_name,
        domain: row.company_domain,
        website: row.company_website,
        industry: row.industry,
        employeeCount: asNumberOrNull(row.employee_count),
        // The committed research summary is a short structured field, not a raw
        // body: the body was deleted the moment the snapshot was committed.
        summary: boundedText(snapshot.rows[0]?.summary ?? row.company_description, 600),
        services: [],
        locations: [],
      },
      signals,
      icp:
        icpRow === null
          ? null
          : {
              id: String(icpRow),
              name: row.icp_name ?? 'ICP',
              matchScore: asNumberOrNull(row.match_score),
              recommendedAngle: null,
            },
      fit:
        row.primary_icp_id === null
          ? null
          : {
              score: asNumberOrNull(row.match_score),
              reasons: row.match_reason === null ? [] : [boundedText(row.match_reason, 300) ?? ''],
              disqualifiers: [],
            },
      intent: {
        // No number: an intent score is ICP_QUALIFICATION's output, and inventing
        // one here would be a model-authored number by another route.
        score: null,
        assessment:
          signals.length === 0
            ? 'No active signals recorded.'
            : `${String(signals.length)} active signal(s); strongest: ${signals[0]?.label ?? 'n/a'}`,
      },
      opportunity:
        opportunity.rows[0] === undefined
          ? null
          : {
              id: String(opportunity.rows[0].id),
              name: opportunity.rows[0].name,
              stage: opportunity.rows[0].stage,
              value: asNumberOrNull(opportunity.rows[0].value),
              currency: opportunity.rows[0].currency,
            },
      offer:
        offer.rows[0] === undefined
          ? null
          : {
              id: String(offer.rows[0].id),
              name: offer.rows[0].name,
              positioning: boundedText(offer.rows[0].positioning, 600),
            },
      approvedClaims: claims.rows
        .map((entry) => boundedText(entry.claim, 300))
        .filter((claim): claim is string => claim !== null),
      // Every channel is available; discovery source never restricts one (§20).
      channels: OUTREACH_CHANNELS,
      priorOutreach: {
        messagesSent: asNumber(outreach.rows[0]?.messages_sent, 0),
        lastOutboundAt: asIso(outreach.rows[0]?.last_outbound_at),
        replies: asNumber(outreach.rows[0]?.replies, 0),
        lastReplySummary: replySummary,
      },
      builtAt: new Date().toISOString(),
    };

    // The hash covers the fact set, never `builtAt`: same facts must reproduce the
    // same hash, which is what makes the cache and its invalidation structural.
    const hashable: Record<string, unknown> = { ...pack };
    delete hashable['builtAt'];
    const inputHash = hashAiInput(hashable);

    const sourceSummary: Record<string, unknown> = {
      leadId: String(row.lead_id),
      personId: String(row.person_id),
      companyId: row.company_id === null ? null : String(row.company_id),
      icpId: row.primary_icp_id === null ? null : String(row.primary_icp_id),
      signalCount: signals.length,
      contactKinds: [...new Set(contacts.rows.map((entry) => entry.kind))].sort(),
      confirmedContacts: contacts.rows.filter((entry) => entry.confirmed_by_user === true).length,
      hasResearchSnapshot: snapshot.rows.length > 0,
      approvedClaimCount: claims.rows.length,
      hasApprovedOffer: offer.rows.length > 0,
      messagesSent: asNumber(outreach.rows[0]?.messages_sent, 0),
      replies: asNumber(outreach.rows[0]?.replies, 0),
      enrollmentState: enrollment.rows[0]?.state ?? null,
    };

    return { businessId: String(row.business_id), pack, inputHash, sourceSummary };
  });
}

/** The user turn for `CONTEXT_BUILD`. The fact set is data, never instructions. */
export function renderContextPackUser(pack: ContextPack, template: string): string {
  return [
    template,
    'PERMANENT FACTS (the only permitted source of truth — copy every field, change only the narrative ones):',
    JSON.stringify(pack),
    'NARRATIVE FIELDS TO REWRITE: person.summary, company.summary, company.services, ' +
      'company.locations, icp.recommendedAngle. Leave every other field exactly as supplied.',
  ].join('\n\n');
}

/**
 * Keeps the database's answer for everything that is an identity, a score or an
 * observation, and the model's answer only for prose.
 *
 * The model's contribution is therefore genuinely additive: it cannot repoint the
 * pack at another person, inflate a signal, or add a claim the business has not
 * approved.
 */
export function reconcilePack(facts: ContextPack, model: ContextPack): ContextPack {
  return {
    person: {
      ...facts.person,
      seniority: boundedText(model.person.seniority, 120) ?? facts.person.seniority,
      department: boundedText(model.person.department, 120) ?? facts.person.department,
      summary: boundedText(model.person.summary) ?? facts.person.summary,
    },
    company: {
      ...facts.company,
      industry: boundedText(model.company.industry, 120) ?? facts.company.industry,
      summary: boundedText(model.company.summary) ?? facts.company.summary,
      services: boundedList(model.company.services).length > 0 ? boundedList(model.company.services) : facts.company.services,
      locations: boundedList(model.company.locations).length > 0 ? boundedList(model.company.locations) : facts.company.locations,
    },
    signals: facts.signals,
    icp:
      facts.icp === null
        ? null
        : { ...facts.icp, recommendedAngle: boundedText(model.icp?.recommendedAngle, 600) ?? facts.icp.recommendedAngle },
    fit: facts.fit,
    intent: facts.intent,
    opportunity: facts.opportunity,
    offer: facts.offer,
    approvedClaims: facts.approvedClaims,
    channels: facts.channels,
    priorOutreach: facts.priorOutreach,
    builtAt: facts.builtAt,
  };
}

/* ------------------------------------------------------------ persistence - */

async function readStoredPack(sql: Db, leadId: string, inputHash: string): Promise<ContextPack | null> {
  const result = await sql.query<{ pack: unknown }>(
    `select pack from public.ai_context_packs where lead_id = $1 and input_hash = $2`,
    [leadId, inputHash],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const parsed = contextPackSchema.safeParse(row.pack);
  // A stored pack that no longer satisfies the schema is treated as absent rather
  // than rendered: a half-shaped pack would break drafting in a way nobody sees.
  return parsed.success ? parsed.data : null;
}

export type GetOrBuildContextPackResult =
  | { readonly ok: true; readonly pack: ContextPack; readonly cached: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * Returns the pack for the lead's current facts, building it if necessary.
 *
 * A cache hit is decided by `(lead_id, input_hash)`, so changed facts invalidate it
 * without anything being flushed, and `force` re-asks the model for the narrative
 * while the identity fields still come from the database.
 */
export async function getOrBuildContextPack(
  viewer: Viewer,
  leadId: string,
  options: { readonly provider?: AiProvider; readonly force?: boolean } = {},
): Promise<GetOrBuildContextPackResult> {
  const built = await buildContextPackInput(viewer, leadId);
  if (built === null) return { ok: false, error: 'That lead could not be found.' };

  // The cache hit is decided here rather than only inside `runAiTask`, so a hit
  // returns the stored pack *unchanged* instead of rebuilding it and rewriting the
  // same row.
  if (options.force !== true) {
    const existing = await withActor(viewer.actor, async (sql) =>
      readStoredPack(sql, leadId, built.inputHash),
    );
    if (existing !== null) return { ok: true, pack: existing, cached: true };
  }

  const outcome = await runAiTask<ContextPack>(
    viewer,
    {
      businessId: built.businessId,
      task: 'CONTEXT_BUILD',
      promptKey: 'context_build',
      leadId,
    },
    {
      inputHash: built.inputHash,
      schema: contextPackSchema,
      // The resolved prompt supplies the system instruction and the instruction
      // block; the fact set is the user data, and it contains no raw body.
      build: (prompt) => ({
        system: prompt.system,
        user: renderContextPackUser(built.pack, prompt.template),
      }),
      loadCached: async () =>
        withActor(viewer.actor, async (sql) => readStoredPack(sql, leadId, built.inputHash)),
      provider: options.provider,
    },
  );

  if (!outcome.ok) {
    // Degrade to the deterministic pack rather than failing the lead. It contains
    // permanent facts only, which is what §59.2 requires of a pack, so it is a
    // legitimate answer to "build me a context pack" when the model is absent. It
    // is deliberately **not** persisted: the next call retries the model.
    return { ok: true, pack: built.pack, cached: false };
  }

  const pack = reconcilePack(built.pack, outcome.data);

  await withActor(viewer.actor, async (sql) => {
    await sql.query(
      `insert into public.ai_context_packs
         (business_id, lead_id, input_hash, pack, source_summary, generated_by_run_id, model,
          prompt_version_id, created_by)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
       on conflict (lead_id, input_hash) do update
         set pack = excluded.pack,
             source_summary = excluded.source_summary,
             generated_by_run_id = excluded.generated_by_run_id,
             model = excluded.model,
             prompt_version_id = excluded.prompt_version_id`,
      [
        built.businessId,
        leadId,
        built.inputHash,
        JSON.stringify(pack),
        JSON.stringify(built.sourceSummary),
        outcome.runId,
        outcome.model,
        outcome.promptVersionId,
        viewer.userId,
      ],
    );
  });

  await recordContextBuild(viewer, leadId);

  return { ok: true, pack, cached: outcome.cached };
}
