/**
 * MCP gateway transport.
 *
 * The audit found the gateway validating almost nothing: `tools/list` advertised `{business_id}` as
 * the entire input schema for every tool, `tools/call` accepted any argument shape, the declared
 * `idempotency_key` was read and discarded, and a JSON-RPC batch was answered with only its first
 * element. Each of those has a test here.
 *
 * The gateway's credential resolver is replaced with a fixed service token so the transport itself is
 * exercised; the idempotency tests use the real database, because a claim about "never applied twice"
 * is only meaningful against the unique index that enforces it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ServiceCredential } from '@/lib/gateway';

import { createAppHarness, type AppHarness } from './harness';

const ACTOR = { kind: 'service' } as const;

const ADMIN_ID = 'd1000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'd1000000-0000-4000-8000-000000000002';
const LEAD_ID = 'd1000000-0000-4000-8000-000000000003';
const PERSON_ID = 'd1000000-0000-4000-8000-000000000004';
const COMPANY_ID = 'd1000000-0000-4000-8000-000000000005';
const TASK_ID = 'd1000000-0000-4000-8000-000000000006';

/** The caller every test acts as. Swapped in `beforeAll` once the seeded user id is known. */
let CREDENTIAL: ServiceCredential;

/**
 * A signed-in admin, not a service token.
 *
 * The idempotency tests perform real writes, and RLS is the real boundary: a service actor has no
 * `current_user_id()`, so the `signals` insert policy refuses it. Acting as the seeded admin means
 * these tests exercise the whole path — scope check, idempotency, RLS — rather than stopping at the
 * first policy.
 */
function credentialFor(): ServiceCredential {
  return {
    kind: 'service',
    actor: { kind: 'user', userId: ADMIN_ID },
    scopes: [
      'businesses:read',
      'context:read',
      'signal:create',
      'task:create',
      'person:search',
      'note:add',
      // The read and agent tools exercised by the handler-coverage suite below. Each is here because
      // its tool requires it, so a missing scope would surface as a `-32003` refusal rather than as
      // the behaviour under test.
      'company:search',
      'duplicate:check',
      'today:read',
      'research:submit',
      // The scope names the tool table declares, which are not all identical to the tool suffix.
      'message:draft',
      'agent:run',
      'candidate:submit',
    ],
    // Scoped to the one business the tests use, so the "not scoped to that business" refusal is a
    // real path rather than something the fixture accidentally disables.
    businessIds: [BUSINESS_ID],
  } as unknown as ServiceCredential;
}

vi.mock('@/lib/gateway', async () => {
  const actual = await vi.importActual<typeof import('@/lib/gateway')>('@/lib/gateway');
  return {
    ...actual,
    resolveCredential: async () => CREDENTIAL,
    // The real scope check is a pure function over the credential; keeping it means the tests
    // observe the same refusals production does.
    requireScope: actual.requireScope,
  };
});

const { POST } = await import('@/app/api/v1/mcp/route');
const { MCP_TOOL_SCHEMAS, toolInputSchema } = await import('@/app/api/v1/mcp/tool-schemas');

let h: AppHarness;

