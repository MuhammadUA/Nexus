/**
 * ICP qualification — the call site for the `ICP_QUALIFICATION` task.
 *
 * The task itself already existed: a versioned `icp_qualify` prompt, a strict
 * schema, input hashing, a cache lookup and an `ai_runs` ledger row, all through
 * the shared runner. What was missing was the thing the product needs — asking it
 * at the right moment and *persisting* the answer — and that is this module.
 *
 * Three rules shape it:
 *
 *   1. **Only score against committed facts.** The input is built from the
 *      database (person, company, signals, research summary, contacts, ICP
 *      criteria) and never from a raw body: the qualification is reproducible from
 *      what a reviewer can see, and §23.3's "never send a raw body to a model" holds
 *      here exactly as it does for extraction.
 *   2. **The input hash is the cache and the requalification trigger.** It covers
 *      the facts, the criteria, the prompt version and the model, so identical
 *      facts buy nothing new and *changed* facts automatically buy a new answer.
 *      Nothing needs flushing, and there is no "requalify" button that could
 *      hammer the provider.
 *   3. **The result is persisted through the domain path.** A chosen ICP is
 *      applied with the audited `set_primary_icp`, and the rest of the answer
 *      (intent, angle, reasons, disqualifiers, confidence, provenance) is written
 *      onto that match row — which is also what the AI context pack already reads,
 *      so drafting picks the new fit and intent up because the pack's own input
 *      hash changed, not because anything was told to refresh.
 *
 * A qualification that names no ICP is not a failure and not a reason to invent
 * one: the answer is recorded on the lead's existing primary match when there is
 * one, and otherwise only in the ledger. Lead state is never fabricated.
 */
import 'server-only';

import { qualificationPrerequisites } from '@nexus/core';

import { withActor, type Viewer } from '../actor';
import { TASK_REGISTRY, taskPrompt, type IcpQualificationInput } from './tasks';
import { hashAiInput, runAiTask, type AiRunFailureCode } from './runner';
import type { IcpQualification } from './tasks';
import type { AiProvider } from './types';

export type QualificationFailureCode =
  | 'lead_not_found'
  | 'prerequisites_unmet'
  | 'commit_failed'
  | AiRunFailureCode;

export interface QualificationOutcomeSuccess {
  readonly ok: true;
  readonly leadId: string;
  readonly icpId: string | null;
  readonly fitScore: number;
  readonly intentScore: number;
  readonly confidence: number;
  /** True when the answer changed the lead's primary ICP. */
  readonly assignedPrimary: boolean;
  readonly cached: boolean;
  readonly runId: string | null;
  readonly model: string;
  readonly promptVersionId: string | null;
}

export interface QualificationOutcomeFailure {
  readonly ok: false;
  readonly error: string;
  readonly errorCode: QualificationFailureCode;
  readonly retryable: boolean;
  readonly runId: string | null;
  /** Named facts that are missing, when the refusal was "not enough structure yet". */
  readonly missing?: readonly string[];
}

export type QualificationOutcome = QualificationOutcomeSuccess | QualificationOutcomeFailure;

interface QualificationRow extends Record<string, unknown> {
  lead_id: string;
  business_id: string;
  person_id: string;
  company_id: string | null;
  primary_icp_id: string | null;
  enrichment_state: string | null;
  person_full_name: string;
  person_job_title: string | null;
  person_headline: string | null;
  person_location: string | null;
  person_linkedin: string | null;
  company_name: string | null;
  company_domain: string | null;
  company_industry: string | null;
  company_employee_count: number | null;
  company_description: string | null;
  research_summary: string | null;
  signal_count: number;
  has_ai_context: boolean;
  contact_kinds: string[] | null;
}

