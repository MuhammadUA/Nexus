/**
 * POST /api/v1/companion/add — manual capture from the Companion.
 *
 * spec `companion_extension.add_to_crm.process`:
 *   parse profile -> identify canonical person/company -> dedupe -> create/update
 *   canonical entities -> create/update business lead -> qualify -> research ->
 *   sequence/message readiness.
 *
 * Two capture shapes are accepted, because V1.2 accepts a lead the moment anything
 * is known about it (spec `lead_sources` / `minimalLeadInputSchema`):
 *
 *   1. **A LinkedIn profile capture** — a profile URL plus whatever the operator
 *      copied. The strongest key available, so dedupe runs on the normalized URL.
 *   2. **A minimal lead** — person name, company name, location and source, with an
 *      optional job title, headline and snippet. No URL is required and nothing is
 *      invented to fill the gaps: an absent field stays absent and is reported as a
 *      missing enrichment field, which is what sends it to `NEEDS_PROFILE`.
 *
 * Dedupe is still not optional: the canonical Person is reused when either key
 * matches, so a second capture updates the record instead of forking it. The
 * `leads` trigger (0031) creates the `lead_enrichment` row, so a partial capture
 * lands in `NEEDS_PROFILE` and is queued for the profile pipeline rather than being
 * treated as complete.
 */
import { z } from 'zod';

import {
  contentHash,
  matchIcps,
  minimalLeadInputSchema,
  normalizeLinkedInUrl,
  searchLinks,
  slugify,
  type IcpCriterionFields,
  type IcpLike,
} from '@nexus/core';

import { loadViewer, withActor } from '@/lib/actor';

import { authorizeUser, jsonError, jsonOk, parseBody } from '../../_lib/http';

export const dynamic = 'force-dynamic';

const addSchema = z.object({
  /** Shape 1: the profile being captured. Absent for a minimal lead. */
  linkedinUrl: z.string().trim().min(4).max(500).optional(),
  pastedContent: z.string().max(200_000).default(''),
  businessId: z.string().uuid(),
  /**
   * Shape 1's Primary ICP. Optional: a V1.2 caller may supply neither the ICP nor
   * `autoMatch`, and the server then matches the configured criteria itself rather
   * than refusing an otherwise usable lead.
   */
  icpId: z.string().uuid().nullable().optional(),
  autoMatch: z.boolean().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  identityId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().trim().min(4).max(200),
  /**
   * Shape 2: the minimal lead. Field names match the wire format the extension
   * sends; the bounds are re-asserted by `minimalLeadInputSchema` below so this
   * route cannot drift from the shared contract.
   */
  fullName: z.string().trim().min(1).max(200).optional(),
  companyName: z.string().trim().min(1).max(300).optional(),
  location: z.string().trim().min(1).max(200).optional(),
  source: z.string().trim().min(1).max(120).optional(),
  sourceUrl: z.string().trim().max(2048).optional(),
  jobTitle: z.string().trim().min(1).max(300).optional(),
  headline: z.string().trim().min(1).max(1000).optional(),
  snippet: z.string().trim().max(4000).optional(),
  companyDomain: z.string().trim().max(300).optional(),
});

