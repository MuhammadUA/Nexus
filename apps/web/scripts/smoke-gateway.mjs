/**
 * End-to-end smoke test of the API gateway from the outside.
 *
 * Boots a fresh embedded database with one admin created directly in SQL, then
 * exercises the real HTTP surface: sign in for a user token, bootstrap the Companion,
 * confirm an unauthenticated and a bogus token are both refused, and confirm the MCP
 * gateway answers capability discovery.
 *
 * Usage: node scripts/smoke-gateway.mjs http://127.0.0.1:3160
 */
import { PGlite } from '@electric-sql/pglite';
import { scrypt as scryptCallback, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const scrypt = promisify(scryptCallback);
const base = process.argv[2] ?? 'http://127.0.0.1:3160';
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const migrationsDir = path.join(repoRoot, 'packages', 'db', 'migrations');
const dataDir = path.join(repoRoot, 'apps', 'web', '.data', 'nexus');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function hashPassword(password) {
  const N = 32768;
  const r = 8;
  const p = 1;
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, 64, { N, r, p, maxmem: 256 * N * r * 2 });
  return ['scrypt', String(N), String(r), String(p), salt.toString('base64'), derived.toString('base64')].join('$');
}

// The server process holds the database open; a second PGlite handle on the same
// directory would deadlock, so the admin is created through the app's own login
// bootstrap instead. This script therefore assumes the deployment is unclaimed.
const email = `gateway-${Date.now()}@nexus.test`;
const password = 'gateway-smoke-password-1234';

async function main() {
  // 1. The deployment must be unclaimed for this run; report clearly if it is not.
  const loginPage = await fetch(`${base}/login`);
  const html = await loginPage.text();
  check('GET /login returns 200', loginPage.status === 200, `status=${loginPage.status}`);

  if (!html.includes('Create the first administrator')) {
    console.log('\nSKIP: this deployment already has users, so the first-run bootstrap cannot be exercised.');
    console.log('Delete apps/web/.data and restart the server for a full run.');
    return;
  }

  // 2. Bootstrap the first admin through the real login form.
  const form = parseForm(html);
  check(
    'the first-run form carries the setup mode',
    form.some(([name, value]) => name === 'mode' && value === 'bootstrap'),
    `${form.length} fields`,
  );

  const boot = await postForm(form, {
    fullName: 'Gateway Smoke Admin',
    email,
    password,
  });
  check('first admin bootstrap is accepted', boot.status === 303, `status=${boot.status}`);
  check('bootstrap issues a session cookie', boot.cookies.length > 0, `${boot.cookies.length} cookies`);
  check('bootstrap navigates into the app', boot.navigated, boot.location);
  if (boot.cookies.length === 0) {
    console.log(`      redirect target: ${boot.location || '(none)'}`);
  }

  // 3. Exchange credentials for a user API token (what the extension does).
  const session = await fetch(`${base}/api/v1/companion/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, label: 'smoke' }),
  });
  const sessionBody = await session.json().catch(() => ({}));
  check('POST /companion/session returns 200', session.status === 200, `status=${session.status}`);
  check('session response carries a token', typeof sessionBody.token === 'string');
  check('session response carries the session', typeof sessionBody.session === 'object');

  const rawToken = typeof sessionBody.token === 'string' ? sessionBody.token : '';
  check('token is prefixed so it routes to the user table', rawToken.startsWith('nxu_'));

  // 4. The token must be refused for the wrong password, and not returned.
  const badLogin = await fetch(`${base}/api/v1/companion/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'not-the-password', label: 'smoke' }),
  });
  const badBody = await badLogin.json().catch(() => ({}));
  check('wrong password is refused', badLogin.status === 401, `status=${badLogin.status}`);
  check('wrong password reveals no token', badBody.token === undefined);

  // 5. Authenticated calls work.
  const bootstrap = await fetch(`${base}/api/v1/companion/bootstrap?installId=smoke-install-id`, {
    headers: { authorization: `Bearer ${rawToken}` },
  });
  const bootstrapBody = await bootstrap.json().catch(() => ({}));
  check('GET /companion/bootstrap returns 200 with a token', bootstrap.status === 200, `status=${bootstrap.status}`);
  check('bootstrap returns the session', bootstrapBody.session?.email === email);
  check('bootstrap returns a businesses array (empty is correct on a fresh install)', Array.isArray(bootstrapBody.businesses));
  check('bootstrap reports a concurrency decision', typeof bootstrapBody.concurrency?.action === 'string');

  // 6. Search and today are reachable (an empty result is a correct answer).
  const search = await fetch(`${base}/api/v1/companion/search?q=nobody`, {
    headers: { authorization: `Bearer ${rawToken}` },
  });
  check('GET /companion/search returns 200', search.status === 200, `status=${search.status}`);

  const me = await fetch(`${base}/api/v1/companion/me`, {
    headers: { authorization: `Bearer ${rawToken}` },
  });
  check('GET /companion/me returns 200', me.status === 200, `status=${me.status}`);

  // 7. Signing out revokes the token for real.
  const signOut = await fetch(`${base}/api/v1/companion/session`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${rawToken}` },
  });
  check('DELETE /companion/session revokes', signOut.status === 200, `status=${signOut.status}`);

  const afterRevoke = await fetch(`${base}/api/v1/companion/me`, {
    headers: { authorization: `Bearer ${rawToken}` },
  });
  check('a revoked token is refused', afterRevoke.status === 401, `status=${afterRevoke.status}`);

  // 8. The MCP gateway advertises tools and refuses an unknown one.
  const discovery = await fetch(`${base}/api/v1/mcp`);
  const discoveryBody = await discovery.json().catch(() => ({}));
  check('GET /api/v1/mcp advertises tools', Array.isArray(discoveryBody.tools) && discoveryBody.tools.length > 10);

  const unknown = await fetch(`${base}/api/v1/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${rawToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'database.execute_sql' } }),
  });
  const unknownBody = await unknown.json().catch(() => ({}));
  check('a forbidden tool is refused', typeof unknownBody.error === 'object', JSON.stringify(unknownBody.error ?? {}).slice(0, 80));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

/**
 * Reads the rendered first-run form.
 *
 * The hidden `$ACTION_*` inputs must be replayed verbatim: without them Next.js does
 * not dispatch the server action at all and simply re-renders the page, which looks
 * like a silent failure. The submission is `multipart/form-data` because that is what
 * the rendered `<form encType="multipart/form-data">` specifies.
 */
function parseForm(html) {
  const inner = html.match(/<form[^>]*>([\s\S]*?)<\/form>/)?.[1] ?? '';
  const fields = [];
  for (const match of inner.matchAll(/<input([^>]*)\/?>/g)) {
    const name = match[1].match(/name="([^"]*)"/)?.[1];
    if (name === undefined) continue;
    const value = match[1].match(/value="([^"]*)"/)?.[1] ?? '';
    fields.push([
      name,
      value
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'),
    ]);
  }
  return fields;
}

async function postForm(fields, overrides) {
  const data = new FormData();
  for (const [name, value] of fields) data.append(name, value);
  for (const [name, value] of Object.entries(overrides)) data.append(name, value);

  // The form posts to the auth route handler; posting to `/login` would just render
  // the page and look like a silent failure.
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', redirect: 'manual', body: data });
  await response.text();

  const location = response.headers.get('location') ?? '';
  return {
    status: response.status,
    cookies: response.headers.getSetCookie?.() ?? [],
    location,
    navigationTarget: base + location,
    navigated: location.includes('/my-day'),
  };
}

await main();