function boundedText(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * The facts a qualification is scored on, and the hash that identifies them.
 *
 * The projection is explicit and ordered rather than a `select *`: the hash must
 * change when *facts* change and must not change because a query returned columns
 * in a different order, so every field that reaches the prompt is named here once.
 */
export interface QualificationInput {
  readonly businessId: string;
  readonly leadId: string;
  readonly personId: string;
  readonly companyId: string | null;
  readonly primaryIcpId: string | null;
  readonly enrichmentState: string;
  readonly criteria: readonly { readonly id: string; readonly name: string; readonly criteria: unknown }[];
  readonly taskInput: IcpQualificationInput;
  readonly inputHash: string;
  readonly prerequisites: {
    readonly personResolved: boolean;
    readonly companyResolved: boolean;
    readonly hasCompanyResearch: boolean;
    readonly signalCount: number;
    readonly hasAiContext: boolean;
  };
}

/**
 * Reads the lead, projects the facts, and hashes them.
 *
 * One statement for the facts and one for the criteria; both are bounded reads, and
 * neither touches `raw_staging` or a source-evidence body.
 */
export async function buildQualificationInput(
  viewer: Viewer,
  leadId: string,
): Promise<QualificationInput | null> {
  return withActor(viewer.actor, async (sql) => {
    const facts = await sql.query<QualificationRow>(
      `select l.id as lead_id,
              l.business_id,
              l.person_id,
              l.company_id,
              l.primary_icp_id,
              e.status as enrichment_state,
              p.full_name as person_full_name,
              p.job_title as person_job_title,
              p.headline as person_headline,
              p.location as person_location,
              p.normalized_linkedin_url as person_linkedin,
              c.name as company_name,
              coalesce(c.primary_domain, c.normalized_domain) as company_domain,
              c.industry as company_industry,
              c.employee_count as company_employee_count,
              c.description as company_description,
              (select r.summary
                 from public.research_snapshots r
                where r.lead_id = l.id or (l.company_id is not null and r.company_id = l.company_id)
                order by r.created_at desc
                limit 1) as research_summary,
              (select count(*)::int
                 from public.signals s
                where s.is_active
                  and (s.lead_id = l.id or s.person_id = l.person_id
                       or (l.company_id is not null and s.company_id = l.company_id))) as signal_count,
              exists (select 1 from public.ai_context_packs a where a.lead_id = l.id) as has_ai_context,
              (select array_agg(cp.kind order by cp.kind)
                 from public.person_contact_points cp
                where cp.person_id = l.person_id and cp.deleted_at is null) as contact_kinds
         from public.leads l
         join public.people p on p.id = l.person_id
         left join public.companies c on c.id = l.company_id
         left join public.lead_enrichment e on e.lead_id = l.id
        where l.id = $1
          and l.deleted_at is null`,
      [leadId],
    );

    const row = facts.rows[0];
    if (row === undefined) return null;

    const criteria = await sql.query<{ id: string; name: string; criteria: unknown }>(
      `select id, name, criteria
         from public.icps
        where business_id = $1
          and is_active
          and deleted_at is null
        order by is_default desc, name asc
        limit 20`,
      [String(row.business_id)],
    );

    // The signal labels are a bounded, ordered projection: the newest twelve, so
    // the prompt cannot grow with the history and the hash stays stable.
    const signals = await sql.query<{ kind: string; label: string; polarity: string; strength: number }>(
      `select s.kind, coalesce(s.label, s.kind) as label, s.polarity, s.strength
         from public.signals s
        where s.is_active
          and (s.lead_id = $1 or s.person_id = $2 or ($3::uuid is not null and s.company_id = $3))
        order by s.observed_at desc
        limit 12`,
      [leadId, String(row.person_id), row.company_id === null ? null : String(row.company_id)],
    );

    const factsProjection = {
      person: {
        full_name: row.person_full_name,
        job_title: boundedText(row.person_job_title, 200),
        headline: boundedText(row.person_headline, 300),
        location: boundedText(row.person_location, 200),
        // A boolean, not the URL: the criterion is "has a profile", and the URL
        // itself adds nothing the model needs to score a fit.
        has_linkedin_profile: boundedText(row.person_linkedin, 2048) !== null,
      },
      company: {
        name: row.company_name,
        domain: boundedText(row.company_domain, 200),
        industry: boundedText(row.company_industry, 200),
        employee_count: row.company_employee_count,
        description: boundedText(row.company_description, 600),
      },
      research_summary: boundedText(row.research_summary, 600),
      signals: signals.rows.map((signal) => ({
        kind: signal.kind,
        label: signal.label,
        polarity: signal.polarity,
        strength: signal.strength,
      })),
      contact_kinds: row.contact_kinds ?? [],
      enrichment_state: row.enrichment_state ?? 'MINIMAL',
      current_primary_icp_id: row.primary_icp_id === null ? null : String(row.primary_icp_id),
    };

    const criteriaProjection = criteria.rows.map((entry) => ({
      id: String(entry.id),
      name: entry.name,
      criteria: entry.criteria ?? {},
    }));

    return {
      businessId: String(row.business_id),
      leadId: String(row.lead_id),
      personId: String(row.person_id),
      companyId: row.company_id === null ? null : String(row.company_id),
      primaryIcpId: row.primary_icp_id === null ? null : String(row.primary_icp_id),
      enrichmentState: row.enrichment_state ?? 'MINIMAL',
      criteria: criteriaProjection,
      taskInput: { facts: factsProjection, criteria: criteriaProjection },
      inputHash: hashAiInput({
        task: 'ICP_QUALIFICATION',
        leadId: String(row.lead_id),
        facts: factsProjection,
        criteria: criteriaProjection,
      }),
      prerequisites: {
        // "Resolved" means the canonical row exists with a usable name — the lead
        // could not have been created without one, so this is a guard rather than
        // a real possibility.
        personResolved: boundedText(row.person_full_name, 300) !== null,
        companyResolved: row.company_id !== null,
        hasCompanyResearch: boundedText(row.research_summary, 600) !== null,
        signalCount: Number(row.signal_count ?? 0),
        hasAiContext: row.has_ai_context === true,
      },
    };
  });
}

/**
 * Is a committed qualification already the answer for exactly these facts?
 *
 * Two sources are consulted, and both matter:
 *
 *   * `lead_icp_matches.input_hash` — the answer that was attached to an ICP;
 *   * the newest `SUCCEEDED` `ICP_QUALIFICATION` run — the answer that could *not*
 *     be attached, because the model named no ICP. Without this second source a
 *     lead with no matching ICP would buy the same qualification on every
 *     processor pass for ever.
 */
export async function qualificationInputHashMatches(
  viewer: Viewer,
  leadId: string,
  inputHash: string,
): Promise<boolean> {
  return withActor(viewer.actor, async (sql) => {
    const stored = await sql.query<{ n: number }>(
      `select count(*)::int as n
         from public.lead_icp_matches m
        where m.lead_id = $1 and m.input_hash = $2`,
      [leadId, inputHash],
    );
    if (Number(stored.rows[0]?.n ?? 0) > 0) return true;

    const runs = await sql.query<{ n: number }>(
      `select count(*)::int as n
         from public.ai_runs r
        where r.lead_id = $1
          and r.task = 'ICP_QUALIFICATION'
          and r.status = 'SUCCEEDED'
          and r.input_hash = $2`,
      [leadId, inputHash],
    );
    return Number(runs.rows[0]?.n ?? 0) > 0;
  });
}

/**
 * The qualification state the chaining planner needs, for one lead.
 *
 * Null means the lead is not visible to this actor, which the caller treats as
 * "plan nothing".
 */
export async function qualificationStateForLead(
  viewer: Viewer,
  leadId: string,
): Promise<{
  readonly prerequisites: QualificationInput['prerequisites'];
  readonly inputHash: string;
  readonly qualifiedForCurrentInput: boolean;
} | null> {
  const built = await buildQualificationInput(viewer, leadId);
  if (built === null) return null;

  const current = await qualificationInputHashMatches(viewer, leadId, built.inputHash);
  return {
    prerequisites: built.prerequisites,
    inputHash: built.inputHash,
    qualifiedForCurrentInput: current,
  };
}

/**
 * Materialises a cache hit: the answer already attached to a match row for this
 * exact input, so an identical input never reaches the provider twice.
 */
async function loadStoredQualification(
  viewer: Viewer,
  leadId: string,
  inputHash: string,
): Promise<IcpQualification | null> {
  return withActor(viewer.actor, async (sql) => {
    const stored = await sql.query<{
      icp_id: string;
      match_score: number | null;
      intent_score: number | null;
      reasons: string[] | null;
      disqualifiers: string[] | null;
      recommended_angle: string | null;
      confidence: number | null;
    }>(
      `select m.icp_id, m.match_score, m.intent_score, m.reasons, m.disqualifiers,
              m.recommended_angle, m.confidence
         from public.lead_icp_matches m
        where m.lead_id = $1
          and m.input_hash = $2
        order by m.qualified_at desc nulls last
        limit 1`,
      [leadId, inputHash],
    );
    const row = stored.rows[0];
    if (row === undefined) return null;

    return {
      fit_score: Math.max(0, Math.min(100, Math.round(Number(row.match_score ?? 0)))),
      intent_score: Math.max(0, Math.min(100, Math.round(Number(row.intent_score ?? 0)))),
      icp_id: String(row.icp_id),
      reasons: row.reasons ?? [],
      disqualifiers: row.disqualifiers ?? [],
      recommended_angle: row.recommended_angle,
      confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 0))),
    };
  });
}

