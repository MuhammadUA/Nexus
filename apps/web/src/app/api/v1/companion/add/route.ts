/**
 * POST /api/v1/companion/add ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â manual LinkedIn capture from the Companion.
 *
 * spec `companion_extension.add_to_crm.process`:
 *   parse profile -> identify canonical person/company -> dedupe -> create/update
 *   canonical entities -> create/update business lead -> qualify -> research ->
 *   sequence/message readiness.
 *
 * The dedupe step is not optional: this handler normalizes the LinkedIn URL and
 * reuses an existing Person, so a capture of somebody already in the CRM updates that
 * record instead of creating a second lead. Partial captures become `needs_profile`
 * and are queued rather than being treated as complete.
 */
import { z } from 'zod';

import { contentHash, matchIcps, normalizeLinkedInUrl, slugify, type IcpCriterionFields, type IcpLike } from '@nexus/core';

import { loadViewer, withActor } from '@/lib/actor';

import { authorizeUser, jsonError, jsonOk, parseBody } from '../../_lib/http';

export const dynamic = 'force-dynamic';

const addSchema = z.object({
  linkedinUrl: z.string().trim().min(4).max(500),
  pastedContent: z.string().max(200_000).default(''),
  businessId: z.string().uuid(),
  icpId: z.string().uuid().nullable(),
  autoMatch: z.boolean(),
  ownerUserId: z.string().uuid().nullable().optional(),
  identityId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().trim().min(4).max(200),
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
  const normalized = normalizeLinkedInUrl(input.linkedinUrl);
  const extracted = extractFields(pastedContent);

  /**
   * Only a LinkedIn *profile* URL may create a person.
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
  const isLinkedInProfile =
    normalized.isLinkedInButUnparsed === false &&
    normalized.memberSlug !== null &&
    normalized.host === 'linkedin.com';
  if (!isLinkedInProfile) {
    return jsonError('That is not a LinkedIn profile URL, so nothing was saved.', 400, {
      reason: 'not_a_linkedin_profile',
    });
  }

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
          return { leadId: finished.leadId, created: false, needsProfile: false, deduped: true };
        }
      }

      // Dedupe on the strongest key available: the normalized LinkedIn URL.
      const canonical = normalized.canonicalUrl;
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

      if (personId === null && extracted.fullName !== null) {
        // Fallback: name + company, which is the documented weaker key.
        const byName = await sql.query<{ id: string }>(
          `select p.id
             from public.people p
             left join public.companies c on c.id = p.company_id
            where p.normalized_name = $1
              and ($2::text is null or c.normalized_name = $2)
            limit 1`,
          [slugify(extracted.fullName), extracted.company === null ? null : slugify(extracted.company)],
        );
        personId = byName.rows[0]?.id ?? null;
      }

      let companyId: string | null = null;
      if (extracted.company !== null) {
        const existingCompany = await sql.query<{ id: string }>(
          `select id from public.companies where normalized_name = $1 limit 1`,
          [slugify(extracted.company)],
        );
        companyId = existingCompany.rows[0]?.id ?? null;
        if (companyId === null) {
          const created = await sql.query<{ id: string }>(
            `insert into public.companies (name, normalized_name, created_by)
             values ($1, $2, $3) returning id`,
            [extracted.company, slugify(extracted.company), viewer.userId],
          );
          companyId = created.rows[0]?.id ?? null;
        }
      }

      if (personId === null) {
        const created = await sql.query<{ id: string }>(
          `insert into public.people (full_name, normalized_name, job_title, linkedin_url, normalized_linkedin_url, company_id, created_by)
           values ($1, $2, $3, $4, $5, $6, $7)
           returning id`,
          [
            extracted.fullName ?? 'Unknown (needs profile)',
            slugify(extracted.fullName ?? 'unknown'),
            extracted.jobTitle,
            input.linkedinUrl,
            canonical,
            companyId,
            viewer.userId,
          ],
        );
        personId = created.rows[0]?.id ?? null;
      }

      if (personId === null) throw new Error('The person record could not be created.');

      // A capture without a company or a job title is partial: it goes to the profile
      // queue rather than being treated as a complete lead.
      const needsProfile = extracted.company === null || extracted.jobTitle === null;

      const primaryIcpId = input.autoMatch ? await autoMatchIcp(sql, input.businessId, extracted) : input.icpId;

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
            input.linkedinUrl,
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

      // Provenance: the pasted content is stored as evidence with a content hash, and
      // is treated as untrusted text everywhere it is later rendered.
      await sql.query(
        `insert into public.source_evidence
           (business_id, person_id, company_id, lead_id, source, source_url, raw_text_or_json, content_hash, observed_at, confidence, created_by)
         values ($1, $2, $3, $4, 'LinkedIn manual import', $5, $6, $7, now(), $8, $9)
         on conflict (business_id, content_hash) do nothing`,
        [
          input.businessId,
          personId,
          companyId,
          leadId,
          canonical ?? input.linkedinUrl,
          pastedContent.slice(0, 100_000),
          contentHashOf(input.linkedinUrl, pastedContent),
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

      await sql.query(
        `insert into public.ingest_requests
           (source_client, business_id, payload_type, idempotency_key, observed_at, payload, content_hash, status, result)
         values ('companion', $1, 'candidate', $2, now(), $3::jsonb, $4, $5, $6::jsonb)
         on conflict (source_client, business_id, idempotency_key) do nothing`,
        [
          input.businessId,
          input.idempotencyKey,
          JSON.stringify({ linkedinUrl: input.linkedinUrl, hasContent: pastedContent.length > 0 }),
          contentHashOf(input.linkedinUrl, pastedContent),
          ingestStatus,
          JSON.stringify({ leadId, created, needsProfile }),
        ],
      );

      return { leadId, created, needsProfile, deduped: !created && lead !== undefined };
    });

    return jsonOk(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The capture could not be saved.';
    return jsonError(message, 400);
  }
}

function contentHashOf(url: string, content: string): string {
  // Shared with the web import path so the same capture hashes identically whether it
  // arrived from the browser app or the panel.
  return contentHash({ url, content });
}

/**
 * Auto-match the Primary ICP using the configured criteria.
 *
 * Scores come from configuration (`icps.criteria`) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â never from product constants ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
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
