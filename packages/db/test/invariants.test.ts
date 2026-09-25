/**
 * Enforced invariants — DB_CONTRACT.md §2.
 *
 * Each case performs the rejected operation and asserts the raised error, then
 * the allowed operation and asserts the resulting rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { accepted, actAs, attempt, countOf, createHarness, FIXTURE_IDS, rejected, type Harness } from './harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('invariant 1 — one active lead per person per business', () => {
  it('the same person is a lead in two different businesses', async () => {
    await h.asAdmin(async (sql) => {
      const rows = await sql.query<{ id: string; business_id: string }>(
        'select id, business_id from public.leads where person_id = $1 and deleted_at is null order by id',
        [FIXTURE_IDS.personTomHenry],
      );
      expect(rows.rows.map((r) => r.business_id)).toEqual([
        FIXTURE_IDS.businessA,
        FIXTURE_IDS.businessB,
      ]);
    });
  });

  it('a duplicate active lead in the same business is rejected', async () => {
    await h.asAdmin(async (sql) => {
      const error = await rejected(
        sql,
        () =>
          sql.query(
            `insert into public.leads (business_id, person_id, status, source_type)
             values ($1, $2, 'ready', 'manual_add')`,
            [FIXTURE_IDS.businessA, FIXTURE_IDS.personTomHenry],
          ),
        '23505',
      );
      expect(error.constraint).toBe('leads_business_person_active_key');
    });
  });

  it('a soft-deleted lead does not block a new one, but restore_lead re-checks', async () => {
    await h.asAdmin(async (sql) => {
      await accepted(sql, () =>
        sql.query('select public.soft_delete_lead($1, $2)', [FIXTURE_IDS.leadA1, FIXTURE_IDS.admin]),
      );

      const replacement = await accepted(sql, () =>
        sql.query<{ id: string }>(
          `insert into public.leads (business_id, person_id, status, source_type, created_by)
           values ($1, $2, 'ready', 'manual_add', $3) returning id`,
          [FIXTURE_IDS.businessA, FIXTURE_IDS.personTomHenry, FIXTURE_IDS.admin],
        ),
      );
      const replacementId = replacement.rows[0]?.id;
      expect(replacementId).toBeDefined();
      expect(replacementId).not.toBe(FIXTURE_IDS.leadA1);

      const error = await rejected(
        sql,
        () =>
          sql.query('select public.restore_lead($1, $2)', [FIXTURE_IDS.leadA1, FIXTURE_IDS.admin]),
        '23505',
      );
      expect(error.message).toContain('already has active lead');
    });
  });

  it('restore_lead succeeds when no other active lead exists', async () => {
    await h.asAdmin(async (sql) => {
      await sql.query('select public.soft_delete_lead($1, $2)', [FIXTURE_IDS.leadA1, FIXTURE_IDS.admin]);
      const restored = await accepted(sql, () =>
        sql.query<{ result: { restored: boolean } }>('select public.restore_lead($1, $2) as result', [
          FIXTURE_IDS.leadA1,
          FIXTURE_IDS.admin,
        ]),
      );
      expect(restored.rows[0]?.result.restored).toBe(true);

      const row = await sql.query<{ deleted_at: string | null; status: string }>(
        'select deleted_at, status from public.leads where id = $1',
        [FIXTURE_IDS.leadA1],
      );
      expect(row.rows[0]?.deleted_at).toBeNull();
      expect(row.rows[0]?.status).toBe('new');
    });
  });
});

describe('invariant 2 — exactly one primary ICP per lead', () => {
  it('a second primary ICP match is rejected', async () => {
    await h.asAdmin(async (sql) => {
      const extra = await accepted(sql, () =>
        sql.query<{ id: string }>(
          `insert into public.icps (business_id, name) values ($1, 'Extra ICP') returning id`,
          [FIXTURE_IDS.businessA],
        ),
      );
      const extraIcp = extra.rows[0]?.id;
      expect(extraIcp).toBeDefined();

      const error = await rejected(
        sql,
        () =>
          sql.query(
            `insert into public.lead_icp_matches (lead_id, icp_id, is_primary, reason)
             values ($1, $2, true, 'second primary')`,
            [FIXTURE_IDS.leadA1, extraIcp],
          ),
        '23505',
      );
      expect(error.constraint).toBe('lead_icp_matches_primary_key');

      const stillPrimary = await sql.query<{ icp_id: string }>(
        'select icp_id from public.lead_icp_matches where lead_id = $1 and is_primary',
        [FIXTURE_IDS.leadA1],
      );
      expect(stillPrimary.rows.map((r) => r.icp_id)).toEqual([FIXTURE_IDS.icpA]);
    });
  });

  it('secondary matches never create a second lead', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const before = await countOf(sql, 'select count(*)::int as n from public.leads');
      await sql.query(
        `insert into public.lead_icp_matches (lead_id, icp_id, is_primary, reason)
         values ($1, $2, false, 'secondary') on conflict do nothing`,
        [FIXTURE_IDS.leadA2, FIXTURE_IDS.icpA2],
      );
      expect(await countOf(sql, 'select count(*)::int as n from public.leads')).toBe(before);

      const matches = await countOf(
        sql,
        'select count(*)::int as n from public.lead_icp_matches where lead_id = $1',
        [FIXTURE_IDS.leadA2],
      );
      expect(matches).toBe(2);
    });
  });

  it('set_primary_icp swaps the primary and keeps the secondaries, audited', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const before = await sql.query<{ primary: string | null; total: number }>(
        `select public.one_primary_icp_per_lead($1) as primary,
                (select count(*)::int from public.lead_icp_matches where lead_id = $1) as total`,
        [FIXTURE_IDS.leadA1],
      );
      expect(before.rows[0]?.primary).toBe(FIXTURE_IDS.icpA);
      expect(before.rows[0]?.total).toBe(2);

      const result = await accepted(sql, () =>
        sql.query<{ result: { primary_icp_id: string; previous_primary_icp_id: string; secondary_matches: number } }>(
          'select public.set_primary_icp($1, $2) as result',
          [FIXTURE_IDS.leadA1, FIXTURE_IDS.icpA2],
        ),
      );
      expect(result.rows[0]?.result.primary_icp_id).toBe(FIXTURE_IDS.icpA2);
      expect(result.rows[0]?.result.previous_primary_icp_id).toBe(FIXTURE_IDS.icpA);
      expect(result.rows[0]?.result.secondary_matches).toBe(1);

      const after = await sql.query<{ primary: string | null; secondaries: number; lead_icp: string | null }>(
        `select public.one_primary_icp_per_lead($1) as primary,
                (select count(*)::int from public.lead_icp_matches where lead_id = $1 and not is_primary) as secondaries,
                (select primary_icp_id from public.leads where id = $1) as lead_icp`,
        [FIXTURE_IDS.leadA1],
      );
      expect(after.rows[0]?.primary).toBe(FIXTURE_IDS.icpA2);
      expect(after.rows[0]?.secondaries).toBe(1);
      expect(after.rows[0]?.lead_icp).toBe(FIXTURE_IDS.icpA2);

      const audit = await sql.query<{ action: string; actor_id: string; entity_type: string }>(
        `select action, actor_id, entity_type from public.audit_events
          where entity_id = $1 and action = 'set_primary_icp' order by created_at desc limit 1`,
        [FIXTURE_IDS.leadA1],
      );
      expect(audit.rows[0]?.action).toBe('set_primary_icp');
      expect(audit.rows[0]?.actor_id).toBe(FIXTURE_IDS.user1);
      expect(audit.rows[0]?.entity_type).toBe('leads');
    });
  });
});

describe('invariants 3 + 4 — canonical dedupe keys', () => {
  it('normalizes a LinkedIn URL before the uniqueness check', async () => {
    await h.asAdmin(async (sql) => {
      const updated = await accepted(sql, () =>
        sql.query<{ normalized_linkedin_url: string }>(
          `update public.people
              set linkedin_url = 'HTTPS://DE.LinkedIn.com/in/Jon-Davies/?trk=abc#section'
            where id = $1
          returning normalized_linkedin_url`,
          [FIXTURE_IDS.personJonDavies],
        ),
      );
      expect(updated.rows[0]?.normalized_linkedin_url).toBe('linkedin.com/in/jon-davies');
    });
  });

  it('rejects a second person with the same normalized LinkedIn URL', async () => {
    await h.asAdmin(async (sql) => {
      const error = await rejected(
        sql,
        () =>
          sql.query(
            `update public.people set linkedin_url = $1 where id = $2`,
            ['https://de.linkedin.com/in/Tom-Henry/?trk=people', FIXTURE_IDS.personSarahSmith],
          ),
        '23505',
      );
      expect(error.constraint).toBe('people_normalized_linkedin_key');
    });
  });

  it('rejects a second company with the same normalized domain', async () => {
    await h.asAdmin(async (sql) => {
      const error = await rejected(
        sql,
        () =>
          sql.query(
            `update public.companies set primary_domain = $1 where id = $2`,
            ['https://WWW.FrameHouse.example/about?x=1', FIXTURE_IDS.companyKiteStudio],
          ),
        '23505',
      );
      expect(error.constraint).toBe('companies_normalized_domain_key');
    });
  });
});

describe('invariant 5 — rediscovery adds evidence, never duplicate entities', () => {
  it('creates new source_evidence and leaves person/company counts unchanged', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const before = await sql.query<{ people: number; companies: number; evidence: number }>(
        `select (select count(*)::int from public.people) as people,
                (select count(*)::int from public.companies) as companies,
                (select count(*)::int from public.source_evidence) as evidence`,
      );

      await accepted(sql, () =>
        sql.query(
          `insert into public.source_evidence
             (business_id, person_id, company_id, lead_id, source, source_url, raw_text_or_json,
              content_hash, observed_at, confidence, created_by)
           values ($1, $2, $3, $4, 'LinkedIn rediscovery', 'https://www.linkedin.com/in/tom-henry',
                   '{"headline":"Head of Production, hiring"}', 'rediscovery-hash-2', now(), 0.8, $5)`,
          [
            FIXTURE_IDS.businessA,
            FIXTURE_IDS.personTomHenry,
            FIXTURE_IDS.companyFrameHouse,
            FIXTURE_IDS.leadA1,
            FIXTURE_IDS.user1,
          ],
        ),
      );

      const after = await sql.query<{ people: number; companies: number; evidence: number }>(
        `select (select count(*)::int from public.people) as people,
                (select count(*)::int from public.companies) as companies,
                (select count(*)::int from public.source_evidence) as evidence`,
      );

      expect(after.rows[0]?.people).toBe(before.rows[0]?.people);
      expect(after.rows[0]?.companies).toBe(before.rows[0]?.companies);
      expect(after.rows[0]?.evidence).toBe((before.rows[0]?.evidence ?? 0) + 1);
    });
  });

  it('rejects a replayed evidence hash inside the same business', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const error = await rejected(
        sql,
        () =>
          sql.query(
            `insert into public.source_evidence
               (business_id, person_id, source, content_hash, observed_at, confidence)
             values ($1, $2, 'LinkedIn manual import', 'fixture-evidence-hash-1', now(), 0.9)`,
            [FIXTURE_IDS.businessA, FIXTURE_IDS.personTomHenry],
          ),
        '23505',
      );
      expect(error.constraint).toBe('source_evidence_business_hash_key');
    });
  });
});

describe('invariant 6 — ingestion idempotency', () => {
  it('the same (source_client, business_id, idempotency_key) cannot be inserted twice', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const insert = () =>
        sql.query(
          `insert into public.ingest_requests (source_client, business_id, payload_type, idempotency_key, observed_at, payload)
           values ('mcp-agent', $1, 'candidate', 'idem-key-1', now(), '{"name":"Tom Henry"}')`,
          [FIXTURE_IDS.businessA],
        );

      await accepted(sql, insert);

      const error = await rejected(sql, insert, '23505');
      expect(error.constraint).toBe('ingest_requests_idempotency_key');

      const count = await countOf(
        sql,
        `select count(*)::int as n from public.ingest_requests where idempotency_key = 'idem-key-1'`,
      );
      expect(count).toBe(1);
    });
  });
});

describe('invariant 18 — source_evidence requires provenance', () => {
  it('null provenance columns are rejected', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const outcome = await attempt(sql, () =>
        sql.query(
          `insert into public.source_evidence (business_id, person_id, source, content_hash, observed_at, confidence)
           values ($1, $2, null, 'hash', now(), 0.5)`,
          [FIXTURE_IDS.businessA, FIXTURE_IDS.personTomHenry],
        ),
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? '' : outcome.error.code).toBe('23502');

      const confidence = await attempt(sql, () =>
        sql.query(
          `insert into public.source_evidence (business_id, person_id, source, content_hash, observed_at, confidence)
           values ($1, $2, 'x', 'hash-2', now(), 1.5)`,
          [FIXTURE_IDS.businessA, FIXTURE_IDS.personTomHenry],
        ),
      );
      expect(confidence.ok).toBe(false);
      expect(confidence.ok ? '' : confidence.error.code).toBe('23514');
    });
  });
});

describe('invariant 19 — message_versions requires audit refs', () => {
  it('a version with no author, no model and no api client is rejected', async () => {
    await h.asSuperuser(async (sql) => {
      const error = await rejected(
        sql,
        () =>
          sql.query(
            `insert into public.message_versions (message_instance_id, content)
             values ($1, 'orphan version')`,
            [FIXTURE_IDS.messageInstanceA2M1],
          ),
        '23514',
      );
      expect(error.constraint).toBe('message_versions_audit_refs_check');
    });
  });
});

describe('invariant 12 + 13 — business domains', () => {
  it('rejects a second default primary domain for one business', async () => {
    await h.asAdmin(async (sql) => {
      const error = await rejected(
        sql,
        () =>
          sql.query(
            `insert into public.business_domains (business_id, domain, domain_type, is_default)
             values ($1, 'zemnas-second.example', 'primary', true)`,
            [FIXTURE_IDS.businessA],
          ),
        '23505',
      );
      expect(error.constraint).toBe('business_domains_default_primary_key');
    });
  });

  it('rejects a domain already registered to another business', async () => {
    await h.asAdmin(async (sql) => {
      await accepted(sql, () =>
        sql.query(
          `insert into public.business_domains (business_id, domain, domain_type)
           values ($1, 'crm-shared.example', 'alias')`,
          [FIXTURE_IDS.businessB],
        ),
      );

      const shared = await rejected(
        sql,
        () =>
          sql.query(
            `insert into public.business_domains (business_id, domain, domain_type)
             values ($1, 'https://WWW.CRM-Shared.example/path', 'alias')`,
            [FIXTURE_IDS.businessA],
          ),
        '23505',
      );
      expect(shared.constraint).toBe('business_domains_normalized_unique');
    });
  });
});

describe('invariant 14 — identity business access', () => {
  it('has_identity_business_access is true only for configured pairs', async () => {
    await h.asAdmin(async (sql) => {
      const result = await sql.query<{ a: boolean; b: boolean }>(
        'select public.has_identity_business_access($1, $2) as a, public.has_identity_business_access($1, $3) as b',
        [FIXTURE_IDS.identityB1, FIXTURE_IDS.businessB, FIXTURE_IDS.businessA],
      );
      expect(result.rows[0]).toEqual({ a: true, b: false });
    });
  });
});

describe('api client scope enforcement in the database', () => {
  it('a token is refused a write scope it does not hold', async () => {
    await h.asApiClient(FIXTURE_IDS.apiClientLimited, async (sql) => {
      const error = await rejected(
        sql,
        () =>
          sql.query(
            `insert into public.source_evidence (business_id, person_id, source, content_hash, observed_at, confidence)
             values ($1, $2, 'scope-test', 'scope-hash-1', now(), 0.5)`,
            [FIXTURE_IDS.businessA, FIXTURE_IDS.personTomHenry],
          ),
        '42501',
      );
      expect(error.message).toContain('row-level security');
    });
  });

  it('a revoked token loses every capability', async () => {
    await h.asAdmin(async (sql) => {
      await sql.query(`update public.api_clients set is_active = false where id = $1`, [
        FIXTURE_IDS.apiClientIngest,
      ]);

      await actAs(sql, null);
      await sql.exec(`select set_config('nexus.api_client_id', '${FIXTURE_IDS.apiClientIngest}', true)`);
      expect(
        await countOf(sql, 'select count(*)::int as n from public.leads where business_id = $1', [
          FIXTURE_IDS.businessA,
        ]),
      ).toBe(0);
    });
  });
});