/** Best-effort extraction from pasted profile text. Never trusted as fact. */
function extractFields(content: string): { fullName: string | null; jobTitle: string | null; company: string | null } {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const fullName = lines[0] !== undefined && lines[0].length <= 80 ? lines[0] : null;
  const headline = lines.find((line) => / at /i.test(line) && line.length <= 140) ?? null;
  const parts = headline === null ? [] : headline.split(/ at /i);
  return {
    fullName,
    jobTitle: parts[0]?.trim() ?? null,
    company: parts[1]?.trim() ?? null,
  };
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authorizeUser(request);
  if (!auth.ok) return auth.response;

  const parsed = await parseBody(request, addSchema);
  if (!parsed.ok) return parsed.response;

  const input = parsed.data;
  // `.default('')` leaves the *input* type optional, so narrow it once here rather
  // than sprinkling `?? ''` at each use.
  const pastedContent: string = input.pastedContent ?? '';
  const hasLinkedInInput = typeof input.linkedinUrl === 'string' && input.linkedinUrl.trim().length > 0;

  /**
   * The minimal shape is validated by the shared contract when no profile URL is
   * supplied.
   *
   * `minimalLeadInputSchema` is the one definition of "enough to make a lead", so
   * the bounds and the required field are read from it rather than restated here.
   * A caller who sends neither a URL nor a name gets a specific refusal code —
   * inventing an "Unknown" person is what this branch exists to prevent.
   */
  if (!hasLinkedInInput) {
    const minimal = minimalLeadInputSchema.safeParse({
      full_name: input.fullName,
      company_name: input.companyName,
      location: input.location,
      source: input.source,
      source_url: input.sourceUrl,
      job_title: input.jobTitle,
      headline: input.headline,
      snippet: input.snippet,
      company_domain: input.companyDomain,
    });
    if (!minimal.success) {
      return jsonError(
        'A person name is required to add a lead without a LinkedIn profile URL.',
        400,
        { reason: 'minimal_lead_incomplete' },
      );
    }
  }

  const normalized = hasLinkedInInput ? normalizeLinkedInUrl(input.linkedinUrl) : null;
  const extracted = extractFields(pastedContent);

  /**
   * Only a LinkedIn *profile* URL may create a person by URL.
   *
   * `normalizeLinkedInUrl` is deliberately permissive — the database's companion normalizer strips
   * any scheme and leading `www.`/locale prefix, so `https://example.com/in/anything` normalizes to a
   * non-null key and would have been stored as a Person with a URL that is not a LinkedIn profile.
   * The route's job is to accept a profile and nothing else.
   *
   * The check reads the parsed result rather than re-testing the string: `host` is the canonical host
   * the normalizer settled on (`linkedin.com`), `memberSlug` is the profile handle it extracted, and
   * `isLinkedInButUnparsed` is false only when the URL really was a parseable profile. Re-parsing here
   * is how the first attempt at this check rejected `https://www.linkedin.com/in/<slug>` — its
   * pattern allowed a two-letter locale prefix and forgot `www.`. `lnkd.in` short links are excluded
   * because they cannot be resolved offline and are therefore not a dedupe key.
   */
  if (normalized !== null) {
    const isLinkedInProfile =
      normalized.isLinkedInButUnparsed === false &&
      normalized.memberSlug !== null &&
      normalized.host === 'linkedin.com';
    if (!isLinkedInProfile) {
      return jsonError('That is not a LinkedIn profile URL, so nothing was saved.', 400, {
        reason: 'not_a_linkedin_profile',
      });
    }
  }

  /**
   * Explicit fields win over anything guessed from the pasted text, and a field
   * nobody supplied stays null. That is the whole "do not invent missing data"
   * rule: extraction fills a gap, it never manufactures a value.
   */
  const canonical = normalized?.canonicalUrl ?? null;
  const fullName = input.fullName ?? extracted.fullName;
  const companyName = input.companyName ?? extracted.company;
  const jobTitle = input.jobTitle ?? extracted.jobTitle;
  const headline = input.headline ?? null;
  const location = input.location ?? null;
  const companyDomain = input.companyDomain ?? null;
  const sourceUrl = input.sourceUrl ?? canonical ?? input.linkedinUrl ?? null;
  const evidenceSource = input.source ?? (hasLinkedInInput ? 'LinkedIn manual import' : 'Companion minimal capture');

  const viewer = await loadViewer(auth.context.actor);

  try {
    const result = await withActor(auth.context.actor, async (sql) => {
      // Idempotency: the same capture retried must not create a second lead.
      const prior = await sql.query<{ result: unknown }>(
        `select result from public.ingest_requests
          where source_client = 'companion' and business_id = $1 and idempotency_key = $2
          limit 1`,
        [input.businessId, input.idempotencyKey],
      );
      const priorResult = prior.rows[0]?.result;
      if (typeof priorResult === 'object' && priorResult !== null) {
        const finished = priorResult as { leadId?: unknown };
        if (typeof finished.leadId === 'string') {
          return {
            leadId: finished.leadId,
            created: false,
            needsProfile: false,
            deduped: true,
            enrichmentStatus: await readEnrichmentStatus(sql, finished.leadId),
            findLinkedInUrl: findLinkedInUrlFor(fullName, companyName, location, canonical ?? input.linkedinUrl ?? null),
          };
        }
      }

      // Dedupe on the strongest key available: the normalized LinkedIn URL.
      let personId: string | null = null;

      if (canonical !== null) {
        // Through the helper, not a direct select: `people`'s RLS policy is `person_visible`, which
        // is false for a Person this actor captured but cannot yet see a Lead for — so a direct read
        // found nothing and the following insert hit `people_normalized_linkedin_key`. Dedupe is a
        // data-integrity question and belongs on the same key the index uses.
        const existing = await sql.query<{ id: string | null }>(
          `select public.find_person_id_by_linkedin_url($1) as id`,
          [canonical],
        );
        personId = existing.rows[0]?.id ?? null;
      }

      if (personId === null && fullName !== null) {
        // Fallback: name + company, which is the documented weaker key.
        const byName = await sql.query<{ id: string }>(
          `select p.id
             from public.people p
             left join public.companies c on c.id = p.company_id
            where p.normalized_name = $1
              and ($2::text is null or c.normalized_name = $2)
            limit 1`,
          [slugify(fullName), companyName === null ? null : slugify(companyName)],
        );
        personId = byName.rows[0]?.id ?? null;
      }

      const personExisted = personId !== null;

      /**
       * Canonical rows are resolved through the ingestion boundary, not inserted here.
       *
       * `companies` and `people` are global rows whose SELECT policy (`company_visible` /
       * `person_visible`) is derived from an existing lead in a visible business. During
       * ingestion the canonical row must exist *before* that lead does, so a plain
       * `insert ... returning id` cannot satisfy the SELECT policy it triggers — a
       * permissioned operator adding a lead for a company nobody has captured yet was
       * refused with "new row violates row-level security policy for table companies".
       * Migration 0028 exists for exactly this: `nexus_resolve_or_create_*` are SECURITY
       * DEFINER, capability-checked, race-safe on the LinkedIn-URL and domain uniqueness
       * keys, and are the same boundary `repo/ingest.ts` and the MCP minimal-lead path use.
       *
       * The visibility-filtered lookup stays as a fast path; the helper is what makes it
       * correct when the row exists but is not yet visible to this actor.
       */
      let companyId: string | null = null;
      if (companyName !== null) {
        const normalizedCompany = slugify(companyName);
        const existingCompany = await sql.query<{ id: string }>(
          `select id from public.companies where normalized_name = $1 limit 1`,
          [normalizedCompany],
        );
        companyId = existingCompany.rows[0]?.id ?? null;
        if (companyId === null) {
          const created = await sql.query<{ id: string }>(
            `select public.nexus_resolve_or_create_company($1, $2, $3, $4, $5) as id`,
            [
              input.businessId,
              companyName,
              normalizedCompany,
              companyDomain === null ? null : companyDomain.toLowerCase().replace(/^www\./, ''),
              viewer.userId,
            ],
          );
          companyId = created.rows[0]?.id ?? null;
        }
      }

      if (personId === null) {
        const created = await sql.query<{ id: string }>(
          `select public.nexus_resolve_or_create_person($1, $2, $3, $4, $5, $6, $7, $8) as id`,
          [
            input.businessId,
            fullName ?? 'Unknown (needs profile)',
            slugify(fullName ?? 'unknown'),
            jobTitle,
            location,
            canonical,
            headline,
            viewer.userId,
          ],
        );
        personId = created.rows[0]?.id ?? null;
      } else if (personExisted) {
        /**
         * A person we already had: fill only the facts that were missing.
         *
         * `coalesce(existing, new)` and never the reverse — a later capture may know
         * less than the record does, and a weaker observation must not overwrite a
         * stronger one. This is also how a minimal lead becomes a little less minimal
         * on the second sighting without any of its fields being invented.
         */
        await sql.query(
          `update public.people
              set job_title = coalesce(job_title, $2),
                  headline = coalesce(headline, $3),
                  location = coalesce(location, $4),
                  company_id = coalesce(company_id, $5),
                  linkedin_url = coalesce(linkedin_url, $6),
                  normalized_linkedin_url = coalesce(normalized_linkedin_url, $7)
            where id = $1
              and (
                ($2::text is not null and job_title is null)
                or ($3::text is not null and headline is null)
                or ($4::text is not null and location is null)
                or ($5::uuid is not null and company_id is null)
                or ($6::text is not null and linkedin_url is null)
                or ($7::text is not null and normalized_linkedin_url is null)
              )`,
          [personId, jobTitle, headline, location, companyId, input.linkedinUrl ?? null, canonical],
        );
      }

      if (personId !== null && companyId !== null) {
        /**
         * The person↔company link, made once and only when it is missing.
         *
         * `nexus_resolve_or_create_person` has no company parameter — it is the canonical
         * *person* boundary — so the link is established here, exactly as
         * `repo/ingest.ts` does it. `coalesce(company_id, $2)` means a person already
         * attributed to a company keeps it.
         */
        await sql.query(
          `update public.people set company_id = coalesce(company_id, $2) where id = $1 and company_id is null`,
          [personId, companyId],
        );
      }

      if (personId === null) throw new Error('The person record could not be created.');

      /**
       * A capture that does not identify the person's profile is partial.
       *
       * No LinkedIn URL at all is the strongest form of "partial": the profile
       * pipeline has nothing to fetch, so the lead is `NEEDS_PROFILE` (the
       * `leads` trigger in 0031 writes exactly that enrichment state). A URL without a
       * company or title is partial in the older sense and keeps its existing meaning.
       */
      const needsProfile = canonical === null || companyName === null || jobTitle === null;

      // Auto-match when the caller supplied neither an ICP nor an explicit flag: the
      // V1.2 contract is that the server derives ICP matching rather than refusing.
      const autoMatch = input.autoMatch ?? (input.icpId === null || input.icpId === undefined);
      const primaryIcpId = autoMatch
        ? await autoMatchIcp(sql, input.businessId, { jobTitle, company: companyName })
        : (input.icpId ?? null);

      // One active lead per (business, person): reuse the existing one if present.
      const existingLead = await sql.query<{ id: string; deleted_at: string | null }>(
        `select id, deleted_at from public.leads where business_id = $1 and person_id = $2 limit 1`,
        [input.businessId, personId],
      );

      let leadId: string;
      let created = false;

      const lead = existingLead.rows[0];
      if (lead !== undefined) {
        leadId = lead.id;
        if (lead.deleted_at !== null) {
          await sql.query(`update public.leads set deleted_at = null, status = 'new' where id = $1`, [leadId]);
        } else {
          await sql.query(
            `update public.leads
                set last_activity_at = now(), needs_profile = needs_profile or $2
              where id = $1`,
            [leadId, needsProfile],
          );
        }
      } else {
        const inserted = await sql.query<{ id: string }>(
          `insert into public.leads
             (business_id, person_id, company_id, primary_icp_id, owner_user_id, outreach_identity_id,
              status, source_type, source_url, needs_profile, created_by, last_activity_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'manual_companion', $8, $9, $10, now())
           returning id`,
          [
            input.businessId,
            personId,
            companyId,
            primaryIcpId,
            input.ownerUserId ?? null,
            input.identityId ?? null,
            needsProfile ? 'needs_profile' : 'ready',
            sourceUrl,
            needsProfile,
            viewer.userId,
          ],
        );
        leadId = inserted.rows[0]?.id ?? '';
        if (leadId.length === 0) throw new Error('The lead could not be created.');
        created = true;

        if (primaryIcpId !== null) {
          await sql.query(
            `insert into public.lead_icp_matches (lead_id, icp_id, is_primary, match_score, reason)
             values ($1, $2, true, null, 'Companion manual capture')
             on conflict (lead_id, icp_id) do update set is_primary = true`,
            [leadId, primaryIcpId],
          );
        }

        if (needsProfile) {
          await sql.query(
            `insert into public.profile_capture_queue (business_id, lead_id, person_id, state, reason)
             values ($1, $2, $3, 'pending', 'companion capture was partial')
             on conflict do nothing`,
            [input.businessId, leadId, personId],
          );
        }
      }

      // Provenance: the pasted content (or the supplied snippet) is stored as evidence
      // with a content hash, and is treated as untrusted text everywhere it is later
      // rendered. A minimal lead has no pasted body, so the snippet is the evidence.
      const evidenceText = pastedContent.length > 0 ? pastedContent : (input.snippet ?? '');
      /**
       * The evidence dedupe key.
       *
       * `source_evidence` is unique on `(business_id, content_hash)`, so the key must
       * distinguish two captures that are genuinely different. A profile capture keeps
       * the URL it was taken from — exactly what this route hashed before. A minimal
       * lead has no URL, and hashing "no url + no body" would collapse every minimal
       * capture in a business onto one evidence row, so it is keyed on the person
       * instead: one evidence row per person per observation text.
       */
      const evidenceKey = input.linkedinUrl ?? sourceUrl ?? `person:${personId}`;
      await sql.query(
        `insert into public.source_evidence
           (business_id, person_id, company_id, lead_id, source, source_url, raw_text_or_json, content_hash, observed_at, confidence, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10)
         on conflict (business_id, content_hash) do nothing`,
        [
          input.businessId,
          personId,
          companyId,
          leadId,
          evidenceSource,
          sourceUrl,
          evidenceText.slice(0, 100_000),
          contentHashOf(evidenceKey, evidenceText),
          needsProfile ? 0.4 : 0.7,
          viewer.userId,
        ],
      );

      /**
       * The ingestion log, written in the same transaction as the lead.
       *
       * `ingest_requests_status_check` allows `received`, `processed`, `failed` and `duplicate` — not
       * `completed`, which this insert used to write. Because the log row is part of the same
       * transaction as the lead, that check violation rolled the whole capture back: every "Add to
       * CRM" from the Companion failed with "The capture could not be saved." and created nothing.
       * The vocabulary is used verbatim now.
       */
      const ingestStatus = created ? 'processed' : 'duplicate';
      const enrichmentStatus = await readEnrichmentStatus(sql, leadId);

      await sql.query(
        `insert into public.ingest_requests
           (source_client, business_id, payload_type, idempotency_key, observed_at, payload, content_hash, status, result)
         values ('companion', $1, 'candidate', $2, now(), $3::jsonb, $4, $5, $6::jsonb)
         on conflict (source_client, business_id, idempotency_key) do nothing`,
        [
          input.businessId,
          input.idempotencyKey,
          JSON.stringify({
            linkedinUrl: input.linkedinUrl ?? null,
            fullName,
            companyName,
            location,
            source: evidenceSource,
            hasContent: pastedContent.length > 0,
          }),
          contentHashOf(evidenceKey, evidenceText),
          ingestStatus,
          JSON.stringify({ leadId, created, needsProfile, enrichmentStatus }),
        ],
      );

      return {
        leadId,
        created,
        needsProfile,
        deduped: !created && lead !== undefined,
        enrichmentStatus,
        findLinkedInUrl: findLinkedInUrlFor(fullName, companyName, location, canonical ?? input.linkedinUrl ?? null),
      };
    });

    return jsonOk(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The capture could not be saved.';
    /**
     * A capability refusal is a decision, not a malformed capture.
     *
     * `nexus_resolve_or_create_*` raises `42501` when the actor may not create canonical
     * rows in this business (no `can_use_lead_sources`, and not an administrator or a
     * scoped token). Reporting that as `400 Bad Request` told the panel the payload was
     * wrong; it is a permission answer, so it keeps its own status and carries the
     * database's operator-facing sentence.
     */
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '42501') {
      return jsonError(message, 403, { reason: 'not_permitted' });
    }
    return jsonError(message, 400);
  }
}

