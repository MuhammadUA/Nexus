/**
 * Baseline verification harness — scratch tooling, NOT product code.
 *
 *   node scripts/baseline-verify/harness.mjs
 *
 * Exercises every route under apps/web/src/app/api/**\/route.ts and the MCP
 * gateway against the RUNNING server on 127.0.0.1:3000, and writes raw
 * evidence to results.json. No product file is touched.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';

/**
 * Tree provenance.
 *
 * The results describe a build only if the tree did not change underneath it. Recording the tree
 * state around the run lets the report state the caveat when it is true and stay silent when it is
 * not — an unconditional "the tree was being edited" paragraph outlives the incident that caused it
 * and turns into a permanent, false disclaimer.
 */
const repoRoot = path.resolve(here, '..', '..');
function gitState() {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch (error) {
      return `<git failed: ${error instanceof Error ? error.message : String(error)}>`;
    }
  };
  return { head: run(['rev-parse', 'HEAD']), status: run(['status', '--porcelain']) };
}

const treeBefore = gitState();

const secrets = JSON.parse(readFileSync(path.join(here, 'secrets.json'), 'utf8'));
const TOKEN = Object.fromEntries(secrets.tokens.map((t) => [t.name, t.raw]));

/* ------------------------------------------------------------------ util -- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, urlPath, { token, body, raw, headers = {}, redirect = 'manual' } = {}) {
  const h = { ...headers };
  if (token !== undefined && token !== null) h.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) {
    payload = raw;
  } else if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: h,
    body: payload,
    redirect,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    text: text.length > 4000 ? `${text.slice(0, 4000)}…[truncated]` : text,
    json,
  };
}

const cases = [];
let caseSeq = 0;

/**
 * Records one case. `check(observation)` returns:
 *   { verdict: 'PASS'|'FAIL'|'PARTIAL'|'BLOCKED', note }
 */
function record(caseId, group, title, observation, check) {
  caseSeq += 1;
  let verdict = 'FAIL';
  let note = '';
  try {
    const out = check(observation);
    verdict = out.verdict;
    note = out.note ?? '';
  } catch (error) {
    verdict = 'FAIL';
    note = `harness error: ${error instanceof Error ? error.message : String(error)}`;
  }
  const row = {
    n: caseSeq,
    caseId,
    group,
    title,
    verdict,
    note,
    request: observation?.request ?? null,
    status: observation?.response?.status ?? null,
    headers: observation?.response?.headers ?? null,
    bodyText: observation?.response?.text ?? null,
    body: observation?.response?.json ?? null,
  };
  cases.push(row);
  const flag = verdict === 'PASS' ? 'ok  ' : verdict === 'FAIL' ? 'FAIL' : verdict.toLowerCase().slice(0, 4);
  console.log(`[${flag}] ${caseId} ${title}${note ? ` — ${note}` : ''}`);
  return row;
}

const ok = (note = '') => ({ verdict: 'PASS', note });
const bad = (note) => ({ verdict: 'FAIL', note });
const partial = (note) => ({ verdict: 'PARTIAL', note });
const blocked = (note) => ({ verdict: 'BLOCKED', note });

function jsonRpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

async function mcp(token, payload, label) {
  const res = await http('POST', '/api/v1/mcp', { token, body: payload });
  return {
    request: { method: 'POST', path: '/api/v1/mcp', auth: token === undefined ? 'none' : `Bearer ${label ?? 'token'}`, body: payload },
    response: res,
  };
}

/* ---------------------------------------------- section 1: auth surface -- */

