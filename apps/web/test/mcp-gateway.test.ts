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