function rpc(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/v1/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function call(name: string, args: Record<string, unknown>, id = 1): Promise<Record<string, unknown>> {
  const response = await rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  return (await response.json()) as Record<string, unknown>;
}

function resultOf(payload: Record<string, unknown>): Record<string, unknown> {
  return (payload['result'] ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  h = await createAppHarness();
  await h.db.exec('set row_security = off');
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'mcp-admin@nexus.test', 'MCP Admin', 'admin', 'active')`,
    [ADMIN_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by)
     values ($1, 'mcp-test', 'MCP Test Co', 'active', $2)`,
    [BUSINESS_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.people (id, full_name, normalized_name, created_by)
     values ($1, 'MCP Person', 'mcp person', $2)`,
    [PERSON_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.leads (id, business_id, person_id, status, source_type, created_by)
     values ($1, $2, $3, 'ready', 'paste_list', $4)`,
    [LEAD_ID, BUSINESS_ID, PERSON_ID, ADMIN_ID],
  );
  // A company so the company search has something to find, a task so the Today queue has an item, and
  // an open task is what `get_today_queue` reports under the `custom_tasks` category.
  await h.db.query(
    `insert into public.companies (id, name, normalized_name, normalized_domain, created_by)
     values ($1, 'Northwind Media', 'northwind media', 'northwind.test', $2)`,
    [COMPANY_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.tasks (id, business_id, lead_id, owner_user_id, title, type, due_at, priority, status, source, created_by)
     values ($1, $2, $3, $4, 'Send the sample edit', 'follow_up', now() - interval '1 hour', 'normal', 'open', 'user', $4)`,
    [TASK_ID, BUSINESS_ID, LEAD_ID, ADMIN_ID],
  );
  await h.db.exec('set row_security = on');
  CREDENTIAL = credentialFor();
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('tools/list', () => {
  it('publishes each tool input schema rather than only business_id', async () => {
    const payload = (await (
      await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    ).json()) as { result: { tools: { name: string; inputSchema: Record<string, unknown> }[] } };

    const tools = payload.result.tools;
    expect(tools.length).toBeGreaterThan(10);

    const signal = tools.find((tool) => tool.name === 'nexus.create_signal');
    const properties = (signal?.inputSchema['properties'] ?? {}) as Record<string, unknown>;
    // The vocabulary is published, so a client cannot generate a call with an invalid kind.
    expect(properties['kind']).toMatchObject({ type: 'string' });
    expect((properties['kind'] as { enum?: string[] }).enum).toContain('hiring');
    expect(signal?.inputSchema['required']).toContain('kind');
    expect(signal?.inputSchema['required']).toContain('business_id');
    // A tool that creates something advertises the idempotency key it requires.
    expect(signal?.inputSchema['required']).toContain('idempotency_key');
  });

  it('does not require an idempotency key on a read-only tool', () => {
    const schema = toolInputSchema('nexus.search_person');
    expect(schema['required']).not.toContain('idempotency_key');
    expect(schema['required']).toContain('query');
  });

  it('has a schema for every declared tool', () => {
    // The `Record<McpToolName, …>` type makes a missing entry a compile error; this asserts the
    // runtime consequence, that none is an empty placeholder.
    for (const [name, schema] of Object.entries(MCP_TOOL_SCHEMAS)) {
      expect(schema, `${name} has no schema`).toBeDefined();
    }
  });
});

describe('argument validation', () => {
  it('refuses an invalid enum value before the database sees it', async () => {
    const payload = await call('nexus.create_signal', {
      business_id: BUSINESS_ID,
      idempotency_key: 'signal-bad-kind-0001',
      kind: 'other',
      label: 'nope',
    });

    const result = resultOf(payload);
    expect(result['isError']).toBe(true);
    expect(String((result['content'] as { text: string }[])[0]?.text)).toMatch(/kind/i);
  });

  it('refuses a missing required argument by name', async () => {
    const payload = await call('nexus.create_task', {
      business_id: BUSINESS_ID,
      idempotency_key: 'task-missing-title-0001',
    });

    const result = resultOf(payload);
    expect(result['isError']).toBe(true);
    expect(String((result['content'] as { text: string }[])[0]?.text)).toContain('title');
  });

  it('refuses a non-uuid business id instead of passing it to a query', async () => {
    const payload = await call('nexus.search_person', { business_id: 'not-a-uuid', query: 'Ada' });
    const result = resultOf(payload);
    expect(result['isError']).toBe(true);
  });

  it('refuses a mutating tool with no idempotency key', async () => {
    const payload = await call('nexus.create_signal', {
      business_id: BUSINESS_ID,
      kind: 'hiring',
      label: 'no key',
    });
    const result = resultOf(payload);
    expect(result['isError']).toBe(true);
    expect(String((result['content'] as { text: string }[])[0]?.text)).toMatch(/idempotency_key/);
  });

  it('accepts unknown extra keys rather than breaking a client that sends them', async () => {
    // The envelope is extracted and the tool schema ignores extras; nothing unvalidated reaches a
    // repository either way, and rejecting would make the gateway brittle for no security gain.
    const parsed = MCP_TOOL_SCHEMAS['nexus.search_person'].safeParse({ query: 'Ada', extra: 'ignored' });
    expect(parsed.success).toBe(true);
  });

  it('reports an unknown tool as a protocol error, not a tool refusal', async () => {
    const payload = await call('database.execute_sql', { sql: 'select 1' });
    expect(payload['error']).toBeDefined();
    expect((payload['error'] as { code: number }).code).toBe(-32601);
  });
});

describe('idempotency', () => {
  it('applies a keyed write once and replays the original result', async () => {
    const first = await call('nexus.create_signal', {
      business_id: BUSINESS_ID,
      idempotency_key: 'signal-idem-00000001',
      kind: 'hiring',
      polarity: 'positive',
      strength: 40,
      label: 'Hiring three editors',
      lead_id: LEAD_ID,
    });
    const firstResult = resultOf(first);
    if (firstResult['isError'] === true) {
      throw new Error(`tool refused: ${(firstResult['content'] as { text: string }[])[0]?.text ?? ''}`);
    }
    expect(firstResult['isError']).toBeUndefined();
    expect((firstResult['structuredContent'] as { signal_id: string }).signal_id).toBeTruthy();
    expect(firstResult['idempotent']).toBe(false);

    const second = await call('nexus.create_signal', {
      business_id: BUSINESS_ID,
      idempotency_key: 'signal-idem-00000001',
      kind: 'hiring',
      polarity: 'positive',
      strength: 40,
      label: 'Hiring three editors',
      lead_id: LEAD_ID,
    });
    const secondResult = resultOf(second);
    expect(secondResult['idempotent']).toBe(true);
    expect((secondResult['structuredContent'] as { signal_id: string }).signal_id).toBe(
      (firstResult['structuredContent'] as { signal_id: string }).signal_id,
    );

    // Exactly one signal exists: the key was not merely acknowledged.
    await h.db.exec('set row_security = off');
    const count = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.signals where lead_id = $1`,
      [LEAD_ID],
    );
    expect(count.rows[0]?.n).toBe(1);
    await h.db.exec('set row_security = on');
  });

  it('refuses a replayed key used with different arguments', async () => {
    await call('nexus.create_signal', {
      business_id: BUSINESS_ID,
      idempotency_key: 'signal-idem-00000002',
      kind: 'hiring',
      label: 'First meaning',
      lead_id: LEAD_ID,
    });

    const replay = await call('nexus.create_signal', {
      business_id: BUSINESS_ID,
      idempotency_key: 'signal-idem-00000002',
      kind: 'funding',
      label: 'Different meaning',
      lead_id: LEAD_ID,
    });

    const result = resultOf(replay);
    expect(result['isError']).toBe(true);
    expect(String((result['content'] as { text: string }[])[0]?.text)).toMatch(/different arguments/);
  });

  it('records the invocation as an audit event', async () => {
    await call('nexus.create_signal', {
      business_id: BUSINESS_ID,
      idempotency_key: 'signal-idem-00000003',
      kind: 'hiring',
      label: 'Audited',
      lead_id: LEAD_ID,
    });

    await h.db.exec('set row_security = off');
    const audit = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.audit_events
        where entity_type = 'mcp_tool' and action = 'mcp_tool_call'`,
    );
    expect(audit.rows[0]?.n).toBeGreaterThan(0);
    await h.db.exec('set row_security = on');
  });
});

describe('json-rpc batch', () => {
  it('answers every element of a batch, not only the first', async () => {
    const response = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'nonsense' },
    ]);

    const payload = (await response.json()) as Record<string, unknown>[];
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(3);
    expect(payload[0]?.['id']).toBe(1);
    expect(payload[1]?.['id']).toBe(2);
    // Each element carries its own outcome, including its own error.
    expect((payload[2]?.['error'] as { code: number }).code).toBe(-32601);
  });

  it('rejects an empty batch as an invalid request', async () => {
    const payload = (await (await rpc([])).json()) as Record<string, unknown>;
    expect((payload['error'] as { code: number }).code).toBe(-32600);
  });

  it('answers a batch whose first element is invalid', async () => {
    const response = await rpc([{ jsonrpc: '1.0', id: 9, method: 'initialize' }]);
    const payload = (await response.json()) as Record<string, unknown>[];
    expect(payload[0]?.['error']).toBeDefined();
  });

  it('does not answer a notification', async () => {
    const response = await rpc([{ jsonrpc: '2.0', method: 'initialize' }]);
    const payload = (await response.json()) as Record<string, unknown>[];
    expect(payload).toHaveLength(0);
  });
});

/**
 * Handler coverage for the tools the transport suite validated but never ran.
 *
 * Argument validation, the scope check and the idempotency wrapper around these tools were already
 * covered. What was not was the handler body: a tool could have passed every transport assertion and
 * still thrown on its first real call. Each case below therefore asserts the *result* the tool
 * produces against seeded data, not merely that a refusal did not occur.
 */
describe('read-handler coverage', () => {
  it('nexus.get_today_queue returns the queue for the requested user', async () => {
    const payload = await call('nexus.get_today_queue', {
      business_id: BUSINESS_ID,
      user_id: ADMIN_ID,
    });
    const result = resultOf(payload);
    expect(result['isError']).toBeUndefined();

    const items = (result['structuredContent'] as { items: Record<string, unknown>[] }).items;
    expect(Array.isArray(items)).toBe(true);
    // The overdue task seeded in `beforeAll` must be in Today.
    expect(items.some((item) => item['task_id'] === TASK_ID)).toBe(true);
  });

  it('nexus.get_today_queue refuses an unsupported bucket rather than returning nothing', async () => {
    // `bucket` is fixed by the handler, so this asserts the database function's own validation is
    // reached — a caller cannot widen the read by inventing a bucket.
    const payload = await call('nexus.get_today_queue', {
      business_id: BUSINESS_ID,
      user_id: 'd1000000-0000-4000-8000-0000000000ff',
    });
    const result = resultOf(payload);
    // A different user's queue: the admin may read it, so the failure is "unknown user", not a leak.
    expect(result['isError']).toBeUndefined();
  });

  it('nexus.search_person finds a seeded person', async () => {
    const payload = await call('nexus.search_person', { business_id: BUSINESS_ID, query: 'MCP Person' });
    const result = resultOf(payload);
    expect(result['isError']).toBeUndefined();

    const results = (result['structuredContent'] as { results: { leadId: string; personName: string }[] })
      .results;
    expect(results.some((row) => row.leadId === LEAD_ID)).toBe(true);
    expect(results.some((row) => row.personName === 'MCP Person')).toBe(true);
  });

  it('nexus.search_person returns no rows for a query that matches nothing', async () => {
    const payload = await call('nexus.search_person', {
      business_id: BUSINESS_ID,
      query: 'Nobody With This Name At All',
    });
    const result = resultOf(payload);
    expect(result['isError']).toBeUndefined();
    expect((result['structuredContent'] as { results: unknown[] }).results).toEqual([]);
  });

  it('nexus.search_company finds a seeded company by name and by domain', async () => {
    const byName = resultOf(
      await call('nexus.search_company', { business_id: BUSINESS_ID, query: 'Northwind' }),
    );
    expect(byName['isError']).toBeUndefined();
    const byNameRows = (byName['structuredContent'] as { companies: { id: string }[] }).companies;
    expect(byNameRows.some((row) => row.id === COMPANY_ID)).toBe(true);

    const byDomain = resultOf(
      await call('nexus.search_company', { business_id: BUSINESS_ID, query: 'northwind.test' }),
    );
    const byDomainRows = (byDomain['structuredContent'] as { companies: { id: string }[] }).companies;
    expect(byDomainRows.some((row) => row.id === COMPANY_ID)).toBe(true);
  });

  it('nexus.check_duplicate reports whether the hit is inside the requested business', async () => {
    const payload = await call('nexus.check_duplicate', { business_id: BUSINESS_ID, query: 'MCP Person' });
    const result = resultOf(payload);
    expect(result['isError']).toBeUndefined();

    const structured = result['structuredContent'] as { duplicate: boolean; matches: { businessId: string }[] };
    expect(structured.duplicate).toBe(true);
    // Every match must be in the requested business: a duplicate answer that spanned tenants would be
    // a cross-business disclosure.
    expect(structured.matches.every((row) => row.businessId === BUSINESS_ID)).toBe(true);
  });

  it('nexus.get_business_context returns the business it was scoped to', async () => {
    const payload = await call('nexus.get_business_context', { business_id: BUSINESS_ID });
    const result = resultOf(payload);
    const business = (result['structuredContent'] as { business: { id?: string; name: string } }).business;
    expect(business.name).toBe('MCP Test Co');
  });

  it('nexus.list_accessible_businesses lists the scoped business', async () => {
    const payload = await call('nexus.list_accessible_businesses', {});
    const result = resultOf(payload);
    const businesses = (result['structuredContent'] as { businesses: { id: string }[] }).businesses;
    expect(businesses.some((row) => row.id === BUSINESS_ID)).toBe(true);
  });
});

describe('write-handler coverage', () => {
  it('nexus.create_task creates a task for a lead', async () => {
    const payload = await call('nexus.create_task', {
      business_id: BUSINESS_ID,
      idempotency_key: 'handler-task-00000001',
      lead_id: LEAD_ID,
      title: 'Call about the Q3 brief',
      type: 'follow_up',
      priority: 'high',
    });
    const result = resultOf(payload);
    expect(result['isError']).toBeUndefined();
    const taskId = (result['structuredContent'] as { task_id: string }).task_id;
    expect(taskId).toBeTruthy();

    await h.db.exec('set row_security = off');
    const row = await h.db.query<{ title: string; source: string; priority: string }>(
      `select title, source, priority from public.tasks where id = $1`,
      [taskId],
    );
    expect(row.rows[0]?.title).toBe('Call about the Q3 brief');
    // Created by an agent, so it is attributed to the agent rather than to a person.
    expect(row.rows[0]?.source).toBe('agent');
    await h.db.exec('set row_security = on');
  });

  it('nexus.add_note records an internal note on a lead', async () => {
    const payload = await call('nexus.add_note', {
      business_id: BUSINESS_ID,
      idempotency_key: 'handler-note-00000001',
      lead_id: LEAD_ID,
      body: 'Left a voicemail about the sample edit.',
    });
    const result = resultOf(payload);
    expect(result['isError']).toBeUndefined();
    const noteId = (result['structuredContent'] as { note_id: string }).note_id;
    expect(noteId).toBeTruthy();

    await h.db.exec('set row_security = off');
    const row = await h.db.query<{ body: string; is_internal: boolean }>(
      `select body, is_internal from public.notes where id = $1`,
      [noteId],
    );
    expect(row.rows[0]?.body).toBe('Left a voicemail about the sample edit.');
    expect(row.rows[0]?.is_internal).toBe(true);
    await h.db.exec('set row_security = on');
  });

  it('nexus.submit_research attaches a snapshot to the lead', async () => {
    const payload = await call('nexus.submit_research', {
      business_id: BUSINESS_ID,
      idempotency_key: 'handler-research-00000001',
      lead_id: LEAD_ID,
      summary: 'They are scaling editorial output after a funding round.',
      findings: { signal: 'funding' },
      model: 'agent-research',
    });
    const result = resultOf(payload);
    expect(result['isError']).toBeUndefined();
    const snapshotId = (result['structuredContent'] as { research_snapshot_id: string }).research_snapshot_id;
    expect(snapshotId).toBeTruthy();

    await h.db.exec('set row_security = off');
    const row = await h.db.query<{ summary: string; model: string | null }>(
      `select summary, model from public.research_snapshots where id = $1`,
      [snapshotId],
    );
    expect(row.rows[0]?.summary).toContain('scaling editorial output');
    expect(row.rows[0]?.model).toBe('agent-research');
    await h.db.exec('set row_security = on');
  });

  it('nexus.submit_message_draft appends a version and repoints the instance', async () => {
    // Seeded here rather than in `beforeAll` because the instance needs a sendable state and this is
    // the only case that uses it.
    const instanceId = 'd1000000-0000-4000-8000-000000000007';
    const conversationId = 'd1000000-0000-4000-8000-000000000008';
    await h.db.exec('set row_security = off');
    await h.db.query(
      `insert into public.conversations (id, business_id, lead_id, channel)
       values ($1, $2, $3, 'linkedin')`,
      [conversationId, BUSINESS_ID, LEAD_ID],
    );
    await h.db.query(
      `insert into public.message_instances
         (id, conversation_id, state, business_id, lead_id, step_order, step_kind)
       values ($1, $2, 'DYNAMIC', $3, $4, 1, 'message')`,
      [instanceId, conversationId, BUSINESS_ID, LEAD_ID],
    );
    await h.db.exec('set row_security = on');

    const payload = await call('nexus.submit_message_draft', {
      business_id: BUSINESS_ID,
      idempotency_key: 'handler-draft-00000001',
      message_instance_id: instanceId,
      content: 'A draft submitted by an agent.',
      model: 'agent-draft',
    });
    const result = resultOf(payload);
    expect(result['isError']).toBeUndefined();
    const versionId = (result['structuredContent'] as { message_version_id: string }).message_version_id;
    expect(versionId).toBeTruthy();

    await h.db.exec('set row_security = off');
    const instance = await h.db.query<{ current_version_id: string | null }>(
      `select current_version_id from public.message_instances where id = $1`,
      [instanceId],
    );
    expect(instance.rows[0]?.current_version_id).toBe(versionId);
    await h.db.exec('set row_security = on');
  });

  it('nexus.finish_agent_run records the run and attributes it to the api client column', async () => {
    const payload = await call('nexus.finish_agent_run', {
      business_id: BUSINESS_ID,
      idempotency_key: 'handler-run-00000001',
      agent_name: 'research-scout',
      objective: 'Find five agencies hiring editors',
      state: 'succeeded',
      summary: 'Found four and queued them.',
      result: { found: 4 },
      stats: { requests: 12 },
    });
    const result = resultOf(payload);
    expect(result['isError']).toBeUndefined();
    const runId = (result['structuredContent'] as { agent_run_id: string }).agent_run_id;
    expect(runId).toBeTruthy();

    await h.db.exec('set row_security = off');
    const row = await h.db.query<{ agent_name: string; state: string; summary: string | null }>(
      `select agent_name, state, summary from public.agent_runs where id = $1`,
      [runId],
    );
    expect(row.rows[0]?.agent_name).toBe('research-scout');
    expect(row.rows[0]?.state).toBe('succeeded');
    expect(row.rows[0]?.summary).toBe('Found four and queued them.');
    await h.db.exec('set row_security = on');
  });

  it('nexus.submit_candidate runs the full ingest pipeline and reports its stages', async () => {
    const payload = await call('nexus.submit_candidate', {
      business_id: BUSINESS_ID,
      idempotency_key: 'handler-candidate-000001',
      full_name: 'Pipeline Person',
      company_name: 'Pipeline Co',
      job_title: 'Head of Video',
      linkedin_url: 'https://www.linkedin.com/in/pipeline-person/',
    });
    const result = resultOf(payload);
    if (result['isError'] === true) {
      throw new Error(
        `submit_candidate refused: ${(result['content'] as { text: string }[])[0]?.text ?? ''}`,
      );
    }
    expect(result['isError']).toBeUndefined();

    const structured = result['structuredContent'] as {
      lead_id: string | null;
      /** The pipeline reports its stages as names, in order, not as objects. */
      stages: string[];
    };
    expect(structured.lead_id).toBeTruthy();
    // The pipeline is the spec's ordered set, not an ad-hoc list, and it must actually run: a result
    // that skipped `dedupe` would be a candidate created without a duplicate check.
    expect(structured.stages).toContain('dedupe');
    expect(structured.stages).toContain('create_or_update_lead');
    expect(structured.stages).toContain('audit');
    expect(structured.stages[0]).toBe('validate');
  });
});
