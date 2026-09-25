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

import { deepSeekProvider } from '../ai/deepseek';
import { resolveProfileFields } from '../ai/drafting';
import { withActor, type Viewer } from '../actor';
import { describeDbError, type MutationResult } from './common';

export interface ProfileCaptureInput {
  readonly leadId: string;
  readonly linkedinUrl: string;
  readonly pastedContent: string;
}

export async function submitProfileCapture(
  viewer: Viewer,
  input: ProfileCaptureInput,
): Promise<MutationResult> {
  if (input.pastedContent.trim().length === 0) {
    return { ok: false, error: 'Paste the profile content before saving.' };
  }

  const normalized = normalizeLinkedInUrl(input.linkedinUrl);

  // Visibility is settled before the model is called. A capture for a lead the actor cannot see must
  // fail as "not found" without spending a request on extraction, and without echoing the RLS
  // policy name back to the operator. The read itself is wrapped because a denied row can surface as
  // an error rather than an empty result depending on the policy.
  const visible = await withActor(viewer.actor, async (sql) => {
    try {
      const lead = await sql.query<{ id: string }>(
        `select id from public.leads where id = $1 and deleted_at is null`,
        [input.leadId],
      );
      return lead.rows[0] !== undefined;
    } catch {
      return false;
    }
  });
  if (!visible) return { ok: false, error: 'That lead could not be found.' };

  // The model is used when one is configured, and the local extractor when it is not (or when the
  // model fails). Either way the raw text is kept as evidence, and the method that produced the
  // fields is written to the audit trail rather than assumed.
  const extraction = await resolveProfileFields(deepSeekProvider(), {
    pastedContent: input.pastedContent,
    linkedinUrl: normalized.canonicalUrl ?? input.linkedinUrl,
  });
  const extracted = extraction.fields;
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
      // Re-checked inside the write transaction: the lead could have been deleted or hidden between
      // the visibility check and this point.
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

      // Which extractor read this profile, and which model if any. Source evidence records *that*
      // something was observed; this records *how* it was turned into fields, which is the part that
      // would otherwise be unknowable after the fact.
      await sql.query(
        `select public.enqueue_audit(
           'lead', $1, 'profile_capture_extracted', $2, null,
           jsonb_build_object(
             'method', $3::text,
             'model', $4::text,
             'note', $5::text,
             'dropped_ungrounded', coalesce($6::jsonb, '[]'::jsonb),
             'fields', jsonb_build_object(
               'full_name', $7::text,
               'job_title', $8::text,
               'company', $9::text,
               'location', $10::text,
               'headline', $11::text
             )
           ),
           'companion'
         )`,
        [
          row.id,
          row.business_id,
          extraction.method,
          extraction.model,
          extraction.note,
          // Passed as JSON rather than a Postgres array literal: the value reaches the driver as a
          // plain string, and `to_jsonb` on a text parameter is not a cast the planner can perform.
          JSON.stringify(extraction.droppedUngrounded),
          extracted.fullName,
          extracted.jobTitle,
          extracted.company,
          extracted.location,
          extracted.headline,
        ],
      );

      return { ok: true, id: row.id, message: 'Profile captured. The existing lead was updated.' };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}
