/**
 * Profile capture — turning a partial lead into a complete one.
 *
 * spec `lead_sources.profile_queue_flow`: "Open search/profile, capture LinkedIn URL
 * + full copied profile data, update the existing partial lead rather than creating a
 * new lead."
 *
 * That "rather than" is the whole point of this module. Capture never inserts a
 * Person or a Lead; it fills in the one that already exists, records the raw capture
 * as source evidence with a content hash, and drains the profile queue.
 */
import 'server-only';

import { contentHash, normalizeLinkedInUrl, slugify } from '@nexus/core';

import { withActor, type Viewer } from '../actor';
import { describeDbError, type MutationResult } from './common';

export interface ProfileCaptureInput {
  readonly leadId: string;
  readonly linkedinUrl: string;
  readonly pastedContent: string;
}

/**
 * Best-effort extraction from the pasted profile text.
 *
 * Deliberately conservative: anything it cannot read confidently is left null rather
 * than guessed, because a fabricated headline would be indistinguishable from a real
 * one once stored. The raw text is always kept as evidence, so a later model-assisted
 * pass has something truthful to work from.
 */
function extractProfile(content: string): {
  readonly fullName: string | null;
  readonly jobTitle: string | null;
  readonly company: string | null;
  readonly location: string | null;
  readonly headline: string | null;
} {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const fullName = lines[0] !== undefined && lines[0].length <= 80 ? lines[0] : null;
  const headline = lines.find((line) => line.length >= 10 && line.length <= 200) ?? null;

  const split = headline === null ? null : /^(.*?)\s+at\s+(.*)$/i.exec(headline);
  const location =
    lines.find((line) => /^[A-Za-z .'-]+,\s*[A-Za-z .'-]+$/.test(line) && line.length <= 60) ?? null;

  return {
    fullName,
    jobTitle: split?.[1]?.trim() ?? null,
    company: split?.[2]?.trim() ?? null,
    location,
    headline,
  };
}

export async function submitProfileCapture(
  viewer: Viewer,
  input: ProfileCaptureInput,
): Promise<MutationResult> {
  if (input.pastedContent.trim().length === 0) {
    return { ok: false, error: 'Paste the profile content before saving.' };
  }

  const normalized = normalizeLinkedInUrl(input.linkedinUrl);
  const extracted = extractProfile(input.pastedContent);
  const hash = contentHash({ url: input.linkedinUrl, content: input.pastedContent });

  try {
    return await withActor(viewer.actor, async (sql) => {
      const lead = await sql.query<{
        id: string;
        business_id: string;
        person_id: string;
        company_id: string | null;
      }>(
        `select id, business_id, person_id, company_id from public.leads
          where id = $1 and deleted_at is null`,
        [input.leadId],
      );

      const row = lead.rows[0];
      // RLS already hides an inaccessible lead, so this is "not found" for the caller,
      // not "forbidden".
      if (row === undefined) return { ok: false, error: 'That lead could not be found.' };

      let companyId = row.company_id;
      if (extracted.company !== null) {
        const existing = await sql.query<{ id: string }>(
          `select id from public.companies where normalized_name = $1 limit 1`,
          [slugify(extracted.company)],
        );
        companyId = existing.rows[0]?.id ?? null;
        if (companyId === null) {
          const created = await sql.query<{ id: string }>(
            `insert into public.companies (name, normalized_name, created_by)
             values ($1, $2, $3) returning id`,
            [extracted.company, slugify(extracted.company), viewer.userId],
          );
          companyId = created.rows[0]?.id ?? null;
        }
      }

      // UPDATE the existing person — never insert a second one.
      await sql.query(
        `update public.people
            set full_name = coalesce($2, full_name),
                normalized_name = coalesce($3, normalized_name),
                job_title = coalesce($4, job_title),
                headline = coalesce($5, headline),
                location = coalesce($6, location),
                linkedin_url = $7,
                normalized_linkedin_url = coalesce($8, normalized_linkedin_url),
                company_id = coalesce($9, company_id),
                updated_at = now()
          where id = $1`,
        [
          row.person_id,
          extracted.fullName,
          extracted.fullName === null ? null : slugify(extracted.fullName),
          extracted.jobTitle,
          extracted.headline,
          extracted.location,
          input.linkedinUrl,
          normalized.canonicalUrl,
          companyId,
        ],
      );

      // Provenance, with the content hash that makes a re-capture a no-op.
      await sql.query(
        `insert into public.source_evidence
           (business_id, person_id, company_id, lead_id, source, source_url, raw_text_or_json,
            content_hash, observed_at, confidence, created_by)
         values ($1, $2, $3, $4, 'LinkedIn manual import', $5, $6, $7, now(), 0.85, $8)
         on conflict (business_id, content_hash) do nothing`,
        [
          row.business_id,
          row.person_id,
          companyId,
          row.id,
          normalized.canonicalUrl ?? input.linkedinUrl,
          input.pastedContent.slice(0, 100_000),
          hash,
          viewer.userId,
        ],
      );

      // The lead now has a full profile, so it leaves the queue and stops being partial.
      await sql.query(
        `update public.leads
            set needs_profile = false,
                company_id = coalesce($2, company_id),
                status = case when status = 'needs_profile' then 'ready' else status end,
                last_activity_at = now()
          where id = $1`,
        [row.id, companyId],
      );

      await sql.query(
        `update public.profile_capture_queue
            set state = 'captured', captured_at = now(), updated_at = now()
          where lead_id = $1 and state in ('pending', 'in_progress')`,
        [row.id],
      );

      await sql.query(
        `insert into public.interactions
           (business_id, lead_id, person_id, type, actor_user_id, direction, summary, source_client, occurred_at)
         values ($1, $2, $3, 'profile_capture', $4, 'internal', 'LinkedIn profile captured', 'companion', now())`,
        [row.business_id, row.id, row.person_id, viewer.userId],
      );

      return { ok: true, id: row.id, message: 'Profile captured. The existing lead was updated.' };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}