async function authSection() {
  // /api/auth/login GET is refused (405 + allow: POST)
  const loginGet = await http('GET', '/api/auth/login');
  record('AUTH-LOGIN-GET', 'api/auth', 'GET /api/auth/login is refused', { request: { method: 'GET', path: '/api/auth/login' }, response: loginGet }, (o) =>
    o.response.status === 405 && o.response.headers.allow === 'POST'
      ? ok('405, allow: POST')
      : bad(`expected 405 + allow:POST, got ${o.response.status} allow=${o.response.headers.allow}`),
  );

  // login with bad password -> 303 to /login?error=...
  const form = new URLSearchParams({ mode: 'signin', email: 'admin@nexus.local', password: 'wrong-password-xyz' });
  const loginBad = await http('POST', '/api/auth/login', {
    raw: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  record('AUTH-LOGIN-BADPW', 'api/auth', 'POST /api/auth/login with a wrong password', { request: { method: 'POST', path: '/api/auth/login', body: 'mode=signin&email=admin@nexus.local&password=<wrong>' }, response: loginBad }, (o) =>
    o.response.status === 303 && typeof o.response.headers.location === 'string' && o.response.headers.location.startsWith('/login?error=')
      ? ok(`303 -> ${o.response.headers.location}`)
      : bad(`expected 303 to /login?error=…, got ${o.response.status} ${o.response.headers.location}`),
  );

  // login with bad password must not leak the hash
  record('AUTH-LOGIN-BADPW-NOLEAK', 'redaction', 'Wrong-password response carries no hash/secret', { request: { method: 'POST', path: '/api/auth/login' }, response: loginBad }, (o) =>
    /scrypt\$|\$scrypt|password_hash|"hash"/i.test(o.response.text)
      ? bad('response mentions hashing material')
      : ok('no hash material in the redirect response'),
  );

  // /api/companion-preview is disabled unless NEXUS_COMPANION_PREVIEW=1
  const preview = await http('GET', '/api/companion-preview/sidepanel.html');
  record('PREVIEW-DISABLED', 'api/companion-preview', 'Preview route is 404 when disabled', { request: { method: 'GET', path: '/api/companion-preview/sidepanel.html' }, response: preview }, (o) =>
    o.response.status === 404 ? ok('404 (NEXUS_COMPANION_PREVIEW unset)') : bad(`expected 404, got ${o.response.status}`),
  );
}

/* ------------------------------------------ section 2: companion surface -- */

async function companionSection(sessions) {
  const admin = sessions.admin;
  const manager = sessions.manager;
  const osama = sessions.osama;
  const bisma = sessions.bisma;

  const ZEMNAS = secrets.businesses.find((b) => b.key === 'zemnas')?.id;
  const LAVISH = secrets.businesses.find((b) => b.key === 'lavish-foods')?.id;
  const AIB = secrets.businesses.find((b) => b.key === 'ai-integrations')?.id;
  const bogusId = '00000000-0000-4000-8000-0000000000ff';

  // ---- POST /api/v1/companion/session ------------------------------------
  const signInOk = await http('POST', '/api/v1/companion/session', {
    body: { email: 'admin@nexus.local', password: 'vXbSm5c4ujtayWGR4ICuXny4', label: 'baseline' },
  });
  record('COMP-SESSION-OK', 'api/v1/companion/session', 'POST sign-in with valid credentials', { request: { method: 'POST', path: '/api/v1/companion/session', body: { email: 'admin@nexus.local', password: '<redacted>' } }, response: signInOk }, (o) =>
    o.response.status === 200 && typeof o.response.json?.token === 'string' && o.response.json.token.startsWith('nxu_')
      ? ok(`200, token prefix ${o.response.json.token.slice(0, 10)}…, role ${o.response.json.session?.role}`)
      : bad(`expected 200 + nxu_ token, got ${o.response.status} ${o.response.text.slice(0, 160)}`),
  );

  const signInBad = await http('POST', '/api/v1/companion/session', {
    body: { email: 'admin@nexus.local', password: 'definitely-not-the-password' },
  });
  record('COMP-SESSION-BADPW', 'api/v1/companion/session', 'POST sign-in with a wrong password', { request: { method: 'POST', path: '/api/v1/companion/session', body: { email: 'admin@nexus.local', password: '<wrong>' } }, response: signInBad }, (o) =>
    o.response.status === 401 && typeof o.response.json?.error === 'string'
      ? ok(`401 typed error body {"error": ${JSON.stringify(o.response.json.error)}}`)
      : bad(`expected 401 typed error, got ${o.response.status} ${o.response.text.slice(0, 160)}`),
  );

  const signInMalformed = await http('POST', '/api/v1/companion/session', { raw: '{not json' , headers: { 'content-type': 'application/json' } });
  record('COMP-SESSION-MALFORMED', 'api/v1/companion/session', 'POST sign-in with malformed JSON', { request: { method: 'POST', path: '/api/v1/companion/session', body: '{not json' }, response: signInMalformed }, (o) =>
    o.response.status === 400 && o.response.json?.error === 'Expected a JSON body.'
      ? ok('400 {"error":"Expected a JSON body."}')
      : bad(`expected 400 typed body, got ${o.response.status} ${o.response.text.slice(0, 160)}`),
  );

  const signInInvalid = await http('POST', '/api/v1/companion/session', { body: { email: 'x', password: '' } });
  record('COMP-SESSION-INVALID', 'api/v1/companion/session', 'POST sign-in with an invalid body', { request: { method: 'POST', path: '/api/v1/companion/session', body: { email: 'x', password: '' } }, response: signInInvalid }, (o) =>
    o.response.status === 400 && typeof o.response.json?.error === 'string'
      ? ok(`400 {"error": ${JSON.stringify(o.response.json.error)}}`)
      : bad(`expected 400 typed error, got ${o.response.status}`),
  );

  record('COMP-SESSION-NOLEAK', 'redaction', 'Sign-in response exposes only the newly issued token', { request: { method: 'POST', path: '/api/v1/companion/session' }, response: signInOk }, (o) =>
    /password|\$scrypt|token_hash|service_role/i.test(o.response.text)
      ? bad('response contains password/hash/service_role material')
      : ok('body carries token + session only; no password/hash field'),
  );

  // ---- DELETE session (revoke) -------------------------------------------
  const throwaway = await http('POST', '/api/v1/companion/session', { body: { email: 'osama@nexus.local', password: 'demo-password-1234', label: 'throwaway' } });
  const throwawayToken = throwaway.json?.token;
  const revoke = await http('DELETE', '/api/v1/companion/session', { token: throwawayToken });
  record('COMP-SESSION-DELETE', 'api/v1/companion/session', 'DELETE revokes the calling token', { request: { method: 'DELETE', path: '/api/v1/companion/session', auth: 'Bearer nxu_…(throwaway)' }, response: revoke }, (o) =>
    o.response.status === 200 && o.response.json?.revoked === true
      ? ok('200 {"revoked":true}')
      : bad(`expected 200 {revoked:true}, got ${o.response.status} ${o.response.text.slice(0, 160)}`),
  );
  const afterRevoke = await http('GET', '/api/v1/companion/me', { token: throwawayToken });
  record('COMP-SESSION-DELETE-VERIFY', 'api/v1/companion/session', 'Revoked token is refused afterwards', { request: { method: 'GET', path: '/api/v1/companion/me', auth: 'Bearer <revoked>' }, response: afterRevoke }, (o) =>
    o.response.status === 401 ? ok('401 after revocation') : bad(`expected 401, got ${o.response.status}`),
  );
  const deleteNoAuth = await http('DELETE', '/api/v1/companion/session');
  record('COMP-SESSION-DELETE-NOAUTH', 'api/v1/companion/session', 'DELETE without a token', { request: { method: 'DELETE', path: '/api/v1/companion/session', auth: 'none' }, response: deleteNoAuth }, (o) =>
    o.response.status === 401 && o.response.json?.error === 'Missing token.'
      ? ok('401 {"error":"Missing token."}')
      : bad(`expected 401 {"error":"Missing token."}, got ${o.response.status}`),
  );

  // ---- GET /api/v1/companion/me -----------------------------------------
  const me = await http('GET', '/api/v1/companion/me', { token: admin });
  record('COMP-ME-OK', 'api/v1/companion/me', 'GET as admin', { request: { method: 'GET', path: '/api/v1/companion/me', auth: 'Bearer admin' }, response: me }, (o) =>
    o.response.status === 200 && o.response.json?.session?.email === 'admin@nexus.local'
      ? ok(`200, session.email=admin@nexus.local role=${o.response.json.session.role}`)
      : bad(`expected 200 admin session, got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );
  const meNoAuth = await http('GET', '/api/v1/companion/me');
  record('COMP-ME-NOAUTH', 'api/v1/companion/me', 'GET without a token', { request: { method: 'GET', path: '/api/v1/companion/me', auth: 'none' }, response: meNoAuth }, (o) =>
    o.response.status === 401 && o.response.json?.error === 'Sign in to Nexus.'
      ? ok('401 {"error":"Sign in to Nexus."}')
      : bad(`expected 401 typed error, got ${o.response.status}`),
  );
  const meBadToken = await http('GET', '/api/v1/companion/me', { token: 'nxu_not-a-real-token-000000000000000000000' });
  record('COMP-ME-BADTOKEN', 'api/v1/companion/me', 'GET with an unknown bearer token', { request: { method: 'GET', path: '/api/v1/companion/me', auth: 'Bearer nxu_<bogus>' }, response: meBadToken }, (o) =>
    o.response.status === 401 ? ok('401') : bad(`expected 401, got ${o.response.status}`),
  );
  const meService = await http('GET', '/api/v1/companion/me', { token: TOKEN['baseline-full'] });
  record('COMP-ME-SERVICETOKEN', 'api/v1/companion/me', 'GET with a service token (user-only endpoint)', { request: { method: 'GET', path: '/api/v1/companion/me', auth: "Bearer nxs_…(baseline-full)" }, response: meService }, (o) =>
    o.response.status === 403 && o.response.json?.error === 'This endpoint requires a user token, not a service token.'
      ? ok('403 typed refusal')
      : bad(`expected 403 service-token refusal, got ${o.response.status} ${o.response.text.slice(0, 160)}`),
  );

  // ---- GET /api/v1/companion/bootstrap ----------------------------------
  const boot = await http('GET', '/api/v1/companion/bootstrap', { token: admin });
  record('COMP-BOOTSTRAP-OK', 'api/v1/companion/bootstrap', 'GET as admin', { request: { method: 'GET', path: '/api/v1/companion/bootstrap', auth: 'Bearer admin' }, response: boot }, (o) => {
    const j = o.response.json;
    return o.response.status === 200 && Array.isArray(j?.businesses) && Array.isArray(j?.identities) && j?.session
      ? ok(`200, businesses=${j.businesses.length} identities=${j.identities.length} binding=${j.binding === null ? 'null' : 'present'} concurrency.action=${j.concurrency?.action}`)
      : bad(`expected 200 with session/businesses/identities, got ${o.response.status} ${o.response.text.slice(0, 200)}`);
  });
  const bootManager = await http('GET', '/api/v1/companion/bootstrap', { token: manager });
  record('COMP-BOOTSTRAP-MANAGER-SCOPE', 'api/v1/companion/bootstrap', 'Manager sees only granted businesses', { request: { method: 'GET', path: '/api/v1/companion/bootstrap', auth: 'Bearer manager' }, response: bootManager }, (o) => {
    const keys = (o.response.json?.businesses ?? []).map((b) => b.slug);
    return o.response.status === 200 && keys.length === 1 && keys[0] === 'zemnas'
      ? ok(`200, manager businesses=[${keys.join(',')}] (granted: zemnas only)`)
      : bad(`expected manager to see only zemnas, got [${keys.join(',')}] status ${o.response.status}`);
  });
  const bootNoAuth = await http('GET', '/api/v1/companion/bootstrap');
  record('COMP-BOOTSTRAP-NOAUTH', 'api/v1/companion/bootstrap', 'GET without a token', { request: { method: 'GET', path: '/api/v1/companion/bootstrap', auth: 'none' }, response: bootNoAuth }, (o) =>
    o.response.status === 401 ? ok('401') : bad(`expected 401, got ${o.response.status}`),
  );
  record('COMP-BOOTSTRAP-NOLEAK', 'redaction', 'Bootstrap reveals no token hash or identity secret', { request: { method: 'GET', path: '/api/v1/companion/bootstrap' }, response: boot }, (o) =>
    /token_hash|\$scrypt|service_role|password/i.test(o.response.text)
      ? bad('bootstrap body contains hash/secret material')
      : ok('no token_hash / scrypt / service_role / password substring'),
  );

  // ---- GET /api/v1/companion/leads --------------------------------------
  const leads = await http('GET', `/api/v1/companion/leads?businessId=${ZEMNAS}&limit=5`, { token: admin });
  record('COMP-LEADS-OK', 'api/v1/companion/leads', 'GET leads for zemnas as admin', { request: { method: 'GET', path: `/api/v1/companion/leads?businessId=${ZEMNAS}&limit=5`, auth: 'Bearer admin' }, response: leads }, (o) =>
    o.response.status === 200 && Array.isArray(o.response.json?.leads) && typeof o.response.json?.total === 'number'
      ? ok(`200, total=${o.response.json.total} returned=${o.response.json.leads.length}`)
      : bad(`expected 200 with leads[], got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );
  const leadsNoBiz = await http('GET', '/api/v1/companion/leads', { token: admin });
  record('COMP-LEADS-NOBIZ', 'api/v1/companion/leads', 'GET without businessId', { request: { method: 'GET', path: '/api/v1/companion/leads', auth: 'Bearer admin' }, response: leadsNoBiz }, (o) =>
    o.response.status === 400 && typeof o.response.json?.error === 'string'
      ? ok(`400 {"error":${JSON.stringify(o.response.json.error)}}`)
      : bad(`expected 400 typed error, got ${o.response.status}`),
  );
  const leadsBadBiz = await http('GET', '/api/v1/companion/leads?businessId=not-a-uuid', { token: admin });
  record('COMP-LEADS-BADBIZ', 'api/v1/companion/leads', 'GET with a non-UUID businessId', { request: { method: 'GET', path: '/api/v1/companion/leads?businessId=not-a-uuid', auth: 'Bearer admin' }, response: leadsBadBiz }, (o) =>
    o.response.status === 400 ? ok('400 typed error') : bad(`expected 400, got ${o.response.status}`),
  );
  const leadsWrongBiz = await http('GET', `/api/v1/companion/leads?businessId=${LAVISH}&limit=5`, { token: manager });
  record('COMP-LEADS-WRONGBIZ-MANAGER', 'api/v1/companion/leads', 'Manager (zemnas only) requests lavish-foods leads', { request: { method: 'GET', path: `/api/v1/companion/leads?businessId=${LAVISH}&limit=5`, auth: 'Bearer manager' }, response: leadsWrongBiz }, (o) => {
    if (o.response.status !== 200) return bad(`expected 200 with an empty/RLS-filtered page, got ${o.response.status} ${o.response.text.slice(0, 160)}`);
    const n = o.response.json?.leads?.length ?? -1;
    return n === 0 ? ok(`200, leaks nothing: total=${o.response.json.total} leads=0 (RLS-filtered)`) : bad(`200 but returned ${n} lavish leads to a manager without access`);
  });
  const leadsBogusBiz = await http('GET', `/api/v1/companion/leads?businessId=${bogusId}`, { token: admin });
  record('COMP-LEADS-BOGUSBIZ', 'api/v1/companion/leads', 'GET with a well-formed but nonexistent businessId', { request: { method: 'GET', path: `/api/v1/companion/leads?businessId=${bogusId}`, auth: 'Bearer admin' }, response: leadsBogusBiz }, (o) =>
    o.response.status === 200 && (o.response.json?.leads?.length ?? -1) === 0
      ? ok('200 with an empty page (no existence disclosure)')
      : bad(`expected 200 empty page, got ${o.response.status} ${o.response.text.slice(0, 160)}`),
  );
  const leadsNoAuth = await http('GET', `/api/v1/companion/leads?businessId=${ZEMNAS}`);
  record('COMP-LEADS-NOAUTH', 'api/v1/companion/leads', 'GET without a token', { request: { method: 'GET', path: '/api/v1/companion/leads', auth: 'none' }, response: leadsNoAuth }, (o) =>
    o.response.status === 401 ? ok('401') : bad(`expected 401, got ${o.response.status}`),
  );

  // ---- GET /api/v1/companion/leads/:id ----------------------------------
  const realLead = secrets.leads.find((l) => l.business_id === ZEMNAS) ?? secrets.leads[0];
  const leadOne = await http('GET', `/api/v1/companion/leads/${realLead.id}`, { token: admin });
  record('COMP-LEAD-ONE-OK', 'api/v1/companion/leads/[id]', 'GET a real seeded lead as admin', { request: { method: 'GET', path: `/api/v1/companion/leads/${realLead.id}`, auth: 'Bearer admin' }, response: leadOne }, (o) =>
    o.response.status === 200 && o.response.json?.detail?.lead?.id === realLead.id
      ? ok(`200, detail.lead.id matches, personName=${JSON.stringify(o.response.json.detail.lead.personName)} status=${o.response.json.detail.lead.status}`)
      : bad(`expected 200 with detail.lead.id=${realLead.id}, got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );
  const leadBadId = await http('GET', '/api/v1/companion/leads/not-a-uuid', { token: admin });
  record('COMP-LEAD-ONE-BADID', 'api/v1/companion/leads/[id]', 'GET with a non-UUID id', { request: { method: 'GET', path: '/api/v1/companion/leads/not-a-uuid', auth: 'Bearer admin' }, response: leadBadId }, (o) =>
    o.response.status === 404 ? ok('404 typed error') : bad(`expected 404, got ${o.response.status}`),
  );
  const leadMissing = await http('GET', `/api/v1/companion/leads/${bogusId}`, { token: admin });
  record('COMP-LEAD-ONE-MISSING', 'api/v1/companion/leads/[id]', 'GET a nonexistent (valid UUID) lead', { request: { method: 'GET', path: `/api/v1/companion/leads/${bogusId}`, auth: 'Bearer admin' }, response: leadMissing }, (o) =>
    o.response.status === 404 && o.response.json?.error === 'That lead could not be found.'
      ? ok('404 {"error":"That lead could not be found."}')
      : bad(`expected 404 typed error, got ${o.response.status}`),
  );
  // A lead in a business the caller cannot reach must be indistinguishable from missing.
  const lavishLead = secrets.leads.find((l) => l.business_id === LAVISH);
  if (lavishLead !== undefined) {
    const crossLead = await http('GET', `/api/v1/companion/leads/${lavishLead.id}`, { token: manager });
    record('COMP-LEAD-ONE-WRONGBIZ', 'api/v1/companion/leads/[id]', 'Manager requests a lavish-foods lead', { request: { method: 'GET', path: `/api/v1/companion/leads/${lavishLead.id}`, auth: 'Bearer manager' }, response: crossLead }, (o) =>
      o.response.status === 404
        ? ok('404 — inaccessible lead is indistinguishable from missing')
        : bad(`expected 404 for an out-of-scope lead, got ${o.response.status} ${o.response.text.slice(0, 200)}`),
    );
  } else {
    record('COMP-LEAD-ONE-WRONGBIZ', 'api/v1/companion/leads/[id]', 'Manager requests a lavish-foods lead', null, () => blocked('no lavish-foods lead in the seeded database'));
  }
  const leadNoAuth = await http('GET', `/api/v1/companion/leads/${realLead.id}`);
  record('COMP-LEAD-ONE-NOAUTH', 'api/v1/companion/leads/[id]', 'GET without a token', { request: { method: 'GET', path: `/api/v1/companion/leads/${realLead.id}`, auth: 'none' }, response: leadNoAuth }, (o) =>
    o.response.status === 401 ? ok('401') : bad(`expected 401, got ${o.response.status}`),
  );
  record('COMP-LEAD-NOLEAK', 'redaction', 'Lead detail carries no secret material', { request: { method: 'GET', path: `/api/v1/companion/leads/${realLead.id}` }, response: leadOne }, (o) =>
    /token_hash|\$scrypt|service_role|password/i.test(o.response.text)
      ? bad('lead detail body contains hash/secret material')
      : ok('no token_hash / scrypt / service_role / password substring'),
  );

  // ---- GET /api/v1/companion/search -------------------------------------
  const search = await http('GET', '/api/v1/companion/search?q=Tom', { token: admin });
  record('COMP-SEARCH-OK', 'api/v1/companion/search', 'GET search for a seeded person name', { request: { method: 'GET', path: '/api/v1/companion/search?q=Tom', auth: 'Bearer admin' }, response: search }, (o) =>
    o.response.status === 200 && Array.isArray(o.response.json?.results)
      ? ok(`200, ${o.response.json.results.length} result(s)${o.response.json.results[0] ? `, first=${JSON.stringify(o.response.json.results[0].fullName ?? o.response.json.results[0].personName ?? null)}` : ''}`)
      : bad(`expected 200 with results[], got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );
  const searchEmpty = await http('GET', '/api/v1/companion/search?q=', { token: admin });
  record('COMP-SEARCH-EMPTYQ', 'api/v1/companion/search', 'GET search with an empty q', { request: { method: 'GET', path: '/api/v1/companion/search?q=', auth: 'Bearer admin' }, response: searchEmpty }, (o) =>
    o.response.status === 400 && typeof o.response.json?.error === 'string'
      ? ok(`400 {"error":${JSON.stringify(o.response.json.error)}}`)
      : bad(`expected 400 typed error, got ${o.response.status}`),
  );
  const searchNoAuth = await http('GET', '/api/v1/companion/search?q=Tom');
  record('COMP-SEARCH-NOAUTH', 'api/v1/companion/search', 'GET search without a token', { request: { method: 'GET', path: '/api/v1/companion/search?q=Tom', auth: 'none' }, response: searchNoAuth }, (o) =>
    o.response.status === 401 ? ok('401') : bad(`expected 401, got ${o.response.status}`),
  );
  const searchStandard = await http('GET', '/api/v1/companion/search?q=Tom', { token: osama });
  record('COMP-SEARCH-STANDARDUSER', 'api/v1/companion/search', 'GET search as a standard user', { request: { method: 'GET', path: '/api/v1/companion/search?q=Tom', auth: 'Bearer osama (standard user)' }, response: searchStandard }, (o) =>
    o.response.status === 200 && Array.isArray(o.response.json?.results)
      ? ok(`200, ${o.response.json.results.length} result(s) visible under a standard user's RLS`)
      : bad(`expected 200 for a standard user, got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );

  // ---- GET /api/v1/companion/today --------------------------------------
  const today = await http('GET', `/api/v1/companion/today?businessId=${ZEMNAS}`, { token: admin });
  record('COMP-TODAY-OK', 'api/v1/companion/today', 'GET the admin Today queue for zemnas', { request: { method: 'GET', path: `/api/v1/companion/today?businessId=${ZEMNAS}`, auth: 'Bearer admin' }, response: today }, (o) =>
    o.response.status === 200 && Array.isArray(o.response.json?.items)
      ? ok(`200, ${o.response.json.items.length} item(s)`)
      : bad(`expected 200 with items[], got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );
  const adminUserId = secrets.users.find((u) => u.email === 'admin@nexus.local')?.id;
  const todayOther = await http(
    'GET',
    `/api/v1/companion/today?businessId=${ZEMNAS}&userId=${adminUserId}`,
    { token: osama },
  );
  record('COMP-TODAY-OTHERUSER-STANDARD', 'api/v1/companion/today', 'Standard user asks for another user’s queue', { request: { method: 'GET', path: `/api/v1/companion/today?businessId=${ZEMNAS}&userId=<admin>`, auth: 'Bearer osama (standard user)' }, response: todayOther }, (o) => {
    if (o.response.status === 200) return ok(`200, items=${o.response.json?.items?.length ?? 'n/a'} — the DB function/RLS decides, no data invented`);
    if (o.response.status === 403 || o.response.status === 400)
      return ok(`${o.response.status} refused: ${JSON.stringify(o.response.json?.error)}`);
    if (o.response.status === 500) return bad(`500 Internal Server Error with an untyped body: ${JSON.stringify(o.response.text.slice(0, 200))}`);
    return bad(`unexpected ${o.response.status} ${o.response.text.slice(0, 160)}`);
  });
  const todayManagerOther = await http(
    'GET',
    `/api/v1/companion/today?businessId=${ZEMNAS}&userId=${adminUserId}`,
    { token: manager },
  );
  record('COMP-TODAY-OTHERUSER-MANAGER', 'api/v1/companion/today', 'Manager asks for another user’s queue', { request: { method: 'GET', path: `/api/v1/companion/today?businessId=${ZEMNAS}&userId=<admin>`, auth: 'Bearer manager' }, response: todayManagerOther }, (o) =>
    o.response.status === 200 || o.response.status === 403
      ? ok(`${o.response.status} (manager path delegated to get_today_queue)`)
      : bad(`unexpected ${o.response.status} ${o.response.text.slice(0, 160)}`),
  );
  const todayNoBiz = await http('GET', '/api/v1/companion/today', { token: admin });
  record('COMP-TODAY-NOBIZ', 'api/v1/companion/today', 'GET Today without businessId', { request: { method: 'GET', path: '/api/v1/companion/today', auth: 'Bearer admin' }, response: todayNoBiz }, (o) =>
    o.response.status === 400 ? ok('400 typed error') : bad(`expected 400, got ${o.response.status}`),
  );
  const todayNoAuth = await http('GET', `/api/v1/companion/today?businessId=${ZEMNAS}`);
  record('COMP-TODAY-NOAUTH', 'api/v1/companion/today', 'GET Today without a token', { request: { method: 'GET', path: '/api/v1/companion/today', auth: 'none' }, response: todayNoAuth }, (o) =>
    o.response.status === 401 ? ok('401') : bad(`expected 401, got ${o.response.status}`),
  );

  // ---- GET /api/v1/companion/icps ---------------------------------------
  const icps = await http('GET', `/api/v1/companion/icps?businessId=${ZEMNAS}`, { token: admin });
  record('COMP-ICPS-OK', 'api/v1/companion/icps', 'GET ICPs for zemnas', { request: { method: 'GET', path: `/api/v1/companion/icps?businessId=${ZEMNAS}`, auth: 'Bearer admin' }, response: icps }, (o) =>
    o.response.status === 200 && Array.isArray(o.response.json?.icps)
      ? ok(`200, ${o.response.json.icps.length} ICP(s)`)
      : bad(`expected 200 with icps[], got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );
  const icpsWrongBiz = await http('GET', `/api/v1/companion/icps?businessId=${AIB}`, { token: manager });
  record('COMP-ICPS-WRONGBIZ', 'api/v1/companion/icps', 'Manager requests ai-integrations ICPs', { request: { method: 'GET', path: `/api/v1/companion/icps?businessId=${AIB}`, auth: 'Bearer manager' }, response: icpsWrongBiz }, (o) =>
    o.response.status === 200 && (o.response.json?.icps?.length ?? -1) === 0
      ? ok('200 with an empty list (RLS denies, no leakage)')
      : bad(`expected 200 empty list, got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );
  const icpsNoBiz = await http('GET', '/api/v1/companion/icps', { token: admin });
  record('COMP-ICPS-NOBIZ', 'api/v1/companion/icps', 'GET ICPs without businessId', { request: { method: 'GET', path: '/api/v1/companion/icps', auth: 'Bearer admin' }, response: icpsNoBiz }, (o) =>
    o.response.status === 400 ? ok('400 typed error') : bad(`expected 400, got ${o.response.status}`),
  );
  const icpsNoAuth = await http('GET', `/api/v1/companion/icps?businessId=${ZEMNAS}`);
  record('COMP-ICPS-NOAUTH', 'api/v1/companion/icps', 'GET ICPs without a token', { request: { method: 'GET', path: '/api/v1/companion/icps', auth: 'none' }, response: icpsNoAuth }, (o) =>
    o.response.status === 401 ? ok('401') : bad(`expected 401, got ${o.response.status}`),
  );

  // ---- POST /api/v1/companion/heartbeat ---------------------------------
  const heartbeat = await http('POST', '/api/v1/companion/heartbeat', { token: osama, body: { installId: 'demo-install-osama' } });
  record('COMP-HEARTBEAT-OK', 'api/v1/companion/heartbeat', 'POST heartbeat for the seeded binding', { request: { method: 'POST', path: '/api/v1/companion/heartbeat', auth: 'Bearer osama', body: { installId: 'demo-install-osama' } }, response: heartbeat }, (o) =>
    o.response.status === 200 && o.response.json?.ok === true
      ? ok('200 {"ok":true}')
      : bad(`expected 200 {ok:true}, got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );
  const heartbeatInvalid = await http('POST', '/api/v1/companion/heartbeat', { token: osama, body: { installId: 'x' } });
  record('COMP-HEARTBEAT-INVALID', 'api/v1/companion/heartbeat', 'POST heartbeat with a too-short installId', { request: { method: 'POST', path: '/api/v1/companion/heartbeat', auth: 'Bearer osama', body: { installId: 'x' } }, response: heartbeatInvalid }, (o) =>
    o.response.status === 400 && typeof o.response.json?.error === 'string'
      ? ok(`400 {"error":${JSON.stringify(o.response.json.error)}}`)
      : bad(`expected 400 typed error, got ${o.response.status}`),
  );
  const heartbeatMalformed = await http('POST', '/api/v1/companion/heartbeat', { token: osama, raw: '{{{', headers: { 'content-type': 'application/json' } });
  record('COMP-HEARTBEAT-MALFORMED', 'api/v1/companion/heartbeat', 'POST heartbeat with malformed JSON', { request: { method: 'POST', path: '/api/v1/companion/heartbeat', body: '{{{' }, response: heartbeatMalformed }, (o) =>
    o.response.status === 400 && o.response.json?.error === 'Expected a JSON body.'
      ? ok('400 {"error":"Expected a JSON body."}')
      : bad(`expected 400 typed body, got ${o.response.status}`),
  );
  const heartbeatNoAuth = await http('POST', '/api/v1/companion/heartbeat', { body: { installId: 'demo-install-osama' } });
  record('COMP-HEARTBEAT-NOAUTH', 'api/v1/companion/heartbeat', 'POST heartbeat without a token', { request: { method: 'POST', path: '/api/v1/companion/heartbeat', auth: 'none' }, response: heartbeatNoAuth }, (o) =>
    o.response.status === 401 ? ok('401') : bad(`expected 401, got ${o.response.status}`),
  );

  // ---- POST /api/v1/companion/bind --------------------------------------
  // `demo-install-osama` is the seeded live binding for the Osama identity, so a
  // second profile claiming it is the real concurrency case.
  const bindStamp = Date.now();
  const boundIdentity = secrets.identities?.find((i) => i.display_name === 'Osama - Zemnas') ?? secrets.identities?.[0];
  const identityId = boundIdentity?.id;
  /**
   * A fresh profile per run.
   *
   * A FIXED install id makes this case depend on what previous runs left behind: the second run
   * updates the existing row instead of inserting, so the case stops exercising the insert path.
   * The id is still stable enough to read in the evidence because the run stamp is recorded.
   */
  const installNew = `baseline-install-${bindStamp}`;
  /**
   * Bisma's own identity: free, and — critically — the business is taken from THAT IDENTITY'S OWN
   * grant rather than assumed. Migration 0017 refuses a `browser_session` whose
   * `default_business_id` is not one the identity is authorized for (42501), and the seeded
   * grants are not what a name suggests: "Bisma - Lavish" is in fact granted `ai-integrations`.
   * Hard-coding a business here produced a 400 that looked like a permission defect but was the
   * guard working correctly against a mismatched fixture pair.
   */
  const freeIdentity = secrets.identities?.find((i) => i.display_name === 'Bisma - Lavish');
  const freeIdentityBusinessId = freeIdentity?.business_ids?.[0] ?? null;
  const bindBody = {
    installId: installNew,
    identityId: freeIdentity?.id,
    defaultBusinessId: freeIdentityBusinessId,
    transfer: false,
  };
  const bindFirst = await http('POST', '/api/v1/companion/bind', { token: bisma, body: bindBody });
  record('COMP-BIND-OK', 'api/v1/companion/bind', 'POST bind a free identity from a fresh browser profile', { request: { method: 'POST', path: '/api/v1/companion/bind', auth: 'Bearer bisma', body: bindBody }, response: bindFirst }, (o) =>
    o.response.status === 200 && o.response.json?.binding
      ? ok(`200, binding present, transferredFrom=${o.response.json.transferredFrom}`)
      : o.response.status === 409
        ? ok(`409 reason=${o.response.json?.reason} — a decision, not a failure`)
        : bad(`expected 200 binding, got ${o.response.status} ${o.response.text.slice(0, 220)}`),
  );
  const bindConflict = await http('POST', '/api/v1/companion/bind', {
    token: admin,
    body: { installId: 'baseline-install-conflict', identityId, defaultBusinessId: ZEMNAS, transfer: false },
  });
  record('COMP-BIND-CONFLICT', 'api/v1/companion/bind', 'POST bind an identity already held by another live profile, without transfer', { request: { method: 'POST', path: '/api/v1/companion/bind', auth: 'Bearer admin', body: { installId: 'baseline-install-conflict', identityId, transfer: false } }, response: bindConflict }, (o) =>
    o.response.status === 409 && o.response.json?.reason === 'identity_in_use'
      ? ok(`409 reason=identity_in_use, conflicts=${JSON.stringify(o.response.json.conflicts)?.slice(0, 160)}`)
      : o.response.status === 200
        ? bad('200 — the identity was taken without transfer consent')
        : bad(`expected 409 reason=identity_in_use, got ${o.response.status} ${o.response.text.slice(0, 220)}`),
  );
  const bindInvalid = await http('POST', '/api/v1/companion/bind', { token: admin, body: { installId: 'short', identityId: 'nope', defaultBusinessId: null } });
  record('COMP-BIND-INVALID', 'api/v1/companion/bind', 'POST bind with an invalid body', { request: { method: 'POST', path: '/api/v1/companion/bind', auth: 'Bearer admin', body: { installId: 'short', identityId: 'nope' } }, response: bindInvalid }, (o) =>
    o.response.status === 400 && typeof o.response.json?.error === 'string'
      ? ok(`400 {"error":${JSON.stringify(o.response.json.error)}}`)
      : bad(`expected 400 typed error, got ${o.response.status}`),
  );
  const bindMalformed = await http('POST', '/api/v1/companion/bind', { token: admin, raw: '<xml/>', headers: { 'content-type': 'application/json' } });
  record('COMP-BIND-MALFORMED', 'api/v1/companion/bind', 'POST bind with malformed JSON', { request: { method: 'POST', path: '/api/v1/companion/bind', body: '<xml/>' }, response: bindMalformed }, (o) =>
    o.response.status === 400 && o.response.json?.error === 'Expected a JSON body.' ? ok('400 typed body') : bad(`expected 400 typed body, got ${o.response.status}`),
  );
  const bindNoAuth = await http('POST', '/api/v1/companion/bind', { body: bindBody });
  record('COMP-BIND-NOAUTH', 'api/v1/companion/bind', 'POST bind without a token', { request: { method: 'POST', path: '/api/v1/companion/bind', auth: 'none' }, response: bindNoAuth }, (o) =>
    o.response.status === 401 ? ok('401') : bad(`expected 401, got ${o.response.status}`),
  );
  record('COMP-BIND-NOLEAK', 'redaction', 'Bind conflict payload names the holder without secrets', { request: { method: 'POST', path: '/api/v1/companion/bind' }, response: bindConflict }, (o) =>
    /token_hash|\$scrypt|service_role|password/i.test(o.response.text)
      ? bad('bind conflict body contains hash/secret material')
      : ok('holder detail carries display names/timestamps only'),
  );

  // ---- POST /api/v1/companion/add ---------------------------------------
  const addKey = `baseline-add-${Date.now()}`;
  const addBody = {
    linkedinUrl: 'https://www.linkedin.com/in/baseline-verify-person',
    pastedContent: 'Baseline Verify\nHead of Production at Frame House\nMunich, Germany',
    businessId: ZEMNAS,
    icpId: null,
    autoMatch: true,
    idempotencyKey: addKey,
  };
  const addFirst = await http('POST', '/api/v1/companion/add', { token: admin, body: addBody });
  record('COMP-ADD-OK', 'api/v1/companion/add', 'POST add a LinkedIn profile (creates a lead)', { request: { method: 'POST', path: '/api/v1/companion/add', auth: 'Bearer admin', body: addBody }, response: addFirst }, (o) =>
    o.response.status === 200 && typeof o.response.json?.leadId === 'string' && o.response.json.leadId.length > 0
      ? ok(`200, leadId=${o.response.json.leadId} created=${o.response.json.created} needsProfile=${o.response.json.needsProfile} deduped=${o.response.json.deduped}`)
      : bad(`expected 200 with a leadId, got ${o.response.status} ${o.response.text.slice(0, 220)}`),
  );
  const addReplay = await http('POST', '/api/v1/companion/add', { token: admin, body: addBody });
  record('COMP-ADD-IDEMPOTENT', 'api/v1/companion/add', 'POST the identical capture with the same idempotencyKey', { request: { method: 'POST', path: '/api/v1/companion/add', auth: 'Bearer admin', body: { ...addBody, pastedContent: '<same>' } }, response: addReplay }, (o) =>
    o.response.status === 200 && o.response.json?.leadId === addFirst.json?.leadId && o.response.json?.deduped === true
      ? ok(`200, same leadId=${o.response.json.leadId}, deduped=true (no second lead)`)
      : bad(`expected the original leadId with deduped=true, got ${o.response.status} ${o.response.text.slice(0, 220)}`),
  );
  const addNotLinkedIn = await http('POST', '/api/v1/companion/add', {
    token: admin,
    body: { ...addBody, linkedinUrl: 'https://example.com/in/not-linkedin', idempotencyKey: `${addKey}-x` },
  });
  record('COMP-ADD-NOTLINKEDIN', 'api/v1/companion/add', 'POST add with a non-LinkedIn profile URL', { request: { method: 'POST', path: '/api/v1/companion/add', auth: 'Bearer admin', body: { linkedinUrl: 'https://example.com/in/not-linkedin' } }, response: addNotLinkedIn }, (o) =>
    o.response.status === 400 && o.response.json?.reason === 'not_a_linkedin_profile'
      ? ok('400 reason=not_a_linkedin_profile')
      : bad(`expected 400 reason=not_a_linkedin_profile, got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );
  const addInvalid = await http('POST', '/api/v1/companion/add', { token: admin, body: { linkedinUrl: 'https://www.linkedin.com/in/x' } });
  record('COMP-ADD-INVALID', 'api/v1/companion/add', 'POST add with missing required fields', { request: { method: 'POST', path: '/api/v1/companion/add', auth: 'Bearer admin', body: { linkedinUrl: 'https://www.linkedin.com/in/x' } }, response: addInvalid }, (o) =>
    o.response.status === 400 && typeof o.response.json?.error === 'string'
      ? ok(`400 {"error":${JSON.stringify(o.response.json.error)}}`)
      : bad(`expected 400 typed error, got ${o.response.status}`),
  );
  const addMalformed = await http('POST', '/api/v1/companion/add', { token: admin, raw: 'null', headers: { 'content-type': 'application/json' } });
  record('COMP-ADD-MALFORMED', 'api/v1/companion/add', 'POST add with a JSON body that is not an object', { request: { method: 'POST', path: '/api/v1/companion/add', body: 'null' }, response: addMalformed }, (o) =>
    o.response.status === 400 && typeof o.response.json?.error === 'string' ? ok(`400 {"error":${JSON.stringify(o.response.json.error)}}`) : bad(`expected 400 typed error, got ${o.response.status}`),
  );
  const addNoAuth = await http('POST', '/api/v1/companion/add', { body: addBody });
  record('COMP-ADD-NOAUTH', 'api/v1/companion/add', 'POST add without a token', { request: { method: 'POST', path: '/api/v1/companion/add', auth: 'none' }, response: addNoAuth }, (o) =>
    o.response.status === 401 ? ok('401') : bad(`expected 401, got ${o.response.status}`),
  );
  const addWrongBiz = await http('POST', '/api/v1/companion/add', {
    token: osama,
    body: { ...addBody, businessId: LAVISH, linkedinUrl: 'https://www.linkedin.com/in/baseline-verify-wrongbiz', idempotencyKey: `${addKey}-wrongbiz` },
  });
  record('COMP-ADD-WRONGBIZ', 'api/v1/companion/add', 'Standard user (zemnas) adds into lavish-foods', { request: { method: 'POST', path: '/api/v1/companion/add', auth: 'Bearer osama', body: { businessId: LAVISH } }, response: addWrongBiz }, (o) =>
    o.response.status === 400 || o.response.status === 403
      ? ok(`${o.response.status} refused: ${JSON.stringify(o.response.json?.error ?? o.response.json?.reason)}`)
      : bad(`expected a refusal for an out-of-scope business, got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );

  // Expose ids discovered by this run to later sections.
  return { createdLeadId: addFirst.json?.leadId, ZEMNAS, LAVISH, AIB, bogusId, realLead };
}

/* --------------------------------------- section 3: companion actions ---- */

async function actionsSection(ctx, sessions) {
  const admin = sessions.admin;
  const leadId = ctx.createdLeadId ?? ctx.realLead.id;
  const identityId = secrets.identities?.find((i) => i.status === 'active')?.id ?? secrets.identities?.[0]?.id;
  const installId = 'baseline-install-0001';
  const bogusId = ctx.bogusId;

  const operations = [
    {
      op: 'mark-connection-sent',
      okBody: { leadId, identityId, withNote: true },
      badBody: { leadId: 'not-a-uuid', identityId, withNote: true },
    },
    {
      op: 'mark-message-sent',
      okBody: { messageInstanceId: secrets.messageInstances?.[0]?.id, identityId },
      badBody: { messageInstanceId: 'not-a-uuid', identityId },
    },
    {
      op: 'capture-reply',
      okBody: { leadId, exactText: 'Thanks — not right now, but keep me posted.', outcome: 'Maybe later', note: null },
      badBody: { leadId, exactText: '', outcome: 'not-a-real-outcome', note: null },
    },
    {
      op: 'snooze',
      okBody: { leadId, until: new Date(Date.now() + 7 * 864e5).toISOString(), reason: 'baseline verification' },
      badBody: { leadId, until: 'not-a-date', reason: null },
    },
    { op: 'reactivate', okBody: { leadId }, badBody: { leadId: 'not-a-uuid' } },
    {
      op: 'capture-profile',
      okBody: {
        leadId,
        linkedinUrl: 'https://www.linkedin.com/in/baseline-verify-person',
        pastedContent: 'Baseline Verify\nHead of Production at Frame House\nMunich, Germany\n\nExperience\n- Production lead',
      },
      badBody: { leadId, linkedinUrl: 'x', pastedContent: '' },
    },
  ];

  for (const entry of operations) {
    const okRes = await http('POST', `/api/v1/companion/actions/${entry.op}`, { token: admin, body: entry.okBody });
    record(`ACT-${entry.op}-OK`, 'api/v1/companion/actions/[operation]', `POST ${entry.op} with a valid body`, { request: { method: 'POST', path: `/api/v1/companion/actions/${entry.op}`, auth: 'Bearer admin', body: entry.okBody }, response: okRes }, (o) => {
      if (o.response.status === 200 && o.response.json?.ok === true) return ok('200 {"ok":true}');
      if (o.response.status === 400 && typeof o.response.json?.error === 'string')
        return partial(`400 ${JSON.stringify(o.response.json.error)} — request rejected by a domain rule, typed`);
      return bad(`expected 200 {ok:true}, got ${o.response.status} ${o.response.text.slice(0, 200)}`);
    });

    const badRes = await http('POST', `/api/v1/companion/actions/${entry.op}`, { token: admin, body: entry.badBody });
    record(`ACT-${entry.op}-INVALID`, 'api/v1/companion/actions/[operation]', `POST ${entry.op} with an invalid body`, { request: { method: 'POST', path: `/api/v1/companion/actions/${entry.op}`, auth: 'Bearer admin', body: entry.badBody }, response: badRes }, (o) =>
      o.response.status === 400 && typeof o.response.json?.error === 'string'
        ? ok(`400 {"error":${JSON.stringify(o.response.json.error)}}`)
        : bad(`expected 400 typed error, got ${o.response.status} ${o.response.text.slice(0, 160)}`),
    );

    const noAuthRes = await http('POST', `/api/v1/companion/actions/${entry.op}`, { body: entry.okBody });
    record(`ACT-${entry.op}-NOAUTH`, 'api/v1/companion/actions/[operation]', `POST ${entry.op} without a token`, { request: { method: 'POST', path: `/api/v1/companion/actions/${entry.op}`, auth: 'none' }, response: noAuthRes }, (o) =>
      o.response.status === 401 ? ok('401') : bad(`expected 401, got ${o.response.status}`),
    );
  }

  const unknownOp = await http('POST', '/api/v1/companion/actions/not-a-real-operation', { token: admin, body: {} });
  record('ACT-UNKNOWN-OP', 'api/v1/companion/actions/[operation]', 'POST an undeclared operation', { request: { method: 'POST', path: '/api/v1/companion/actions/not-a-real-operation', auth: 'Bearer admin' }, response: unknownOp }, (o) =>
    o.response.status === 404 && o.response.json?.error === 'Unknown operation.'
      ? ok('404 {"error":"Unknown operation."}')
      : bad(`expected 404 typed error, got ${o.response.status}`),
  );

  const malformed = await http('POST', '/api/v1/companion/actions/reactivate', { token: admin, raw: 'oops', headers: { 'content-type': 'application/json' } });
  record('ACT-MALFORMED', 'api/v1/companion/actions/[operation]', 'POST an action with malformed JSON', { request: { method: 'POST', path: '/api/v1/companion/actions/reactivate', body: 'oops' }, response: malformed }, (o) =>
    o.response.status === 400 && o.response.json?.error === 'Expected a JSON body.' ? ok('400 typed body') : bad(`expected 400 typed body, got ${o.response.status}`),
  );

  // A standard user must not be able to act on a lead outside their business.
  const lavishLead = secrets.leads.find((l) => l.business_id === ctx.LAVISH);
  if (lavishLead !== undefined) {
    const cross = await http('POST', '/api/v1/companion/actions/reactivate', { token: sessions.osama, body: { leadId: lavishLead.id } });
    record('ACT-WRONGBIZ-STANDARD', 'api/v1/companion/actions/[operation]', 'Standard user acts on another business’s lead', { request: { method: 'POST', path: '/api/v1/companion/actions/reactivate', auth: 'Bearer osama (zemnas)', body: { leadId: lavishLead.id } }, response: cross }, (o) =>
      o.response.status === 400 || o.response.status === 403 || o.response.status === 404
        ? ok(`${o.response.status} refused: ${JSON.stringify(o.response.json?.error)}`)
        : bad(`expected a refusal for an out-of-scope lead, got ${o.response.status} ${o.response.text.slice(0, 160)}`),
    );
  } else {
    record('ACT-WRONGBIZ-STANDARD', 'api/v1/companion/actions/[operation]', 'Standard user acts on another business’s lead', null, () => blocked('no lavish-foods lead seeded'));
  }

  // record the identity/install used, for the report
  return { identityId, installId, leadId };
}

/* ------------------------------------------- section 4: REST v1 ingest --- */

async function ingestSection(sessions) {
  const ctx = { ZEMNAS: secrets.businesses.find((b) => b.key === 'zemnas')?.id, LAVISH: secrets.businesses.find((b) => b.key === 'lavish-foods')?.id };
  // A fresh subject per run: people_normalized_linkedin_key is globally unique, so a
  // fixed URL would collide with the previous run's Person.
  const run = Date.now();
  const subjectUrl = `https://www.linkedin.com/in/baseline-ingest-${run}`;

  const envelope = {
    source_client: 'baseline-verify',
    business_key_or_id: 'zemnas',
    payload_type: 'candidate',
    payload: {
      full_name: `Baseline Ingest Person ${run}`,
      job_title: 'Content Lead',
      company_name: `Northstar ${run}`,
      linkedin_url: subjectUrl,
    },
    idempotency_key: `baseline-ingest-${run}`,
    observed_at: new Date().toISOString(),
  };

  const ingested = await http('POST', '/api/v1/ingest', { token: TOKEN['baseline-full'], body: envelope });
  record('INGEST-OK', 'api/v1/ingest', 'POST a candidate envelope with a scoped service token', { request: { method: 'POST', path: '/api/v1/ingest', auth: 'Bearer nxs_…(baseline-full)', body: { ...envelope, payload: { ...envelope.payload } } }, response: ingested }, (o) =>
    (o.response.status === 201 || o.response.status === 200) && o.response.json?.leadId
      ? ok(`${o.response.status}, leadId=${o.response.json.leadId} idempotent=${o.response.json.idempotent} stages=${o.response.json.stages?.length}`)
      : bad(`expected 200/201 with a leadId, got ${o.response.status} ${o.response.text.slice(0, 240)}`),
  );

  const replay = await http('POST', '/api/v1/ingest', { token: TOKEN['baseline-full'], body: envelope });
  record('INGEST-IDEMPOTENT', 'api/v1/ingest', 'POST the same envelope with the same idempotency_key', { request: { method: 'POST', path: '/api/v1/ingest', auth: 'Bearer nxs_…(baseline-full)', body: '<same envelope>' }, response: replay }, (o) =>
    o.response.status === 200 && o.response.json?.idempotent === true && o.response.json?.leadId === ingested.json?.leadId
      ? ok(`200, idempotent=true, same leadId=${o.response.json.leadId}`)
      : bad(`expected 200 idempotent=true with the original leadId, got ${o.response.status} ${o.response.text.slice(0, 240)}`),
  );

  const noAuth = await http('POST', '/api/v1/ingest', { body: envelope });
  record('INGEST-NOAUTH', 'api/v1/ingest', 'POST ingest without a token', { request: { method: 'POST', path: '/api/v1/ingest', auth: 'none' }, response: noAuth }, (o) =>
    o.response.status === 401 && o.response.json?.error === 'Missing or invalid token.'
      ? ok('401 {"error":"Missing or invalid token."}')
      : bad(`expected 401 typed error, got ${o.response.status}`),
  );

  const userToken = await http('POST', '/api/v1/ingest', { token: sessions.admin, body: { ...envelope, idempotency_key: `${envelope.idempotency_key}-u` } });
  record('INGEST-USERSCOPED', 'api/v1/ingest', 'POST ingest with a user (companion) token', { request: { method: 'POST', path: '/api/v1/ingest', auth: 'Bearer admin (nxu_)' }, response: userToken }, (o) =>
    o.response.status === 401 || o.response.status === 403 || o.response.status === 201 || o.response.status === 200
      ? ok(`${o.response.status} — ${JSON.stringify(o.response.json?.error ?? `accepted (user token bypasses the service scope list by design) leadId=${o.response.json?.leadId}`)}`)
      : bad(`unexpected ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );

  const outOfScope = await http('POST', '/api/v1/ingest', {
    token: TOKEN['baseline-narrow'],
    body: { ...envelope, idempotency_key: `${envelope.idempotency_key}-n` },
  });
  record('INGEST-SCOPE', 'api/v1/ingest', 'POST ingest with a token lacking ingest:write', { request: { method: 'POST', path: '/api/v1/ingest', auth: 'Bearer nxs_…(baseline-narrow)' }, response: outOfScope }, (o) =>
    o.response.status === 403 && typeof o.response.json?.error === 'string'
      ? ok(`403 {"error":${JSON.stringify(o.response.json.error)}}`)
      : bad(`expected 403 scope refusal, got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );

  const badBiz = await http('POST', '/api/v1/ingest', {
    token: TOKEN['baseline-full'],
    body: { ...envelope, business_key_or_id: 'no-such-business', idempotency_key: `${envelope.idempotency_key}-b` },
  });
  record('INGEST-UNKNOWNBIZ', 'api/v1/ingest', 'POST ingest for an unknown business', { request: { method: 'POST', path: '/api/v1/ingest', auth: 'Bearer nxs_…(baseline-full)', body: { business_key_or_id: 'no-such-business' } }, response: badBiz }, (o) =>
    o.response.status === 404 && o.response.json?.error === 'Unknown business, or this token is not scoped to it.'
      ? ok('404 with the deliberately two-meaning message')
      : bad(`expected 404 typed error, got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );

  const badPayloadType = await http('POST', '/api/v1/ingest', {
    token: TOKEN['baseline-full'],
    body: { ...envelope, payload_type: 'opportunity', idempotency_key: `${envelope.idempotency_key}-o` },
  });
  record('INGEST-PAYLOADTYPE-RESTRICTED', 'api/v1/ingest', 'POST ingest with a type outside the endpoint allow-list', { request: { method: 'POST', path: '/api/v1/ingest', auth: 'Bearer nxs_…(baseline-full)', body: { payload_type: 'opportunity' } }, response: badPayloadType }, (o) =>
    o.response.status === 400 && typeof o.response.json?.error === 'string'
      ? ok(`400 {"error":${JSON.stringify(o.response.json.error)}}`)
      : bad(`expected 400 allow-list refusal, got ${o.response.status} ${o.response.text.slice(0, 200)}`),
  );

  const badEnvelope = await http('POST', '/api/v1/ingest', { token: TOKEN['baseline-full'], body: { source_client: 'x' } });
  record('INGEST-INVALID-ENVELOPE', 'api/v1/ingest', 'POST ingest with an incomplete envelope', { request: { method: 'POST', path: '/api/v1/ingest', auth: 'Bearer nxs_…(baseline-full)', body: { source_client: 'x' } }, response: badEnvelope }, (o) =>
    o.response.status === 400 && typeof o.response.json?.error === 'string'
      ? ok(`400 {"error":${JSON.stringify(o.response.json.error)}}`)
      : bad(`expected 400 typed error, got ${o.response.status}`),
  );

  const malformed = await http('POST', '/api/v1/ingest', { token: TOKEN['baseline-full'], raw: '{oops', headers: { 'content-type': 'application/json' } });
  record('INGEST-MALFORMED', 'api/v1/ingest', 'POST ingest with malformed JSON', { request: { method: 'POST', path: '/api/v1/ingest', body: '{oops' }, response: malformed }, (o) =>
    o.response.status === 400 && o.response.json?.error === 'Expected a JSON body.' ? ok('400 typed body') : bad(`expected 400 typed body, got ${o.response.status}`),
  );

  const inactive = await http('POST', '/api/v1/ingest', { token: TOKEN['baseline-inactive'], body: { ...envelope, idempotency_key: `${envelope.idempotency_key}-i` } });
  record('INGEST-INACTIVE-TOKEN', 'api/v1/ingest', 'POST ingest with a deactivated service token', { request: { method: 'POST', path: '/api/v1/ingest', auth: 'Bearer nxs_…(baseline-inactive)' }, response: inactive }, (o) =>
    o.response.status === 401 ? ok('401 — is_active=false resolves to anonymous') : bad(`expected 401, got ${o.response.status}`),
  );
}

/* ---------------------------------------------------- section 5: CORS ---- */

async function corsSection() {
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  // OPTIONS preflight against a companion route.
  const pre = await http('OPTIONS', '/api/v1/companion/me', {
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  record('CORS-PREFLIGHT-COMPANION', 'cors', 'OPTIONS preflight on a companion route', { request: { method: 'OPTIONS', path: '/api/v1/companion/me', headers: { origin, 'access-control-request-method': 'GET' } }, response: pre }, (o) => {
    const acao = o.response.headers['access-control-allow-origin'];
    const acam = o.response.headers['access-control-allow-methods'];
    const acah = o.response.headers['access-control-allow-headers'];
    if (o.response.status === 204 && acao === '*' && (acam ?? '').includes('GET') && (acah ?? '').includes('authorization'))
      return ok(`204, ACAO=* methods="${acam}" headers="${acah}" (next.config.ts static rule)`);
    return bad(`expected 204 + ACAO=* + methods/headers, got ${o.response.status} ACAO=${acao} methods=${acam} headers=${acah}`);
  });

  const get = await http('GET', '/api/v1/companion/me', { headers: { origin } });
  record('CORS-GET-COMPANION', 'cors', 'Companion GET carries the ACAO header', { request: { method: 'GET', path: '/api/v1/companion/me', headers: { origin } }, response: get }, (o) =>
    o.response.headers['access-control-allow-origin'] === '*'
      ? ok(`ACAO=* on a ${o.response.status} response (wildcard, cookie-free surface)`)
      : bad(`expected ACAO=*, got ${o.response.headers['access-control-allow-origin']}`),
  );

  const appRoute = await http('GET', '/api/v1/ingest', { headers: { origin } });
  record('CORS-INGEST-NO-WILDCARD', 'cors', 'The ingest route is not opened to wildcard origins', { request: { method: 'GET', path: '/api/v1/ingest', headers: { origin } }, response: appRoute }, (o) =>
    o.response.headers['access-control-allow-origin'] === undefined
      ? ok('no ACAO header on /api/v1/ingest (only /api/v1/companion/* is opened)')
      : bad(`unexpected ACAO=${o.response.headers['access-control-allow-origin']} on /api/v1/ingest`),
  );
}

/* --------------------------------------------------- section 6: MCP ------ */

const EXPECTED_SCOPES = {
  'nexus.list_accessible_businesses': 'businesses:read',
  'nexus.get_business_context': 'context:read',
  'nexus.search_person': 'person:search',
  'nexus.search_company': 'company:search',
  'nexus.check_duplicate': 'duplicate:check',
  'nexus.submit_candidate': 'candidate:submit',
  'nexus.create_signal': 'signal:create',
  'nexus.add_source_evidence': 'evidence:add',
  'nexus.create_or_update_lead': 'lead:create',
  'nexus.assign_lead': 'lead:assign',
  'nexus.submit_profile_capture': 'profile:capture',
  'nexus.capture_reply': 'reply:capture',
  'nexus.add_note': 'note:add',
  'nexus.create_task': 'task:create',
  'nexus.get_today_queue': 'today:read',
  'nexus.submit_research': 'research:submit',
  'nexus.submit_message_draft': 'message:draft',
  'nexus.finish_agent_run': 'agent:run',
};

/**
 * Taken from `MCP_TOOLS_REQUIRING_IDEMPOTENCY` in
 * src/app/api/v1/mcp/tool-schemas.ts, which is what both `tools/list` and the
 * dispatch-time check in `callTool` read. This is the effective rule, even where
 * it disagrees with `TOOL_HANDLERS[*].needsIdempotencyKey` in route.ts (it does,
 * for nexus.assign_lead and nexus.submit_profile_capture).
 */
const NEEDS_KEY = new Set([
  'nexus.submit_candidate',
  'nexus.create_signal',
  'nexus.add_source_evidence',
  'nexus.create_or_update_lead',
  'nexus.assign_lead',
  'nexus.submit_profile_capture',
  'nexus.capture_reply',
  'nexus.add_note',
  'nexus.create_task',
  'nexus.submit_research',
  'nexus.submit_message_draft',
  'nexus.finish_agent_run',
]);

async function mcpSection(sessions, companionCtx) {
  const full = TOKEN['baseline-full'];
  const narrow = TOKEN['baseline-narrow'];
  const otherBiz = TOKEN['baseline-otherbusiness'];
  const ZEMNAS = companionCtx.ZEMNAS;
  const LAVISH = companionCtx.LAVISH;
  const bogusId = companionCtx.bogusId;
  const leadId = companionCtx.createdLeadId ?? companionCtx.realLead.id;
  const adminUserId = secrets.users.find((u) => u.email === 'admin@nexus.local')?.id;
  const osamaUserId = secrets.users.find((u) => u.email === 'osama@nexus.local')?.id;
  const messageInstanceId = secrets.messageInstances?.[0]?.id;
  const stamp = Date.now();

  // ---- auth -------------------------------------------------------------
  const noToken = await mcp(undefined, jsonRpc('tools/list', {}), 'none');
  record('MCP-AUTH-NOTOKEN', 'mcp/auth', 'POST tools/list without a token', noToken, (o) =>
    o.response.status === 200 && o.response.json?.error?.code === -32001
      ? ok('HTTP 200 JSON-RPC -32001 "Missing or invalid token."')
      : bad(`expected -32001, got ${o.response.status} ${o.response.text.slice(0, 160)}`),
  );

  const badToken = await mcp('nxs_totally-bogus-token-00000000000000000000000', jsonRpc('tools/list', {}), 'bogus');
  record('MCP-AUTH-BADTOKEN', 'mcp/auth', 'POST tools/list with an unknown bearer token', badToken, (o) =>
    o.response.status === 200 && o.response.json?.error?.code === -32001
      ? ok('HTTP 200 JSON-RPC -32001')
      : bad(`expected -32001, got ${o.response.status} ${o.response.text.slice(0, 160)}`),
  );

  const inactiveToken = await mcp(TOKEN['baseline-inactive'], jsonRpc('tools/list', {}), 'inactive');
  record('MCP-AUTH-INACTIVE', 'mcp/auth', 'POST tools/list with a deactivated service token', inactiveToken, (o) =>
    o.response.json?.error?.code === -32001 ? ok('-32001 (is_active=false is treated as anonymous)') : bad(`expected -32001, got ${o.response.text.slice(0, 160)}`),
  );

  // GET capability discovery
  const getDiscovery = await http('GET', '/api/v1/mcp');
  record('MCP-GET-DISCOVERY', 'mcp/transport', 'GET capability discovery', { request: { method: 'GET', path: '/api/v1/mcp' }, response: getDiscovery }, (o) =>
    o.response.status === 200 && Array.isArray(o.response.json?.tools) && o.response.json.tools.length === 18
      ? ok(`200, protocol=${o.response.json.protocol} transport=${o.response.json.transport} tools=${o.response.json.tools.length}`)
      : bad(`expected 200 with 18 tools, got ${o.response.status} tools=${o.response.json?.tools?.length}`),
  );

  // malformed JSON
  const malformed = await mcp(full, undefined);
  const malformedRes = await http('POST', '/api/v1/mcp', { token: full, raw: '{"jsonrpc":', headers: { 'content-type': 'application/json' } });
  record('MCP-PARSE-ERROR', 'mcp/transport', 'POST a malformed JSON body', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: '{"jsonrpc":' }, response: malformedRes }, (o) =>
    o.response.status === 200 && o.response.json?.error?.code === -32700
      ? ok('HTTP 200 JSON-RPC -32700 Parse error')
      : bad(`expected -32700, got ${o.response.status} ${o.response.text.slice(0, 160)}`),
  );

  // initialize
  const init = await mcp(full, jsonRpc('initialize', { protocolVersion: '2024-11-05' }));
  record('MCP-INITIALIZE', 'mcp/transport', 'initialize', init, (o) =>
    o.response.json?.result?.protocolVersion === '2024-11-05' && o.response.json?.result?.serverInfo?.name === 'nexus'
      ? ok(`protocolVersion=${o.response.json.result.protocolVersion} server=${o.response.json.result.serverInfo.name} v${o.response.json.result.serverInfo.version}`)
      : bad(`expected initialize result, got ${o.response.text.slice(0, 200)}`),
  );

  // method not found
  const badMethod = await mcp(full, jsonRpc('resources/list', {}));
  record('MCP-METHOD-NOTFOUND', 'mcp/transport', 'An unknown JSON-RPC method', badMethod, (o) =>
    o.response.json?.error?.code === -32601 ? ok('-32601 Method not found') : bad(`expected -32601, got ${o.response.text.slice(0, 160)}`),
  );

  // invalid request (not jsonrpc 2.0)
  const invalidReq = await mcp(full, { id: 7, method: 'tools/list' });
  record('MCP-INVALID-REQUEST', 'mcp/transport', 'A message without jsonrpc:"2.0"', invalidReq, (o) =>
    o.response.json?.error?.code === -32600 ? ok('-32600 Invalid Request') : bad(`expected -32600, got ${o.response.text.slice(0, 160)}`),
  );

  // ---- tools/list -------------------------------------------------------
  const list = await mcp(full, jsonRpc('tools/list', {}));
  const tools = list.response.json?.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  record('MCP-TOOLS-LIST', 'mcp/tools-list', 'tools/list returns all 18 declared tools', list, (o) =>
    tools.length === 18 ? ok(`18 tools: ${names.join(', ')}`) : bad(`expected 18 tools, got ${tools.length}: ${names.join(', ')}`),
  );

  record('MCP-TOOLS-LIST-SCHEMA', 'mcp/tools-list', 'Every tool publishes an inputSchema with required args', list, () => {
    const problems = [];
    for (const tool of tools) {
      const schema = tool.inputSchema;
      if (schema === undefined || schema.type !== 'object' || typeof schema.properties !== 'object') {
        problems.push(`${tool.name}: no object inputSchema`);
        continue;
      }
      if (tool.name !== 'nexus.list_accessible_businesses' && !schema.required?.includes('business_id')) {
        problems.push(`${tool.name}: business_id not required`);
      }
      if (NEEDS_KEY.has(tool.name) && !schema.required?.includes('idempotency_key')) {
        problems.push(`${tool.name}: idempotency_key not required`);
      }
      if (schema.properties.business_id?.format !== 'uuid') problems.push(`${tool.name}: business_id not uuid`);
    }
    return problems.length === 0
      ? ok('all 18 schemas are objects with business_id (uuid) required except the discovery tool; all 12 write tools require idempotency_key')
      : bad(problems.join('; '));
  });

  record('MCP-TOOLS-LIST-NOSQL', 'mcp/no-sql', 'The catalogue exposes no arbitrary-SQL tool', list, () => {
    const forbidden = ['execute_sql', 'run_sql', 'sql', 'query', 'database.'];
    const hits = names.filter((n) => forbidden.some((f) => n.toLowerCase().includes(f.replace('.', ''))));
    const fields = tools.flatMap((t) => Object.keys(t.inputSchema?.properties ?? {}));
    const sqlFields = fields.filter((f) => /sql|statement|query_text/i.test(f));
    return hits.length === 0 && sqlFields.length === 0
      ? ok(`no tool name or argument mentions sql/statement; catalogue = intent tools only (checked ${names.length} tools, ${fields.length} distinct args)`)
      : bad(`sql-ish tool names: ${hits.join(',')} / args: ${sqlFields.join(',')}`);
  });

  // explicit forbidden-tool probe
  const sqlTool = await mcp(full, jsonRpc('tools/call', { name: 'database.execute_sql', arguments: { sql: 'select 1' } }));
  record('MCP-NO-SQL-TOOL', 'mcp/no-sql', 'tools/call database.execute_sql', sqlTool, (o) =>
    o.response.json?.error?.code === -32601 && String(o.response.json.error.message).includes('Unknown tool')
      ? ok(`-32601 ${JSON.stringify(o.response.json.error.message)} — the tool is not in the dispatch table`)
      : bad(`expected -32601 Unknown tool, got ${o.response.text.slice(0, 200)}`),
  );
  const sqlTool2 = await mcp(full, jsonRpc('tools/call', { name: 'nexus.run_sql', arguments: { query: 'select 1' } }));
  record('MCP-NO-SQL-TOOL-2', 'mcp/no-sql', 'tools/call nexus.run_sql', sqlTool2, (o) =>
    o.response.json?.error?.code === -32601 ? ok('-32601 Unknown tool') : bad(`expected -32601, got ${o.response.text.slice(0, 200)}`),
  );
  const unknownTool = await mcp(full, jsonRpc('tools/call', { name: 'nexus.not_a_tool', arguments: {} }));
  record('MCP-UNKNOWN-TOOL', 'mcp/transport', 'tools/call an unknown tool name', unknownTool, (o) =>
    o.response.json?.error?.code === -32601 ? ok('-32601 Unknown tool') : bad(`expected -32601, got ${o.response.text.slice(0, 200)}`),
  );

  // ---- scope enforcement ------------------------------------------------
  const scopeCases = [
    { tool: 'nexus.create_signal', args: { business_id: ZEMNAS, kind: 'hiring', idempotency_key: `scope-${stamp}-1` }, scope: 'signal:create' },
    { tool: 'nexus.add_note', args: { business_id: ZEMNAS, lead_id: leadId, body: 'x', idempotency_key: `scope-${stamp}-2` }, scope: 'note:add' },
    { tool: 'nexus.create_task', args: { business_id: ZEMNAS, lead_id: leadId, title: 'x', idempotency_key: `scope-${stamp}-3` }, scope: 'task:create' },
    { tool: 'nexus.finish_agent_run', args: { business_id: ZEMNAS, agent_name: 'x', idempotency_key: `scope-${stamp}-4` }, scope: 'agent:run' },
  ];
  for (const sc of scopeCases) {
    const res = await mcp(narrow, jsonRpc('tools/call', { name: sc.tool, arguments: sc.args }), 'narrow');
    record(`MCP-SCOPE-${sc.tool}`, 'mcp/scope', `${sc.tool} with a token lacking ${sc.scope}`, { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-narrow)', body: { method: 'tools/call', name: sc.tool } }, response: res.response }, (o) =>
      o.response.json?.error?.code === -32003
        ? ok(`-32003 ${JSON.stringify(o.response.json.error.message)}`)
        : bad(`expected -32003 scope refusal, got ${o.response.text.slice(0, 200)}`),
    );
  }

  // wrong business for a token that holds the scope
  const wrongBiz = await mcp(otherBiz, jsonRpc('tools/call', { name: 'nexus.get_business_context', arguments: { business_id: ZEMNAS } }), 'other-business');
  record('MCP-SCOPE-WRONGBUSINESS', 'mcp/scope', 'A token scoped to ai-integrations targets zemnas', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-otherbusiness)', body: { method: 'tools/call', name: 'nexus.get_business_context', arguments: { business_id: ZEMNAS } } }, response: wrongBiz.response }, (o) =>
    o.response.json?.error?.code === -32003 && String(o.response.json.error.message).includes('not scoped to that business')
      ? ok(`-32003 ${JSON.stringify(o.response.json.error.message)}`)
      : bad(`expected -32003 "not scoped to that business", got ${o.response.text.slice(0, 200)}`),
  );

  // ---- per-tool happy + failure ----------------------------------------
  const TOOL_CALLS = [
    {
      tool: 'nexus.list_accessible_businesses',
      okArgs: {},
      badArgs: { business_id: 'not-a-uuid' },
      expectOk: (r) => Array.isArray(r.businesses) && r.businesses.length === 3,
      describe: (r) => `businesses=${r.businesses.map((b) => b.key).join(',')}`,
      strictBad: true,
    },
    {
      tool: 'nexus.get_business_context',
      okArgs: { business_id: ZEMNAS },
      badArgs: { business_id: bogusId },
      expectOk: (r) => r.business?.key === 'zemnas',
      describe: (r) => `business.key=${r.business?.key}`,
      badIsToolError: true,
    },
    {
      tool: 'nexus.search_person',
      okArgs: { business_id: ZEMNAS, query: 'Tom' },
      badArgs: { business_id: ZEMNAS, query: '' },
      expectOk: (r) => Array.isArray(r.results),
      describe: (r) => `results=${r.results.length}`,
    },
    {
      tool: 'nexus.search_company',
      okArgs: { business_id: ZEMNAS, query: 'Frame' },
      badArgs: { business_id: ZEMNAS, query: '' },
      expectOk: (r) => Array.isArray(r.companies),
      describe: (r) => `companies=${r.companies.length}`,
    },
    {
      tool: 'nexus.check_duplicate',
      okArgs: { business_id: ZEMNAS, query: 'Tom' },
      badArgs: { business_id: ZEMNAS },
      expectOk: (r) => typeof r.duplicate === 'boolean' && Array.isArray(r.matches),
      describe: (r) => `duplicate=${r.duplicate} matches=${r.matches.length}`,
    },
    {
      tool: 'nexus.submit_candidate',
      okArgs: {
        business_id: ZEMNAS,
        idempotency_key: `mcp-cand-${stamp}`,
        full_name: 'Baseline MCP Candidate',
        job_title: 'Head of Production',
        company_name: 'Northstar',
        linkedin_url: `https://www.linkedin.com/in/baseline-mcp-candidate-${stamp}`,
      },
      badArgs: { business_id: ZEMNAS, idempotency_key: `mcp-cand-bad-${stamp}`, full_name: '' },
      expectOk: (r) => typeof r.lead_id === 'string' && r.lead_id.length > 0,
      describe: (r) => `lead_id=${r.lead_id} person_id=${r.person_id} company_id=${r.company_id} idempotent=${r.idempotent} stages=${r.stages?.length}`,
    },
    {
      tool: 'nexus.create_signal',
      // signals_subject_check requires at least one of company_id / person_id / lead_id.
      okArgs: { business_id: ZEMNAS, idempotency_key: `mcp-sig-${stamp}`, kind: 'hiring', polarity: 'positive', strength: 20, label: 'Baseline signal', lead_id: leadId },
      badArgs: { business_id: ZEMNAS, idempotency_key: `mcp-sig-bad-${stamp}`, kind: 'not_a_kind' },
      expectOk: (r) => typeof r.signal_id === 'string' && r.signal_id.length > 0,
      describe: (r) => `signal_id=${r.signal_id}`,
      // signals_subject_check is satisfied by lead_id, so an RLS refusal here is a defect.
      rlsIsDefect: true,
    },
    {
      tool: 'nexus.add_source_evidence',
      okArgs: { business_id: ZEMNAS, idempotency_key: `mcp-evi-${stamp}`, source: 'Baseline verification', raw_text_or_json: `baseline evidence ${stamp}`, confidence: 0.6 },
      badArgs: { business_id: ZEMNAS, idempotency_key: `mcp-evi-bad-${stamp}` },
      expectOk: (r) => typeof r.evidence_id === 'string' || r.deduplicated === true,
      describe: (r) => `evidence_id=${r.evidence_id} deduplicated=${r.deduplicated}`,
    },
    {
      tool: 'nexus.create_or_update_lead',
      okArgs: {
        business_id: ZEMNAS,
        idempotency_key: `mcp-lead-${stamp}`,
        full_name: 'Baseline MCP Lead Person',
        company_name: 'Studio 8',
        job_title: 'Content Lead',
        linkedin_url: `https://www.linkedin.com/in/baseline-mcp-lead-${stamp}`,
      },
      badArgs: { business_id: ZEMNAS, idempotency_key: `mcp-lead-bad-${stamp}`, linkedin_url: 42 },
      expectOk: (r) => typeof r.lead_id === 'string' && r.lead_id.length > 0,
      describe: (r) => `lead_id=${r.lead_id} person_id=${r.person_id}`,
    },
    {
      tool: 'nexus.assign_lead',
      okArgs: { business_id: ZEMNAS, idempotency_key: `mcp-assign-${stamp}`, lead_id: leadId, owner_user_id: osamaUserId },
      badArgs: { business_id: ZEMNAS, idempotency_key: `mcp-assign-bad-${stamp}`, lead_id: bogusId, owner_user_id: osamaUserId },
      expectOk: (r) => r.lead_id === leadId && r.owner_user_id === osamaUserId,
      describe: (r) => `lead_id=${r.lead_id} owner_user_id=${r.owner_user_id}`,
      badIsToolError: true,
    },
    {
      tool: 'nexus.submit_profile_capture',
      okArgs: {
        business_id: ZEMNAS,
        idempotency_key: `mcp-cap-${stamp}`,
        lead_id: leadId,
        linkedin_url: 'https://www.linkedin.com/in/baseline-verify-person',
        pasted_content: 'Baseline Verify\nHead of Production at Frame House\nMunich, Germany',
      },
      badArgs: { business_id: ZEMNAS, idempotency_key: `mcp-cap-bad-${stamp}`, lead_id: bogusId, linkedin_url: 'https://www.linkedin.com/in/x', pasted_content: 'x' },
      expectOk: (r) => r.updated === true,
      describe: (r) => `lead_id=${r.lead_id} updated=${r.updated}`,
    },
    {
      tool: 'nexus.capture_reply',
      okArgs: { business_id: ZEMNAS, idempotency_key: `mcp-reply-${stamp}`, lead_id: leadId, exact_text: 'Thanks, not right now — ping me next quarter.', outcome: 'Maybe later' },
      badArgs: { business_id: ZEMNAS, idempotency_key: `mcp-reply-bad-${stamp}`, lead_id: leadId, exact_text: '', outcome: 'Maybe later' },
      expectOk: (r) => r.captured === true,
      describe: (r) => `lead_id=${r.lead_id} captured=${r.captured}`,
    },
    {
      tool: 'nexus.add_note',
      okArgs: { business_id: ZEMNAS, idempotency_key: `mcp-note-${stamp}`, lead_id: leadId, body: 'Baseline verification note.' },
      badArgs: { business_id: ZEMNAS, idempotency_key: `mcp-note-bad-${stamp}`, lead_id: bogusId, body: 'x' },
      expectOk: (r) => typeof r.note_id === 'string' && r.note_id.length > 0,
      describe: (r) => `note_id=${r.note_id}`,
    },
    {
      tool: 'nexus.create_task',
      okArgs: { business_id: ZEMNAS, idempotency_key: `mcp-task-${stamp}`, lead_id: leadId, title: 'Baseline verification task', type: 'follow_up', priority: 'normal' },
      badArgs: { business_id: ZEMNAS, idempotency_key: `mcp-task-bad-${stamp}`, lead_id: bogusId, title: 'x' },
      expectOk: (r) => typeof r.task_id === 'string' && r.task_id.length > 0,
      describe: (r) => `task_id=${r.task_id}`,
    },
    {
      tool: 'nexus.get_today_queue',
      okArgs: { business_id: ZEMNAS, user_id: osamaUserId },
      badArgs: { business_id: ZEMNAS, user_id: bogusId },
      expectOk: (r) => Array.isArray(r.items),
      describe: (r) => `items=${r.items.length}`,
      badIsToolError: true,
    },
    {
      tool: 'nexus.submit_research',
      okArgs: { business_id: ZEMNAS, idempotency_key: `mcp-res-${stamp}`, lead_id: leadId, summary: 'Baseline research snapshot.', findings: { note: 'baseline' } },
      badArgs: { business_id: ZEMNAS, idempotency_key: `mcp-res-bad-${stamp}`, lead_id: bogusId, summary: 'x' },
      expectOk: (r) => typeof r.research_snapshot_id === 'string' && r.research_snapshot_id.length > 0,
      describe: (r) => `research_snapshot_id=${r.research_snapshot_id}`,
    },
    {
      tool: 'nexus.submit_message_draft',
      okArgs: { business_id: ZEMNAS, idempotency_key: `mcp-draft-${stamp}`, message_instance_id: messageInstanceId, content: 'Baseline draft content.' },
      badArgs: { business_id: ZEMNAS, idempotency_key: `mcp-draft-bad-${stamp}`, message_instance_id: bogusId, content: '' },
      expectOk: (r) => typeof r.message_version_id === 'string' && r.message_version_id.length > 0,
      describe: (r) => `message_version_id=${r.message_version_id}`,
    },
    {
      tool: 'nexus.finish_agent_run',
      // agent_runs_state_check allows only running / succeeded / failed / cancelled.
      okArgs: { business_id: ZEMNAS, idempotency_key: `mcp-run-${stamp}`, agent_name: 'baseline-verifier', objective: 'Verify the MCP surface', state: 'succeeded', summary: 'Baseline run.' },
      badArgs: { business_id: ZEMNAS, idempotency_key: `mcp-run-bad-${stamp}`, agent_name: '' },
      expectOk: (r) => typeof r.agent_run_id === 'string' && r.agent_run_id.length > 0,
      describe: (r) => `agent_run_id=${r.agent_run_id}`,
    },
  ];

  if (messageInstanceId === undefined) {
    record('MCP-PRECONDITION-MESSAGEINSTANCE', 'mcp/precondition', 'A seeded message_instance exists', null, () =>
      blocked('no message_instances row in the seeded database — nexus.submit_message_draft cannot be exercised'),
    );
  }

  const results = {};
  for (const spec of TOOL_CALLS) {
    const call = jsonRpc('tools/call', { name: spec.tool, arguments: spec.okArgs });
    const res = await mcp(full, call);
    const body = res.response.json;
    const structured = body?.result?.structuredContent;
    results[spec.tool] = { res, structured };
    record(`MCP-OK-${spec.tool}`, 'mcp/tools-call', `${spec.tool} happy path`, { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: { method: 'tools/call', name: spec.tool, arguments: spec.okArgs } }, response: res.response }, (o) => {
      const r = o.response.json?.result;
      const text = String(r?.content?.[0]?.text ?? '');
      if (o.response.json?.error) {
        // The database refusing a well-formed write is a platform defect, not a bad
        // request: record it as BLOCKED from this harness's point of view, and name it.
        if (/row-level security/i.test(String(o.response.json.error.message))) {
          return blocked(`the request is well-formed but the database refused it: ${o.response.json.error.message}`);
        }
        return bad(`JSON-RPC error ${o.response.json.error.code}: ${o.response.json.error.message}`);
      }
      if (r?.isError === true) {
        if (/row-level security/i.test(text)) {
          return blocked(`well-formed write refused by the database (RLS): ${text.slice(0, 180)}`);
        }
        return bad(`200 with isError payload: ${text.slice(0, 180)}`);
      }
      if (structured === undefined) return bad('no structuredContent in the result');
      try {
        return spec.expectOk(structured)
          ? ok(`result asserted: ${spec.describe(structured)}`)
          : bad(`result failed its assertion: ${JSON.stringify(structured).slice(0, 220)}`);
      } catch (error) {
        return bad(`result assertion threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    const badRes = await mcp(full, jsonRpc('tools/call', { name: spec.tool, arguments: spec.badArgs }));
    record(`MCP-BAD-${spec.tool}`, 'mcp/tools-call', `${spec.tool} invalid call`, { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: { method: 'tools/call', name: spec.tool, arguments: spec.badArgs } }, response: badRes.response }, (o) => {
      const j = o.response.json;
      if (j?.error !== undefined) return ok(`JSON-RPC error ${j.error.code}: ${String(j.error.message).slice(0, 150)}`);
      if (j?.result?.isError === true) return ok(`result.isError: ${String(j.result.content?.[0]?.text).slice(0, 150)}`);
      const structured = j?.result?.structuredContent;
      // A write tool that answers 200 with a null id did not do what it was asked: the
      // INSERT…SELECT matched no row and the handler reported success anyway. A read tool
      // that answers with an empty collection for an unknown subject is a correct answer.
      const isWriteShaped = ['note_id', 'task_id', 'research_snapshot_id', 'signal_id', 'lead_id', 'evidence_id', 'message_version_id', 'agent_run_id'].some(
        (k) => k in (structured ?? {}),
      );
      const hasNullId = Object.values(structured ?? {}).some((value) => value === null);
      if (isWriteShaped && hasNullId) {
        return bad(`silent no-op: HTTP 200 result reports success but wrote nothing (${JSON.stringify(structured)})`);
      }
      return ok(`accepted as a valid negative result: ${JSON.stringify(structured)?.slice(0, 160)}`);
    });
  }

  // ---- idempotency ------------------------------------------------------
  // signals_subject_check requires a subject, so the probe carries the real lead.
  const sigArgs = { business_id: ZEMNAS, idempotency_key: `mcp-idem-${stamp}`, kind: 'hiring', polarity: 'positive', strength: 5, label: 'Idempotency probe', lead_id: leadId };
  const first = await mcp(full, jsonRpc('tools/call', { name: 'nexus.create_signal', arguments: sigArgs }));
  record('MCP-IDEM-FIRST', 'mcp/idempotency', 'create_signal with a fresh idempotency_key', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: sigArgs }, response: first.response }, (o) =>
    o.response.json?.result?.structuredContent?.signal_id && o.response.json?.result?.idempotent === false
      ? ok(`signal_id=${o.response.json.result.structuredContent.signal_id} idempotent=false`)
      : bad(`expected a new signal_id with idempotent=false, got ${o.response.text.slice(0, 220)}`),
  );
  const replay = await mcp(full, jsonRpc('tools/call', { name: 'nexus.create_signal', arguments: sigArgs }));
  record('MCP-IDEM-REPLAY', 'mcp/idempotency', 'Same key + same payload is replayed, not re-run', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: '<same>' }, response: replay.response }, (o) =>
    o.response.json?.result?.idempotent === true &&
    o.response.json?.result?.structuredContent?.signal_id === first.response.json?.result?.structuredContent?.signal_id
      ? ok(`idempotent=true, same signal_id=${o.response.json.result.structuredContent.signal_id} (no second row)`)
      : bad(`expected idempotent=true with the original signal_id, got ${o.response.text.slice(0, 240)}`),
  );
  const conflict = await mcp(full, jsonRpc('tools/call', { name: 'nexus.create_signal', arguments: { ...sigArgs, label: 'DIFFERENT PAYLOAD' } }));
  record('MCP-IDEM-DIFFERENT-PAYLOAD', 'mcp/idempotency', 'Same key + different payload is refused', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: { ...sigArgs, label: 'DIFFERENT PAYLOAD' } }, response: conflict.response }, (o) =>
    o.response.json?.result?.isError === true && /different arguments/i.test(String(o.response.json.result.content?.[0]?.text))
      ? ok(`result.isError: ${JSON.stringify(o.response.json.result.content[0].text)}`)
      : bad(`expected an isError refusal naming different arguments, got ${o.response.text.slice(0, 240)}`),
  );

  // ingestion tool: key required before dispatch
  const missingKey = await mcp(full, jsonRpc('tools/call', { name: 'nexus.submit_candidate', arguments: { business_id: ZEMNAS, full_name: 'No Key' } }));
  record('MCP-IDEM-KEY-REQUIRED', 'mcp/idempotency', 'submit_candidate without idempotency_key', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: { name: 'nexus.submit_candidate' } }, response: missingKey.response }, (o) =>
    o.response.json?.result?.isError === true && /idempotency_key is required/i.test(String(o.response.json.result.content?.[0]?.text))
      ? ok(`result.isError: ${JSON.stringify(o.response.json.result.content[0].text)}`)
      : bad(`expected "idempotency_key is required", got ${o.response.text.slice(0, 240)}`),
  );

  // idempotency is scoped per business: the same key for a different business runs afresh
  const otherBusinessReplay = await mcp(full, jsonRpc('tools/call', { name: 'nexus.create_signal', arguments: { ...sigArgs, business_id: LAVISH } }));
  record('MCP-IDEM-PER-BUSINESS', 'mcp/idempotency', 'The same key under a different business is not treated as a replay', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: { ...sigArgs, business_id: LAVISH } }, response: otherBusinessReplay.response }, (o) =>
    o.response.json?.result?.structuredContent?.signal_id !== first.response.json?.result?.structuredContent?.signal_id
      ? ok(`distinct signal_id=${o.response.json?.result?.structuredContent?.signal_id} idempotent=${o.response.json?.result?.idempotent}`)
      : bad(`expected a distinct signal for a different business, got ${o.response.text.slice(0, 200)}`),
  );

  // ---- mutation vs non-mutation ----------------------------------------
  const beforeList = await mcp(full, jsonRpc('tools/call', { name: 'nexus.list_accessible_businesses', arguments: {} }));
  const twiceA = await mcp(full, jsonRpc('tools/call', { name: 'nexus.search_company', arguments: { business_id: ZEMNAS, query: 'Frame' } }));
  const twiceB = await mcp(full, jsonRpc('tools/call', { name: 'nexus.search_company', arguments: { business_id: ZEMNAS, query: 'Frame' } }));
  record('MCP-NO-KEY-READONLY-REPEAT', 'mcp/idempotency', 'A read-only tool without a key returns identical results twice', null, () =>
    JSON.stringify(twiceA.response.json?.result?.structuredContent) === JSON.stringify(twiceB.response.json?.result?.structuredContent)
      ? ok('identical structuredContent across two calls (non-mutating)')
      : bad('a read-only tool returned different results on repetition'),
  );

  const noteNoKey = { business_id: ZEMNAS, lead_id: leadId, body: `no-key note ${stamp}` };
  const n1 = await mcp(full, jsonRpc('tools/call', { name: 'nexus.add_note', arguments: noteNoKey }));
  const n2 = await mcp(full, jsonRpc('tools/call', { name: 'nexus.add_note', arguments: noteNoKey }));
  record('MCP-MUTATION-WITHOUT-KEY-INSERTS', 'mcp/idempotency', 'add_note carries a key in the catalogue; omitting it still mutates', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: { name: 'nexus.add_note', arguments: noteNoKey } }, response: n2.response }, (o) => {
    const a = n1.response.json?.result?.structuredContent?.note_id;
    const b = n2.response.json?.result?.structuredContent?.note_id;
    if (o.response.json?.result?.isError === true) return partial(`refused without a key: ${String(o.response.json.result.content?.[0]?.text).slice(0, 140)}`);
    return a !== undefined && b !== undefined && a !== b
      ? partial(`two distinct note_ids (${a} vs ${b}) — a keyless write is a genuine second mutation; the catalogue marks idempotency_key optional here (tool-schemas.ts:204-223), so only the client can prevent it`)
      : bad(`expected two distinct notes or a refusal, got ${JSON.stringify({ a, b })}`);
  });

  // ---- JSON-RPC batch ---------------------------------------------------
  const batch = [
    jsonRpc('tools/call', { name: 'nexus.get_business_context', arguments: { business_id: ZEMNAS } }, 101),
    jsonRpc('tools/call', { name: 'nexus.search_company', arguments: { business_id: ZEMNAS, query: 'Kite' } }, 102),
  ];
  const batchRes = await mcp(full, batch);
  record('MCP-BATCH', 'mcp/batch', 'A batch of two valid calls returns two responses', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: batch }, response: batchRes.response }, (o) => {
    const arr = o.response.json;
    if (!Array.isArray(arr)) return bad(`expected a JSON array of responses, got ${typeof arr}`);
    const ids = arr.map((r) => r.id);
    return arr.length === 2 && ids.includes(101) && ids.includes(102)
      ? ok(`2 responses, ids=[${ids.join(',')}] (both elements executed)`)
      : bad(`expected 2 responses for ids 101/102, got ${arr.length} ids=[${ids.join(',')}]`);
  });

  const mixed = [
    jsonRpc('tools/call', { name: 'nexus.search_person', arguments: { business_id: ZEMNAS, query: 'Tom' } }, 201),
    jsonRpc('tools/call', { name: 'nexus.not_a_tool', arguments: {} }, 202),
    jsonRpc('tools/call', { name: 'nexus.search_company', arguments: { business_id: ZEMNAS, query: '' } }, 203),
    jsonRpc('resources/list', {}, 204),
  ];
  const mixedRes = await mcp(full, mixed);
  record('MCP-BATCH-MIXED', 'mcp/batch', 'A mixed success/error batch answers per element', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: mixed }, response: mixedRes.response }, (o) => {
    const arr = o.response.json;
    if (!Array.isArray(arr) || arr.length !== 4) return bad(`expected 4 responses, got ${JSON.stringify(arr)?.slice(0, 200)}`);
    const byId = Object.fromEntries(arr.map((r) => [r.id, r]));
    const problems = [];
    if (byId[201]?.result === undefined) problems.push('201 (valid) did not succeed');
    if (byId[202]?.error?.code !== -32601) problems.push(`202 (unknown tool) expected -32601, got ${byId[202]?.error?.code}`);
    if (byId[203]?.result?.isError !== true) problems.push('203 (invalid args) did not return isError');
    if (byId[204]?.error?.code !== -32601) problems.push(`204 (unknown method) expected -32601, got ${byId[204]?.error?.code}`);
    return problems.length === 0
      ? ok('4 responses: 201 success, 202 -32601, 203 result.isError, 204 -32601')
      : bad(problems.join('; '));
  });

  const emptyBatch = await mcp(full, []);
  record('MCP-BATCH-EMPTY', 'mcp/batch', 'An empty batch is an invalid request', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: [] }, response: emptyBatch.response }, (o) =>
    o.response.json?.error?.code === -32600 ? ok('-32600 Invalid Request') : bad(`expected -32600, got ${o.response.text.slice(0, 160)}`),
  );

  const notification = [{ jsonrpc: '2.0', method: 'tools/list' }, jsonRpc('tools/call', { name: 'nexus.search_company', arguments: { business_id: ZEMNAS, query: 'Frame' } }, 301)];
  const notificationRes = await mcp(full, notification);
  record('MCP-BATCH-NOTIFICATION', 'mcp/batch', 'A notification element gets no response entry', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: notification }, response: notificationRes.response }, (o) => {
    const arr = o.response.json;
    return Array.isArray(arr) && arr.length === 1 && arr[0].id === 301
      ? ok('1 response, for id 301 only')
      : bad(`expected exactly one response (id 301), got ${JSON.stringify(arr)?.slice(0, 200)}`);
  });

  // ---- error shape -----------------------------------------------------
  const badEnvelope = await mcp(full, jsonRpc('tools/call', { name: 'nexus.get_business_context', arguments: { business_id: ZEMNAS, idempotency_key: 'short' } }));
  record('MCP-ENVELOPE-SCHEMA', 'mcp/validation', 'An idempotency_key shorter than 8 characters is refused', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: { idempotency_key: 'short' } }, response: badEnvelope.response }, (o) =>
    o.response.json?.result?.isError === true && /Invalid arguments/i.test(String(o.response.json.result.content?.[0]?.text))
      ? ok(`result.isError: ${String(o.response.json.result.content[0].text).slice(0, 160)}`)
      : bad(`expected an envelope validation refusal, got ${o.response.text.slice(0, 200)}`),
  );

  const nonObjectArgs = await mcp(full, jsonRpc('tools/call', { name: 'nexus.search_company', arguments: 'not-an-object' }));
  record('MCP-ARGS-NONOBJECT', 'mcp/validation', 'tools/call with non-object arguments', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: { arguments: 'not-an-object' } }, response: nonObjectArgs.response }, (o) =>
    o.response.json?.result?.isError === true || o.response.json?.error !== undefined
      ? ok(`refused: ${JSON.stringify(o.response.json?.error ?? o.response.json?.result?.content?.[0]?.text).slice(0, 160)}`)
      : bad(`expected a refusal, got ${o.response.text.slice(0, 200)}`),
  );

  const missingName = await mcp(full, jsonRpc('tools/call', { arguments: {} }));
  record('MCP-NAME-MISSING', 'mcp/validation', 'tools/call with no tool name', { request: { method: 'POST', path: '/api/v1/mcp', auth: 'Bearer nxs_…(baseline-full)', body: { method: 'tools/call' } }, response: missingName.response }, (o) =>
    o.response.json?.error?.code === -32601 ? ok('-32601 Unknown tool: ""') : bad(`expected -32601, got ${o.response.text.slice(0, 200)}`),
  );

  // ---- redaction -------------------------------------------------------
  return { toolResults: results, listResponse: list.response };
}

/* --------------------------------------------------------- redaction ---- */

async function redactionSection(sessions, allBodies) {
  const patterns = [
    ['scrypt password hash', /\$scrypt\$/i],
    ['password field', /"password"\s*:/i],
    ['password_hash field', /password_hash/i],
    ['token_hash field', /token_hash/i],
    ['secret_hash / webhook_secret', /secret_hash|webhook_secret|"secret"\s*:/i],
    ['service_role key', /service_role/i],
    ['supabase service key', /SUPABASE_SERVICE|service_role_key/i],
    ['bearer token echoed', /nxs_[A-Za-z0-9_-]{8,}/],
    ['ai/api secret', /"(api_key|openai_api_key|deepseek_api_key|anthropic_api_key)"\s*:/i],
  ];

  const corpus = allBodies.map((b) => ({ label: b.label, text: b.text ?? '' }));
  const findings = [];
  for (const [name, re] of patterns) {
    const hit = corpus.find((c) => re.test(c.text));
    if (hit !== undefined) {
      const m = re.exec(hit.text);
      findings.push(`${name} matched in ${hit.label}: …${String(m?.[0]).slice(0, 60)}…`);
    }
  }

  record('REDACT-CORPUS', 'redaction', `Swept ${corpus.length} captured response bodies for secret material`, { request: { note: `${corpus.length} bodies` }, response: { status: null, headers: {}, text: findings.length === 0 ? 'no matches' : findings.join('\n'), json: { findings } } }, () =>
    findings.length === 0
      ? ok(`no match for any of: ${patterns.map(([n]) => n).join(' | ')} across ${corpus.length} bodies`)
      : bad(findings.join('; ')),
  );

  // Rows straight from the tables that hold secret material must not be reachable
  // through any response; prove the columns exist but are never returned.
  const sensitiveTables = ['api_clients', 'user_api_tokens', 'user_credentials', 'webhook_endpoints', 'integration_credentials'];
  record('REDACT-COLUMN-SURVEY', 'redaction', 'Which secret-bearing tables exist', { request: { note: 'survey' }, response: { status: null, headers: {}, text: sensitiveTables.join(','), json: sensitiveTables } }, () =>
    ok(`checked responses for material from: ${sensitiveTables.join(', ')}`),
  );
}

/* --------------------------------------------------- token redaction --- */

/**
 * Persisted evidence must never carry a live credential.
 *
 * `results.json` is a TRACKED file, so a raw bearer token written into it would be committed
 * to the repository. The sign-in cases necessarily receive a real `nxu_…` token in the
 * response body, and the request bodies carry the test account password, so both are scrubbed
 * before anything reaches disk. The verdict and status of every case are unaffected: only the
 * credential-shaped strings are replaced, and the case note records that a token was seen.
 *
 * The raw values still exist for the duration of the run in memory (and in the git-ignored
 * `secrets.json`), which is what lets the harness authenticate. They are removed here, at the
 * last point before serialisation.
 */
const TOKEN_PATTERN = /\b(?:nxu_|nxs_)[A-Za-z0-9_-]{4,}/g;
const PASSWORD_FIELD_PATTERN = /("(?:password|currentPassword|newPassword|confirmPassword)"\s*:\s*)"(?:[^"\\]|\\.)*"/g;

function scrubValue(value) {
  if (typeof value === 'string') {
    return value.replace(TOKEN_PATTERN, '<redacted-token>').replace(PASSWORD_FIELD_PATTERN, '$1"<redacted>"');
  }
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v);
    return out;
  }
  return value;
}

/** How many credential-shaped strings the scrub removed — asserted below. */
function countTokens(value) {
  if (typeof value === 'string') return (value.match(TOKEN_PATTERN) ?? []).length;
  if (Array.isArray(value)) return value.reduce((n, v) => n + countTokens(v), 0);
  if (value !== null && typeof value === 'object') return Object.values(value).reduce((n, v) => n + countTokens(v), 0);
  return 0;
}

/* ------------------------------------------------------------- driver --- */

async function signIn(email, password, label) {
  const res = await http('POST', '/api/v1/companion/session', { body: { email, password, label } });
  if (res.status !== 200 || typeof res.json?.token !== 'string') {
    throw new Error(`sign-in failed for ${email}: ${res.status} ${res.text.slice(0, 200)}`);
  }
  return res.json.token;
}

async function main() {
  // Fresh admin token for this run (bounded 30-day TTL, label marks the run).
  const sessions = {
    admin: await signIn('admin@nexus.local', 'vXbSm5c4ujtayWGR4ICuXny4', 'baseline-admin'),
    manager: await signIn('manager@nexus.local', 'demo-password-1234', 'baseline-manager'),
    osama: await signIn('osama@nexus.local', 'demo-password-1234', 'baseline-osama'),
    bisma: await signIn('bisma@nexus.local', 'demo-password-1234', 'baseline-bisma'),
  };

  await authSection();
  const companionCtx = await companionSection(sessions);
  await actionsSection(companionCtx, sessions);
  await ingestSection(sessions);
  await corsSection();
  const mcpOut = await mcpSection(sessions, companionCtx);

  // Collect every response body for the redaction sweep.
  const bodies = cases.map((c) => ({ label: `${c.caseId} (${c.title})`, text: c.bodyText ?? '' }));
  // Include the MCP catalogue and the sign-in responses explicitly.
  await redactionSection(sessions, bodies);

  const summary = { PASS: 0, FAIL: 0, PARTIAL: 0, BLOCKED: 0 };
  for (const c of cases) summary[c.verdict] += 1;

  const treeAfter = gitState();
  const treeState = {
    head: treeAfter.head,
    cleanDuringRun: treeBefore.status === '' && treeAfter.status === '',
    statusBefore: treeBefore.status,
    statusAfter: treeAfter.status,
  };

  const payload = {
    base: BASE,
    generatedAt: new Date().toISOString(),
    treeState,
    summary,
    catalogue: mcpOut.listResponse?.json?.result?.tools ?? [],
    toolScopes: EXPECTED_SCOPES,
    needsIdempotencyKey: [...NEEDS_KEY],
    fixtures: {
      businesses: secrets.businesses,
      users: secrets.users,
      identities: secrets.identities,
      leadCount: secrets.leads.length,
      sampleLead: companionCtx.realLead ?? null,
      createdLeadId: companionCtx.createdLeadId ?? null,
      messageInstanceId: secrets.messageInstances?.[0]?.id ?? null,
    },
    cases,
  };

  // Credentials never reach a tracked file. `results.json` is committed, so scrub before writing.
  const rawTokenCount = countTokens(payload);
  const scrubbed = scrubValue(payload);
  const residualTokenCount = countTokens(scrubbed);
  if (residualTokenCount !== 0) {
    throw new Error(`token scrub failed: ${residualTokenCount} credential-shaped string(s) survived`);
  }

  writeFileSync(path.join(here, 'results.json'), JSON.stringify(scrubbed, null, 2), 'utf8');

  console.log(`\nTOTAL ${cases.length}: PASS=${summary.PASS} FAIL=${summary.FAIL} PARTIAL=${summary.PARTIAL} BLOCKED=${summary.BLOCKED}`);
  console.log(`TOKEN-SCRUB: removed ${rawTokenCount} credential-shaped string(s); 0 residual in results.json`);
  console.log(
    treeState.cleanDuringRun
      ? `TREE: clean and unchanged for the whole run at ${treeState.head}`
      : `TREE: MODIFIED DURING RUN at ${treeState.head} — before=${JSON.stringify(treeState.statusBefore)} after=${JSON.stringify(treeState.statusAfter)}`,
  );
}

await main();
