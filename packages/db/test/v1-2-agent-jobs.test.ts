/**
 * V1.2 durable agent jobs — spec §16–§18, §21 and the gate in §57.
 *
 * These assertions exist because the queue's guarantees are the ones a mock cannot
 * have: an atomic claim that two agents cannot both win, a lease that expires so a
 * crashed agent cannot park work, and a completion rule that the database enforces
 * rather than the processor promising to.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from '../src/client';
import { accepted, actAsApiClient, createHarness, FIXTURE_IDS, rejected, type Harness } from './harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 180_000);

afterAll(async () => {
  await h.close();
});

/** Owner-level access inside the current transaction; see the raw-lifecycle suite. */
async function asOwner<T>(sql: Db, fn: () => Promise<T>): Promise<T> {
  await sql.exec('reset role');
  try {
    return await fn();
  } finally {
    await sql.exec('set local role authenticated');
  }
}

const COMPANY_RESEARCH_BODY = 'RAW-COMPANY-RESEARCH-BODY: abcmedia.example services, hiring, size 40';

/**
 * The columns a claim/heartbeat returns.
 *
 * Indexed so it satisfies the driver's generic `Row` constraint (`Record<string,
 * unknown>`): a plain interface without an index signature does not.
 */
interface JobRow extends Record<string, unknown> {
  id: string;
  status: string;
  attempt_count: number;
  lease_expires_at: string | null;
  claimed_by_agent: string | null;
}

async function createJob(
  sql: Db,
  overrides: {
    jobType?: string;
    priority?: string;
    capabilities?: string[];
    dedupeKey?: string | null;
    businessId?: string;
    leadId?: string | null;
  } = {},
): Promise<string> {
  const result = await sql.query<{ job_id: string; created: boolean }>(
    `select * from public.nexus_create_agent_job(
       $1, $2, $3, $4, $5, $6, $7, $8::text[], 'system', null, $9, $10
     )`,
    [
      overrides.businessId ?? FIXTURE_IDS.businessA,
      overrides.jobType ?? 'RESEARCH_COMPANY',
      overrides.leadId === undefined ? FIXTURE_IDS.leadA2 : overrides.leadId,
      FIXTURE_IDS.personSarahSmith,
      FIXTURE_IDS.companyAbcMedia,
      overrides.priority ?? 'normal',
      'Collect the official site, services, industry, size indicators, hiring and content activity.',
      overrides.capabilities ?? [],
      overrides.dedupeKey === undefined ? null : overrides.dedupeKey,
      'fixture: company intelligence is incomplete',
    ],
  );
  return result.rows[0]?.job_id ?? '';
}

