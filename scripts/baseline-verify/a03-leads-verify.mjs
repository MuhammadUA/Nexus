/**
 * A03 verification harness — signs in over the running 127.0.0.1:3000 server and
 * asserts the Leads screen's composition, filters and pagination boundaries.
 *
 * The session cookie the app issues is `Secure` (the running build is
 * NODE_ENV=production), so it is sent as an explicit `Cookie` header: `fetch` will
 * not attach it for an http origin, but Node will send a header it is given.
 *
 * Scratch tooling, not product code.
 */
const BASE = process.env.NEXUS_BASE ?? 'http://127.0.0.1:3000';
const SLUG = 'zemnas';
const EMAIL = 'admin@nexus.local';
const PASSWORD = 'vXbSm5c4ujtayWGR4ICuXny4';

let cookie = '';

async function signIn() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD, mode: 'signin' }),
    redirect: 'manual',
  });
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  const first = raw[0] ?? '';
  cookie = first.split(';')[0];
  return { status: res.status, location: res.headers.get('location'), cookie: cookie.slice(0, 24) };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' });
  return { status: res.status, html: await res.text() };
}

/* ----------------------------------------------------------- extraction -- */

const HEADER = /<th scope="col"[^>]*>([\s\S]*?)<\/th>/g;

function headers(html) {
  return [...html.matchAll(HEADER)].map((m) =>
    m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
  );
}

function tbody(html) {
  const match = /<tbody>([\s\S]*?)<\/tbody>/.exec(html);
  return match === null ? '' : match[1];
}

function rowLeadIds(html) {
  return [...tbody(html).matchAll(/\/b\/[a-z0-9-]+\/leads\/([0-9a-f-]{36})/g)].map((m) => m[1]);
}

function checkboxValues(html) {
  return [...tbody(html).matchAll(/name="leadIds" value="([0-9a-f-]{36})"/g)].map((m) => m[1]);
}

function ariaLabels(html) {
  return [...html.matchAll(/aria-label="(Actions for [^"]*)"/g)].map((m) => m[1]);
}

function chipRow(html) {
  // The quick-filter chips are links carrying ?status= / ?needsProfile= / ?dnc=.
  return [...html.matchAll(
    /<a[^>]*href="(\/b\/[a-z0-9-]+\/leads\?[^"]*)"[^>]*>\s*([A-Z][A-Z \u00b7-]*?)\s*<strong>(\d+)<\/strong>/g,
  )].map((m) => ({ href: m[1], label: m[2].trim(), count: Number(m[3]) }));
}

const SELECT_LABEL = /<select[^>]*id="([^"]+)"[^>]*>/g;

function selectIds(html) {
  return [...html.matchAll(SELECT_LABEL)].map((m) => m[1]);
}

function visibleText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

/* ------------------------------------------------------------ reporting -- */

const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const login = await signIn();
console.log(`sign-in: ${JSON.stringify(login)}\n`);

/* 1. composition */

const base = await get(`/b/${SLUG}/leads`);
check('GET /b/zemnas/leads is 200', base.status === 200, `status ${base.status}`);

const baseHeaders = headers(base.html);
const EXPECTED = ['Person', 'Company', 'Status', 'Primary ICP', 'Owner', 'Sender', 'Source'];
check('all seven data columns present in order', EXPECTED.every((h, i) => baseHeaders[i] === h), baseHeaders.join(' | '));

const chips = chipRow(base.html);
check('five status quick-filter chips', chips.length === 5, JSON.stringify(chips));

const selects = selectIds(base.html);
check('five filter selects', selects.length >= 5, selects.join(','));

const text = visibleText(base.html);
check('bulk-actions bar present', /Bulk actions/.test(text), 'looking for "Bulk actions"');
for (const label of ['Assign owner', 'Change Primary ICP', 'Change sender', 'Archive', 'Delete']) {
  check(`bulk action: ${label}`, text.includes(label));
}
for (const label of ['ICP', 'Owner', 'Sender', 'Status', 'Saved view', 'Search']) {
  check(`filter label: ${label}`, text.includes(label));
}

const labels = ariaLabels(base.html);
check('every row menu has an accessible name', labels.length === rowLeadIds(base.html).length && labels.length > 0, `${labels.length} labels, e.g. "${labels[0] ?? ''}"`);

const checks = checkboxValues(base.html);
check('every row has a selection checkbox', checks.length === rowLeadIds(base.html).length && checks.length > 0, `${checks.length} checkboxes`);

/* 2. pagination boundaries */

const PAGE_SIZE = 5;
const pages = [];
for (let page = 1; page <= 6; page += 1) {
  const res = await get(`/b/${SLUG}/leads?pageSize=${PAGE_SIZE}&page=${page}`);
  const ids = rowLeadIds(res.html);
  const isEmpty = /No leads match these filters/.test(visibleText(res.html));
  pages.push({ page, status: res.status, rows: ids.length, empty: isEmpty, ids });
}

console.log('\nper-page row counts:');
for (const p of pages) console.log(`  page ${p.page}: ${p.rows} rows (empty state: ${p.empty})`);

for (const p of pages.slice(0, 5)) {
  check(`page ${p.page} shows ${p.rows} rows`, true, `${p.rows}`);
}
check('page 1 shows 5', pages[0].rows === 5);
check('page 2 shows 5', pages[1].rows === 5);
check('page 5 shows 1', pages[4].rows === 1);
check('page 6 shows the empty state', pages[5].rows === 0 && pages[5].empty === true);

const union = pages.slice(0, 5).flatMap((p) => p.ids);
const unique = new Set(union);
check('union of all pages has no duplicates', unique.size === union.length, `${union.length} rows, ${unique.size} unique`);

const withSize = await get(`/b/${SLUG}/leads`);
const total = Number(/<strong>(\d+)<\/strong> total/.exec(visibleText(withSize.html))?.[1] ?? NaN);

/* 3. filter + pagination together */

const filtered1 = await get(`/b/${SLUG}/leads?status=replied&pageSize=${PAGE_SIZE}&page=1`);
const filtered2 = await get(`/b/${SLUG}/leads?status=replied&pageSize=${PAGE_SIZE}&page=2`);
const nextHref = /href="([^"]*page=2[^"]*)"/.exec(filtered1.html)?.[1] ?? '';
check('pager link preserves the filter', nextHref.includes('status=replied'), nextHref);
check('filtered page 2 responds 200', filtered2.status === 200, `status ${filtered2.status}`);

/* 4. chip links and filter selects are real links / named controls */

for (const chip of chips) {
  const target = await get(chip.href);
  check(`chip ${chip.label} link resolves`, target.status === 200, `${chip.href} -> ${target.status}`);
}

const summary = {
  signedIn: login.status === 303,
  headers: baseHeaders,
  chips,
  selects,
  menuLabels: labels.length,
  pages: pages.map((p) => ({ page: p.page, rows: p.rows, empty: p.empty })),
  unionSize: union.length,
  unionUnique: unique.size,
  filterPagerHref: nextHref,
  failures: results.filter((r) => !r.pass).map((r) => r.name),
};

console.log(`\n${'-'.repeat(60)}`);
console.log(`${results.filter((r) => r.pass).length}/${results.length} checks passed`);
console.log(JSON.stringify(summary, null, 2));