/**
 * The enrichment state the pipeline recorded for this lead.
 *
 * Read, never derived: the `leads` trigger in 0031 writes the row, and a lead with no
 * row at all is reported as `MINIMAL` — the same default the read models use.
 */
async function readEnrichmentStatus(
  sql: {
    query: <T extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) => Promise<{ rows: T[] }>;
  },
  leadId: string,
): Promise<string> {
  const result = await sql.query<{ status: string }>(
    `select status from public.lead_enrichment where lead_id = $1`,
    [leadId],
  );
  const status = result.rows[0]?.status;
  return typeof status === 'string' && status.length > 0 ? status : 'MINIMAL';
}

/**
 * The deterministic "Find LinkedIn" Google URL returned with the lead.
 *
 * Built by `searchLinks` in `@nexus/core` — the same function the enrichment pipeline
 * uses — so the panel never grows a second search-URL implementation that could
 * disagree about how to find the person it is showing.
 */
function findLinkedInUrlFor(
  fullName: string | null,
  companyName: string | null,
  location: string | null,
  linkedinUrl: string | null,
): string | null {
  const link = searchLinks({ fullName, companyName, location, linkedinUrl }).find(
    (entry) => entry.key === 'find_linkedin',
  );
  return link?.url ?? null;
}

function contentHashOf(url: string | undefined, content: string): string {
  // Shared with the web import path so the same capture hashes identically whether it
  // arrived from the browser app or the panel.
  return contentHash({ url: url ?? '', content });
}

