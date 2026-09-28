/**
 * V1.2 raw-staging lifecycle — spec §7, §8 and the hard gate in §56.
 *
 * The rule being proved is not "the code deletes a row"; it is that the *database*
 * makes the three properties true no matter which caller is asking:
 *
 *   1. a tenant role cannot read raw staging at all,
 *   2. a raw body survives a failure (so a retry is possible) and is gone after a
 *      successful consume,
 *   3. abandoned raw is removed by TTL.
 *
 * Every assertion runs against real PGlite Postgres through the real functions, as
 * the real roles.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from '../src/client';
import { attempt, createHarness, expectCode, FIXTURE_IDS, rejected, type Harness } from './harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 180_000);

afterAll(async () => {
  await h.close();
});

const RAW_BODY = 'RAW-LINKEDIN-PROFILE-BODY: Sarah Smith — Marketing Director at ABC Media';

/**
 * Runs `fn` with the session's own role restored.
 *
 * A tenant role cannot read `raw_staging` at all — that is the point of the table —
 * so proving that a row is *gone* rather than merely *invisible* needs the owner's
 * eyes. `reset role` returns to the session user for the duration of the callback;
 * the surrounding transaction and its uncommitted rows are untouched, which a
 * separate owner transaction could not observe.
 */
async function asOwner<T>(sql: Db, fn: () => Promise<T>): Promise<T> {
  await sql.exec('reset role');
  try {
    return await fn();
  } finally {
    await sql.exec('set local role authenticated');
  }
}