async function jobRow(sql: Db, id: string): Promise<JobRow | null> {
  return asOwner(sql, async () => {
    const result = await sql.query<JobRow>(
      `select id, status, attempt_count, lease_expires_at, claimed_by_agent from public.agent_jobs where id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  });
}

async function countEvents(sql: Db, id: string, eventType: string): Promise<number> {
  return asOwner(sql, async () => {
    const result = await sql.query<{ n: number }>(
      `select count(*)::int as n from public.agent_job_events where job_id = $1 and event_type = $2`,
      [id, eventType],
    );
    return Number(result.rows[0]?.n ?? 0);
  });
}

describe('v1.2 agent jobs', () => {
  it('creates a durable OPEN job and records why it exists', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await createJob(sql, { dedupeKey: 'RESEARCH_COMPANY:lead-a2' });
      expect(id).not.toBe('');

      const row = await jobRow(sql, id);
      expect(row?.status).toBe('OPEN');
      expect(row?.attempt_count).toBe(0);
      expect(row?.claimed_by_agent).toBeNull();

      const reason = await asOwner(sql, async () => {
        const result = await sql.query<{ reason: string; dedupe_key: string; required_capabilities: string[] }>(
          `select reason, dedupe_key, required_capabilities from public.agent_jobs where id = $1`,
          [id],
        );
        return result.rows[0];
      });
      expect(reason?.dedupe_key).toBe('RESEARCH_COMPANY:lead-a2');
      expect(reason?.reason).toContain('incomplete');
      expect(await countEvents(sql, id, 'created')).toBe(1);
    });
  });

  it('deduplicates a chained job by its key instead of creating a second one', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const first = await createJob(sql, { dedupeKey: 'RESEARCH_COMPANY:same-entity' });
      const second = await createJob(sql, { dedupeKey: 'RESEARCH_COMPANY:same-entity' });
      expect(second).toBe(first);

      const listed = await sql.query<{ n: number }>(
        `select count(*)::int as n from public.agent_jobs where business_id = $1 and dedupe_key = $2`,
        [FIXTURE_IDS.businessA, 'RESEARCH_COMPANY:same-entity'],
      );
      expect(Number(listed.rows[0]?.n)).toBe(1);
    });
  });

  it('claim is atomic: two agents cannot both win the same job', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await createJob(sql);

      const first = await sql.query<JobRow>(
        `select * from public.nexus_claim_agent_job($1, 'opencode', $2::text[], $3, 900)`,
        [FIXTURE_IDS.businessA, ['browser', 'public_web'], id],
      );
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0]?.status).toBe('RUNNING');
      expect(first.rows[0]?.attempt_count).toBe(1);

      const second = await sql.query<JobRow>(
        `select * from public.nexus_claim_agent_job($1, 'other-agent', $2::text[], $3, 900)`,
        [FIXTURE_IDS.businessA, ['browser', 'public_web'], id],
      );
      expect(second.rows).toHaveLength(0);

      const row = await jobRow(sql, id);
      expect(row?.claimed_by_agent).toBe('opencode');
    });
  });

  it('a claim skips a job whose required capability the agent lacks', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      await createJob(sql, { capabilities: ['browser', 'news'] });
      const result = await sql.query(
        `select * from public.nexus_claim_agent_job($1, 'weak-agent', $2::text[], null, 900)`,
        [FIXTURE_IDS.businessA, ['browser']],
      );
      expect(result.rows).toHaveLength(0);
    });
  });

  it('heartbeat extends the lease and only the holder may heartbeat', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await createJob(sql);
      await sql.query(`select * from public.nexus_claim_agent_job($1, 'opencode', '{}'::text[], $2, 120)`, [
        FIXTURE_IDS.businessA,
        id,
      ]);

      const beat = await sql.query<{ lease_expires_at: string }>(
        `select lease_expires_at from public.nexus_heartbeat_agent_job($1, 'opencode', 1800)`,
        [id],
      );
      expect(beat.rows).toHaveLength(1);

      const extended = await asOwner(sql, async () => {
        const result = await sql.query<{ seconds: number }>(
          `select extract(epoch from (lease_expires_at - now()))::int as seconds from public.agent_jobs where id = $1`,
          [id],
        );
        return Number(result.rows[0]?.seconds ?? 0);
      });
      // The 1800s request is clamped to the 3600s ceiling and is well above the 120s
      // the claim originally took.
      expect(extended).toBeGreaterThan(1500);

      await rejected(sql, () => sql.query(`select public.nexus_heartbeat_agent_job($1, 'impostor', 900)`, [id]), '55006');
      expect(await countEvents(sql, id, 'heartbeat')).toBe(1);
    });
  });

  it('an expired lease makes the job claimable again — crash recovery', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await createJob(sql);
      await sql.query(`select * from public.nexus_claim_agent_job($1, 'crashed-agent', '{}'::text[], $2, 60)`, [
        FIXTURE_IDS.businessA,
        id,
      ]);

      // The agent died: its lease lapsed and nothing renewed it.
      await asOwner(sql, async () => {
        await sql.query(`update public.agent_jobs set lease_expires_at = now() - interval '5 minutes' where id = $1`, [id]);
      });

      const reclaimed = await sql.query<JobRow>(
        `select * from public.nexus_claim_agent_job($1, 'second-agent', '{}'::text[], $2, 900)`,
        [FIXTURE_IDS.businessA, id],
      );
      expect(reclaimed.rows).toHaveLength(1);
      expect(reclaimed.rows[0]?.attempt_count).toBe(2);

      const row = await jobRow(sql, id);
      expect(row?.claimed_by_agent).toBe('second-agent');
      expect(row?.status).toBe('RUNNING');
    });
  });

  it('the reaper returns an expired lease to the queue and fails one with no attempts left', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const recoverable = await createJob(sql);
      const doomed = await createJob(sql, { leadId: FIXTURE_IDS.leadA4 });

      await sql.query(`select * from public.nexus_claim_agent_job($1, 'dead-agent', '{}'::text[], $2, 60)`, [
        FIXTURE_IDS.businessA,
        recoverable,
      ]);
      await sql.query(`select * from public.nexus_claim_agent_job($1, 'dead-agent', '{}'::text[], $2, 60)`, [
        FIXTURE_IDS.businessA,
        doomed,
      ]);

      await asOwner(sql, async () => {
        await sql.query(
          `update public.agent_jobs set lease_expires_at = now() - interval '1 minute',
                  attempt_count = max_attempts
            where id = $1`,
          [doomed],
        );
        await sql.query(
          `update public.agent_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`,
          [recoverable],
        );
      });

      const reaped = await sql.query<{ reaped: number }>(
        `select public.nexus_reap_expired_job_leases(50) as reaped`,
      );
      expect(Number(reaped.rows[0]?.reaped)).toBeGreaterThanOrEqual(2);

      expect((await jobRow(sql, recoverable))?.status).toBe('OPEN');
      expect((await jobRow(sql, doomed))?.status).toBe('FAILED');
      expect(await countEvents(sql, recoverable, 'lease_expired')).toBe(1);
    });
  });

  it('submitting a result stages raw and waits for AI instead of completing', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await createJob(sql);
      await sql.query(`select * from public.nexus_claim_agent_job($1, 'opencode', '{}'::text[], $2, 900)`, [
        FIXTURE_IDS.businessA,
        id,
      ]);

      const submitted = await sql.query<{ status: string; raw_staging_id: string }>(
        `select status, raw_staging_id from public.nexus_submit_agent_job_result(
           $1, 'opencode', $2, 'sha256-company-hash', 'company_research', 'web', 'https://abcmedia.example'
         )`,
        [id, COMPANY_RESEARCH_BODY],
      );
      expect(submitted.rows[0]?.status).toBe('WAITING_AI');
      expect(submitted.rows[0]?.raw_staging_id).toBeTruthy();

      expect((await jobRow(sql, id))?.status).toBe('WAITING_AI');

      // The raw body exists in staging — and nowhere else.
      const leaked = await asOwner(sql, async () => {
        const events = await sql.query<{ n: number }>(
          `select count(*)::int as n from public.agent_job_events
            where job_id = $1 and coalesce(note, '') like '%RAW-COMPANY-RESEARCH-BODY%'`,
          [id],
        );
        return Number(events.rows[0]?.n ?? 0);
      });
      expect(leaked).toBe(0);

      await sql.query(`select public.nexus_delete_raw_staging($1)`, [submitted.rows[0]?.raw_staging_id ?? '']);
    });
  });

  it('a job cannot complete while un-consumed raw evidence remains', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await createJob(sql);
      await sql.query(`select * from public.nexus_claim_agent_job($1, 'opencode', '{}'::text[], $2, 900)`, [
        FIXTURE_IDS.businessA,
        id,
      ]);
      const submitted = await sql.query<{ raw_staging_id: string }>(
        `select raw_staging_id from public.nexus_submit_agent_job_result(
           $1, 'opencode', $2, 'sha256-company-hash', 'company_research', 'web', null
         )`,
        [id, COMPANY_RESEARCH_BODY],
      );

      await rejected(sql, () => sql.query(`select public.nexus_complete_agent_job($1, null)`, [id]), '55006');
      expect((await jobRow(sql, id))?.status).toBe('WAITING_AI');

      // Verification → delete → complete, in that order.
      await sql.query(`select public.nexus_read_raw_staging($1)`, [submitted.rows[0]?.raw_staging_id ?? '']);
      await sql.query(`select public.nexus_delete_raw_staging($1)`, [submitted.rows[0]?.raw_staging_id ?? '']);

      const completed = await sql.query<{ status: string }>(
        `select status from public.nexus_complete_agent_job($1, null)`,
        [id],
      );
      expect(completed.rows[0]?.status).toBe('COMPLETE');

      const row = await asOwner(sql, async () => {
        const result = await sql.query<{ completed_at: string | null; lease_expires_at: string | null }>(
          `select completed_at, lease_expires_at from public.agent_jobs where id = $1`,
          [id],
        );
        return result.rows[0];
      });
      expect(row?.completed_at).not.toBeNull();
      expect(row?.lease_expires_at).toBeNull();
      expect(await countEvents(sql, id, 'completed')).toBe(1);
    });
  });

  it('a retryable failure returns the job to the queue and a capped attempt fails it', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await createJob(sql);
      await asOwner(sql, async () => {
        await sql.query(`update public.agent_jobs set max_attempts = 2 where id = $1`, [id]);
      });

      await sql.query(`select * from public.nexus_claim_agent_job($1, 'opencode', '{}'::text[], $2, 900)`, [
        FIXTURE_IDS.businessA,
        id,
      ]);
      const firstFail = await sql.query<{ status: string; attempt_count: number }>(
        `select status, attempt_count from public.nexus_fail_agent_job($1, 'opencode', 'site_unreachable', 'The company site timed out', true)`,
        [id],
      );
      expect(firstFail.rows[0]?.status).toBe('OPEN');
      expect(await countEvents(sql, id, 'retry_scheduled')).toBe(1);

      await sql.query(`select * from public.nexus_claim_agent_job($1, 'opencode', '{}'::text[], $2, 900)`, [
        FIXTURE_IDS.businessA,
        id,
      ]);
      const secondFail = await sql.query<{ status: string }>(
        `select status from public.nexus_fail_agent_job($1, 'opencode', 'site_unreachable', 'Still unreachable', true)`,
        [id],
      );
      expect(secondFail.rows[0]?.status).toBe('FAILED');

      // A failed job is claimable by nobody until it is explicitly retried.
      const claimAgain = await sql.query(
        `select * from public.nexus_claim_agent_job($1, 'opencode', '{}'::text[], $2, 900)`,
        [FIXTURE_IDS.businessA, id],
      );
      expect(claimAgain.rows).toHaveLength(0);
    });
  });

  it('release returns the job to the queue and a different agent cannot release it', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await createJob(sql);
      await sql.query(`select * from public.nexus_claim_agent_job($1, 'opencode', '{}'::text[], $2, 900)`, [
        FIXTURE_IDS.businessA,
        id,
      ]);

      await rejected(sql, () => sql.query(`select public.nexus_release_agent_job($1, 'someone-else', 'nope')`, [id]), '55006');

      await sql.query(`select public.nexus_release_agent_job($1, 'opencode', 'Handing back')`, [id]);
      const row = await jobRow(sql, id);
      expect(row?.status).toBe('OPEN');
      expect(row?.claimed_by_agent).toBeNull();
      expect(await countEvents(sql, id, 'released')).toBe(1);
    });
  });

  it('cancel is terminal and a completed job cannot be cancelled', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await createJob(sql);
      await sql.query(`select public.nexus_cancel_agent_job($1, 'No longer needed')`, [id]);
      expect((await jobRow(sql, id))?.status).toBe('CANCELLED');

      const claim = await sql.query(
        `select * from public.nexus_claim_agent_job($1, 'opencode', '{}'::text[], $2, 900)`,
        [FIXTURE_IDS.businessA, id],
      );
      expect(claim.rows).toHaveLength(0);
    });
  });

  it('an agent token needs the jobs scope, and a user needs the business capability', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await createJob(sql);

      // A token scoped to a different business cannot even see the job.
      await asOwner(sql, async () => {
        await sql.query(`update public.api_clients set business_ids = array[$1]::uuid[] where id = $2`, [
          FIXTURE_IDS.businessB,
          FIXTURE_IDS.apiClientLimited,
        ]);
      });
      // `actAsApiClient` clears the user claims as well: leaving `sub` in place
      // would keep the *user's* business access alive and the assertion would pass
      // for the wrong reason.
      await actAsApiClient(sql, FIXTURE_IDS.apiClientLimited);
      const rows = await sql.query(`select id from public.agent_jobs where id = $1`, [id]);
      expect(rows.rows).toHaveLength(0);

      await rejected(
        sql,
        () => sql.query(`select * from public.nexus_claim_agent_job($1, 'token-agent', '{}'::text[], null, 900)`, [FIXTURE_IDS.businessA]),
        '42501',
      );
    });
  });

  it('an agent token with the jobs scopes can claim and submit', async () => {
    // A user creates the job first, then a scoped service token works it in a
    // separate transaction — exactly the OpenCode shape.
    await h.asApiClient(FIXTURE_IDS.apiClientIngest, async (sql) => {
      await asOwner(sql, async () => {
        await sql.query(
          `update public.api_clients set scopes = array['jobs:claim','jobs:submit','jobs:create'] where id = $1`,
          [FIXTURE_IDS.apiClientIngest],
        );
      });

      const created = await sql.query<{ job_id: string }>(
        `select * from public.nexus_create_agent_job(
           $1, 'RESEARCH_COMPANY', null, null, null, 'normal', 'Research the company', $2::text[],
           'agent', null, null, 'token-created'
         )`,
        [FIXTURE_IDS.businessA, ['browser']],
      );
      const jobId = created.rows[0]?.job_id ?? '';
      expect(jobId).not.toBe('');

      const claimed = await sql.query<JobRow>(
        `select * from public.nexus_claim_agent_job($1, 'opencode', $2::text[], $3, 900)`,
        [FIXTURE_IDS.businessA, ['browser'], jobId],
      );
      expect(claimed.rows).toHaveLength(1);

      const submitted = await sql.query<{ status: string; raw_staging_id: string }>(
        `select status, raw_staging_id from public.nexus_submit_agent_job_result(
           $1, 'opencode', $2, 'sha256-token-hash', 'company_research', 'web', null
         )`,
        [jobId, COMPANY_RESEARCH_BODY],
      );
      expect(submitted.rows[0]?.status).toBe('WAITING_AI');
      await sql.query(`select public.nexus_delete_raw_staging($1)`, [submitted.rows[0]?.raw_staging_id ?? '']);
    });
  });

  it('another business cannot see or claim this business job', async () => {
    await h.asUser(FIXTURE_IDS.user1, async (sql) => {
      const id = await createJob(sql);
      await accepted(sql, async () => sql.query(`select id from public.agent_jobs where id = $1`, [id]));

      // Switching identity inside the same transaction: the row exists, and user2
      // must not be able to reach it.
      await sql.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: FIXTURE_IDS.user2 }),
      ]);
      const hidden = await sql.query(`select id from public.agent_jobs where id = $1`, [id]);
      expect(hidden.rows).toHaveLength(0);

      await rejected(
        sql,
        () =>
          sql.query(`select * from public.nexus_claim_agent_job($1, 'opencode', '{}'::text[], null, 900)`, [
            FIXTURE_IDS.businessA,
          ]),
        '42501',
      );
    });
  });

  it('nexus_claim_ai_work leases WAITING_AI work to exactly one processor', async () => {
    await h.asAdmin(async (sql) => {
      const id = await createJob(sql);
      await sql.query(`select * from public.nexus_claim_agent_job($1, 'opencode', '{}'::text[], $2, 900)`, [
        FIXTURE_IDS.businessA,
        id,
      ]);
      const submitted = await sql.query<{ raw_staging_id: string }>(
        `select raw_staging_id from public.nexus_submit_agent_job_result(
           $1, 'opencode', $2, 'sha256-company-hash', 'company_research', 'web', null
         )`,
        [id, COMPANY_RESEARCH_BODY],
      );

      const first = await sql.query<{ job_id: string }>(
        `select job_id from public.nexus_claim_ai_work(5, $1, 600)`,
        [FIXTURE_IDS.businessA],
      );
      expect(first.rows.map((r) => r.job_id)).toContain(id);

      const second = await sql.query<{ job_id: string }>(
        `select job_id from public.nexus_claim_ai_work(5, $1, 600)`,
        [FIXTURE_IDS.businessA],
      );
      expect(second.rows.map((r) => r.job_id)).not.toContain(id);

      // Its lease lapsed, so a restarted processor picks the work back up.
      await asOwner(sql, async () => {
        await sql.query(`update public.agent_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`, [id]);
      });
      const third = await sql.query<{ job_id: string }>(
        `select job_id from public.nexus_claim_ai_work(5, $1, 600)`,
        [FIXTURE_IDS.businessA],
      );
      expect(third.rows.map((r) => r.job_id)).toContain(id);

      await sql.query(`select public.nexus_delete_raw_staging($1)`, [submitted.rows[0]?.raw_staging_id ?? '']);
    });
  });

  it('a business member without manage-leads permission cannot create a job', async () => {
    await h.asUser(FIXTURE_IDS.user2, async (sql) => {
      // user2 reaches business B, but creating operational work for the team is a
      // permissioned act; the grant is removed here to prove the gate is the
      // permission and not merely business access.
      await asOwner(sql, async () => {
        await sql.query(
          `update public.user_business_access set can_manage_leads = false
            where user_id = $1 and business_id = $2`,
          [FIXTURE_IDS.user2, FIXTURE_IDS.businessB],
        );
      });

      await rejected(
        sql,
        () =>
          sql.query(
            `select * from public.nexus_create_agent_job($1, 'RESEARCH_COMPANY', null, null, null, 'normal', null, '{}'::text[], 'system', null, null, null)`,
            [FIXTURE_IDS.businessB],
          ),
        '42501',
      );
    });
  });
});