/** A one-line human summary for `lead_icp_matches.reason`, which is operator-facing text. */
function qualificationReason(qualification: IcpQualification): string {
  const parts = [`fit ${String(qualification.fit_score)}`, `intent ${String(qualification.intent_score)}`];
  const reason = qualification.reasons[0];
  if (isNonEmptyText(reason)) parts.push(reason.trim().slice(0, 300));
  return parts.join(' · ').slice(0, 500);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Runs the qualification and persists it.
 *
 * The persistence is one transaction after the model call: the audited primary-ICP
 * swap (only when the answer actually changes it), then the assessment on that
 * match row. A failure anywhere leaves the lead exactly as it was — no partial
 * score, no half-applied ICP — and is reported with a typed code and whether
 * retrying could help.
 */
export async function runLeadQualification(
  viewer: Viewer,
  input: {
    readonly leadId: string;
    readonly agentJobId?: string | null;
    readonly provider?: AiProvider;
  },
): Promise<QualificationOutcome> {
  const built = await buildQualificationInput(viewer, input.leadId);
  if (built === null) {
    return {
      ok: false,
      error: 'That lead could not be found.',
      errorCode: 'lead_not_found',
      retryable: false,
      runId: null,
    };
  }

  const readiness = qualificationPrerequisites(built.prerequisites);
  if (!readiness.ready) {
    // No provider call: there is nothing to score yet, and paying to be told so is
    // the wrong way round. Typed and non-retryable — the answer changes when the
    // facts do, and the chaining planner will create a new job then.
    return {
      ok: false,
      error: `This lead is not ready to be scored yet: ${readiness.missing.join(', ')}.`,
      errorCode: 'prerequisites_unmet',
      retryable: false,
      runId: null,
      missing: readiness.missing,
    };
  }

  const task = TASK_REGISTRY.ICP_QUALIFICATION;
  const outcome = await runAiTask<IcpQualification>(
    viewer,
    {
      businessId: built.businessId,
      task: 'ICP_QUALIFICATION',
      promptKey: task.promptKey,
      leadId: built.leadId,
      personId: built.personId,
      companyId: built.companyId,
      agentJobId: input.agentJobId ?? null,
    },
    {
      inputHash: built.inputHash,
      schema: task.schema,
      build: (prompt) => taskPrompt(task, built.taskInput, prompt),
      maxOutputTokens: task.maxOutputTokens,
      temperature: task.temperature,
      // The stored answer for this exact input is the cache materialisation: a
      // repeat costs nothing and writes a CACHED ledger row instead of a call.
      loadCached: async () => loadStoredQualification(viewer, built.leadId, built.inputHash),
      provider: input.provider,
    },
  );

  if (!outcome.ok) {
    return {
      ok: false,
      error: outcome.error,
      errorCode: outcome.errorCode,
      retryable: outcome.retryable,
      runId: outcome.runId,
    };
  }

  const qualification = outcome.data;
  const allowedIcpIds = new Set(built.criteria.map((entry) => entry.id));
  // A model may name an ICP from another business or invent one; neither may
  // become a primary ICP. The id is dropped, and the assessment is still recorded
  // on the lead's existing primary match rather than invented.
  const chosenIcpId =
    qualification.icp_id !== null && allowedIcpIds.has(qualification.icp_id) ? qualification.icp_id : null;

  try {
    const persisted = await withActor(viewer.actor, async (sql) => {
      let assignedPrimary = false;

      if (chosenIcpId !== null && chosenIcpId !== built.primaryIcpId) {
        // The audited domain function: it validates that the ICP belongs to this
        // business, swaps the single primary, updates `leads.primary_icp_id` and
        // writes the audit event. Nothing here writes `is_primary` directly.
        await sql.query(`select public.set_primary_icp($1, $2)`, [built.leadId, chosenIcpId]);
        assignedPrimary = true;
      }

      // The row the assessment belongs to: the chosen ICP when there is one,
      // otherwise the lead's existing primary match. With neither, there is no
      // match to score and the ledger row is the record of the attempt.
      const targetIcpId = chosenIcpId ?? built.primaryIcpId;
      if (targetIcpId !== null) {
        const updated = await sql.query(`update public.lead_icp_matches m
              set match_score = $3,
                  intent_score = $4,
                  reasons = $5::text[],
                  disqualifiers = $6::text[],
                  recommended_angle = $7,
                  confidence = $8,
                  ai_run_id = $9,
                  qualified_at = now(),
                  input_hash = $10,
                  reason = $11
            where m.lead_id = $1 and m.icp_id = $2`, [
          built.leadId,
          targetIcpId,
          qualification.fit_score,
          qualification.intent_score,
          qualification.reasons.slice(0, 12),
          qualification.disqualifiers.slice(0, 12),
          boundedText(qualification.recommended_angle, 600),
          qualification.confidence,
          outcome.runId,
          built.inputHash,
          qualificationReason(qualification),
        ]);

        /**
         * A lead can carry `primary_icp_id` without a matching row — an import, or
         * a hand-written fixture. The assessment would then be dropped, which is the
         * one outcome that is worse than a second statement: the model was paid for
         * an answer nobody can read. `set_primary_icp` is the audited path that
         * materialises the row, and it is idempotent for the ICP that is already
         * primary.
         */
        if ((updated.affectedRows ?? 0) === 0) {
          await sql.query(`select public.set_primary_icp($1, $2)`, [built.leadId, targetIcpId]);
          await sql.query(
            `update public.lead_icp_matches m
                set match_score = $3, intent_score = $4, reasons = $5::text[],
                    disqualifiers = $6::text[], recommended_angle = $7, confidence = $8,
                    ai_run_id = $9, qualified_at = now(), input_hash = $10, reason = $11
              where m.lead_id = $1 and m.icp_id = $2`,
            [
              built.leadId,
              targetIcpId,
              qualification.fit_score,
              qualification.intent_score,
              qualification.reasons.slice(0, 12),
              qualification.disqualifiers.slice(0, 12),
              boundedText(qualification.recommended_angle, 600),
              qualification.confidence,
              outcome.runId,
              built.inputHash,
              qualificationReason(qualification),
            ],
          );
        }
      }

      return { assignedPrimary, targetIcpId };
    });

    return {
      ok: true,
      leadId: built.leadId,
      icpId: persisted.targetIcpId,
      fitScore: qualification.fit_score,
      intentScore: qualification.intent_score,
      confidence: qualification.confidence,
      assignedPrimary: persisted.assignedPrimary,
      cached: outcome.cached,
      runId: outcome.runId,
      model: outcome.model,
      promptVersionId: outcome.promptVersionId,
    };
  } catch {
    // The model answered, so the ledger row already exists and is useful; the
    // write is what failed, and the lead is untouched.
    return {
      ok: false,
      error: 'The qualification could not be saved, so nothing was changed.',
      errorCode: 'commit_failed',
      retryable: true,
      runId: outcome.runId,
    };
  }
}