/**
 * Auto-match the Primary ICP using the configured criteria.
 *
 * Scores come from configuration (`icps.criteria`) — never from product constants —
 * and a Lead still ends up with exactly one Primary ICP.
 */
async function autoMatchIcp(
  sql: {
    query: <T extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) => Promise<{ rows: T[] }>;
  },
  businessId: string,
  extracted: { jobTitle: string | null; company: string | null },
): Promise<string | null> {
  const icps = await sql.query<{ id: string; name: string; criteria: unknown; is_default: boolean }>(
    `select id, name, criteria, is_default from public.icps
      where business_id = $1 and deleted_at is null and is_active
      order by is_default desc, name`,
    [businessId],
  );

  // `IcpLike` requires `business_id`, and `matchIcps` expects `criteria` in the
  // documented criterion shape — both are satisfied explicitly rather than cast.
  const candidates: readonly IcpLike[] = icps.rows.map((row) => ({
    id: row.id,
    business_id: businessId,
    name: row.name,
    criteria:
      typeof row.criteria === 'object' && row.criteria !== null
        ? (row.criteria as IcpCriterionFields)
        : null,
    is_default: row.is_default,
  }));

  const matches = matchIcps(
    { jobTitle: extracted.jobTitle, companyName: extracted.company },
    candidates,
  );

  return matches[0]?.icpId ?? icps.rows[0]?.id ?? null;
}