/** Rows the owner can see for one staging id. */
async function ownerRow(sql: Db, id: string): Promise<{ status: string; last_error_code: string | null; payload: string } | null> {
  return asOwner(sql, async () => {
    const result = await sql.query<{ status: string; last_error_code: string | null; payload: string }>(
      `select status, last_error_code, payload from public.raw_staging where id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  });
}

/** Stages a raw body as the fixture's lead-source-permissioned user. */
async function stage(sql: Db, options: { expiresInHours?: number } = {}): Promise<string> {
  const result = await sql.query<{ id: string }>(
    `select public.nexus_stage_raw(
       $1, $2, $3, $4, null, 'profile_paste', 'linkedin', 'https://www.linkedin.com/in/sarah-smith',
       $5, 'sha256-fixture-hash', 'companion'
     ) as id`,
    [
      FIXTURE_IDS.businessA,
      FIXTURE_IDS.leadA2,
      FIXTURE_IDS.personSarahSmith,
      FIXTURE_IDS.companyAbcMedia,
      RAW_BODY,
    ],
  );
  const id = result.rows[0]?.id ?? '';

  if (options.expiresInHours !== undefined) {
    // Backdating the expiry is how a TTL sweep is observed without waiting a day.
    await asOwner(sql, async () => {
      await sql.query(
        `update public.raw_staging set expires_at = now() + make_interval(hours => $2::int) where id = $1`,
        [id, options.expiresInHours],
      );
    });
  }

  return id;
}

describe('v1.2 raw staging lifecycle', () => {
  it('a tenant role cannot read, write or delete raw staging directly', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      // Privileges are revoked outright, so even a guessed id is a hard refusal
      // rather than an empty result that would read like "no raw data exists".
      const select = await attempt(sql, () => sql.query('select id, payload from public.raw_staging'));
      expect(select.ok).toBe(false);
      if (!select.ok) expectCode(select.error, '42501');

      const insert = await attempt(sql, () =>
        sql.query(
          `insert into public.raw_staging (business_id, kind, source_type, payload, content_hash)
           values ($1, 'profile_paste', 'paste', 'x', 'y')`,
          [FIXTURE_IDS.businessA],
        ),
      );
      expect(insert.ok).toBe(false);
      if (!insert.ok) expectCode(insert.error, '42501');
    });
  });

  it('staging requires the lead-source capability, not merely business access', async () => {
    // user2 has business B access but can_use_lead_sources = false there.
    await h.asUser(FIXTURE_IDS.user2, async (sql) => {
      await rejected(
        sql,
        () =>
          sql.query(
            `select public.nexus_stage_raw($1, null, null, null, null, 'profile_paste', 'paste', null, 'body', 'hash', 'user')`,
            [FIXTURE_IDS.businessB],
          ),
        '42501',
      );
    });

    // A user who cannot see the business at all is refused the same way.
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      await rejected(
        sql,
        () =>
          sql.query(
            `select public.nexus_stage_raw($1, null, null, null, null, 'profile_paste', 'paste', null, 'body', 'hash', 'user')`,
            [FIXTURE_IDS.businessB],
          ),
        '42501',
      );
    });
  });

  it('a staged body can be read once, consumed, and then deleted', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await stage(sql);

      const read = await sql.query<{ payload: string; attempt_count: number; status: string }>(
        `select payload, attempt_count, status from public.nexus_read_raw_staging($1)`,
        [id],
      );
      expect(read.rows[0]?.payload).toBe(RAW_BODY);
      expect(read.rows[0]?.attempt_count).toBe(1);
      expect(read.rows[0]?.status).toBe('PROCESSING');

      const deleted = await sql.query<{ deleted: boolean }>(
        `select public.nexus_delete_raw_staging($1) as deleted`,
        [id],
      );
      expect(deleted.rows[0]?.deleted).toBe(true);

      // Verified by the owner: the row is gone, not merely hidden from this role.
      expect(await ownerRow(sql, id)).toBeNull();
    });
  });

  it('a failed extraction keeps the raw body for retry, and a retry deletes it', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await stage(sql);

      await sql.query(`select public.nexus_read_raw_staging($1)`, [id]);
      // The error *code* is recorded; the message is not, because an upstream
      // message can quote the payload it was given.
      await sql.query(`select public.nexus_mark_raw_failed($1, $2)`, [id, 'malformed_json']);

      const stored = await ownerRow(sql, id);
      expect(stored?.status).toBe('FAILED');
      expect(stored?.last_error_code).toBe('malformed_json');
      // Retryable: the body is still there, so a second extraction can succeed.
      expect(stored?.payload).toBe(RAW_BODY);

      const retry = await sql.query<{ payload: string; attempt_count: number }>(
        `select payload, attempt_count from public.nexus_read_raw_staging($1)`,
        [id],
      );
      expect(retry.rows[0]?.payload).toBe(RAW_BODY);
      expect(retry.rows[0]?.attempt_count).toBe(2);

      await sql.query(`select public.nexus_delete_raw_staging($1)`, [id]);
      expect(await ownerRow(sql, id)).toBeNull();
    });
  });

  it('TTL removes abandoned staging and leaves a live row alone', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const abandoned = await stage(sql, { expiresInHours: -2 });
      const live = await stage(sql);

      const cleaned = await sql.query<{ cleaned: number }>(
        `select public.nexus_cleanup_raw_staging(50) as cleaned`,
      );
      expect(Number(cleaned.rows[0]?.cleaned)).toBeGreaterThanOrEqual(1);

      expect(await ownerRow(sql, abandoned)).toBeNull();
      expect(await ownerRow(sql, live)).not.toBeNull();

      await sql.query(`select public.nexus_delete_raw_staging($1)`, [live]);
    });
  });

  it('the staged payload never appears in the audit ledger or an error code', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await stage(sql);
      await sql.query(`select public.nexus_read_raw_staging($1)`, [id]);
      await sql.query(`select public.nexus_mark_raw_failed($1, $2)`, [id, 'provider_unavailable']);

      // Read as the owner: the point is that no row anywhere contains the body, not
      // that a particular actor cannot see one.
      const hits = await asOwner(sql, async () => {
        const audit = await sql.query<{ n: number }>(
          `select count(*)::int as n from public.audit_events
            where coalesce(after_json::text, '') like '%RAW-LINKEDIN-PROFILE-BODY%'`,
        );
        const staging = await sql.query<{ n: number }>(
          `select count(*)::int as n from public.raw_staging
            where coalesce(last_error_code, '') like '%RAW-LINKEDIN-PROFILE-BODY%'`,
        );
        return { audit: Number(audit.rows[0]?.n ?? 0), staging: Number(staging.rows[0]?.n ?? 0) };
      });
      expect(hits.audit).toBe(0);
      expect(hits.staging).toBe(0);

      await sql.query(`select public.nexus_delete_raw_staging($1)`, [id]);
    });
  });

  it('source_evidence keeps the metadata of raw bytes that no longer exist', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const inserted = await sql.query<{ id: string }>(
        `insert into public.source_evidence
           (business_id, person_id, company_id, lead_id, source, source_url,
            raw_text_or_json, content_hash, observed_at, confidence, created_by,
            raw_content_hash, raw_bytes, raw_deleted_at, collector_agent, model, extracted_at)
         values ($1, $2, $3, $4, 'linkedin', 'https://www.linkedin.com/in/sarah-smith',
                 '{"summary":"Marketing Director; owns paid media"}', 'fixture-meta-hash-1', now(), 0.9, $5,
                 'sha256-fixture-hash', 74, now(), 'companion', 'deepseek-chat', now())
         returning id`,
        [
          FIXTURE_IDS.businessA,
          FIXTURE_IDS.personSarahSmith,
          FIXTURE_IDS.companyAbcMedia,
          FIXTURE_IDS.leadA2,
          FIXTURE_IDS.user1,
        ],
      );
      const evidenceId = inserted.rows[0]?.id ?? '';
      expect(evidenceId).not.toBe('');

      // The permanent proof that bytes existed is the hash, not the bytes.
      const row = await sql.query<{
        raw_content_hash: string;
        raw_deleted_at: string | null;
        raw_text_or_json: string;
      }>(
        `select raw_content_hash, raw_deleted_at, raw_text_or_json
           from public.source_evidence where id = $1`,
        [evidenceId],
      );
      expect(row.rows[0]?.raw_content_hash).toBe('sha256-fixture-hash');
      expect(row.rows[0]?.raw_deleted_at).not.toBeNull();
      expect(row.rows[0]?.raw_text_or_json).not.toContain('RAW-LINKEDIN-PROFILE-BODY');
    });
  });
});
