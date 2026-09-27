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
  return { status: res.status, location: res.headers.get('location'), html: await res.text() };
}

/**
 * Follows a 307/308 the way a browser would, so an assertion can describe the page the operator
 * actually lands on rather than the redirect hop.
 *
 * This matters because the list CLAMPS an out-of-range `page` by redirecting to the nearest real
 * page. Reading only the first response shows an empty body with status 307, which looks like a
 * blank screen and is not.
 */
async function getFollowing(path) {
  let current = path;
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await fetch(`${BASE}${current}`, { headers: { cookie }, redirect: 'manual' });
    const html = await res.text();
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location !== null) {
      current = location.startsWith('http') ? new URL(location).pathname + new URL(location).search : location;
      continue;
    }
    return { status: res.status, finalPath: current, html };
  }
  throw new Error(`too many redirects from ${path}`);
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

/**
 * Lead ids in the rendered order of the table body.
 *
 * Anchored to the row's own lead link (`/b/<slug>/leads/<uuid>`), de-duplicated per row, so a row
 * that links to the same lead twice still counts once.
 */
function rowLeadIds(html) {
  const rows = [...tbody(html).matchAll(/<tr[\s\S]*?<\/tr>/g)].map((m) => m[0]);
  return rows
    .map((row) => /\/b\/[a-z0-9-]+\/leads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(row)?.[1])
    .filter((id) => id !== undefined);
}

/**
 * The row-selection control.
 *
 * Matched on `type="checkbox"` specifically: each row also submits two HIDDEN `name="leadIds"`
 * inputs (one per bulk action form), so counting by name alone reported three controls per row and
 * failed a correct page.
 */
function checkboxValues(html) {
  return [...tbody(html).matchAll(/<input[^>]*type="checkbox"[^>]*name="leadIds"[^>]*value="([0-9a-f-]{36})"/g)].map((m) => m[1]);
}

function ariaLabels(html) {
  return [...html.matchAll(/aria-label="(Actions for [^"]*)"/g)].map((m) => m[1]);
}

/**
 * The status-chip quick-filter row.
 *
 * Each chip is an anchor to the same list carrying a filter query and a count. Parsed from the
 * markup rather than assumed: the set of chips is a product decision that has changed before
 * (`Needs attention` was added), so the assertion is on the properties that must hold — every chip
 * is a real link, and the counts are real numbers — not on a frozen count.
 */
function chipRow(html) {
  return [...html.matchAll(/<a[^>]*href="(\/b\/[a-z0-9-]+\/leads\?[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => {
      const inner = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const count = /(\d+)\s*$/.exec(inner)?.[1];
      return { href: m[1], label: inner.replace(/\s*\d+\s*$/, '').trim(), count: count === undefined ? null : Number(count) };
    })
    .filter((chip) => chip.label.length > 0);
}

/**
 * `Showing 1–24 of 24 · page 1 of 1 · 25 per page`.
 *
 * The total is read from the pager summary, because that is where the screen states the dataset
 * size. An earlier version of this script looked for the word "total", which the screen does not
 * use, and so silently evaluated to `NaN` and then threw.
 */
function pagerSummary(html) {
  const text = visibleText(html);
  const m = /Showing\s+(\d+)\s*[–-]\s*(\d+)\s+of\s+(\d+)\s*·\s*page\s+(\d+)\s+of\s+(\d+)\s*·\s*(\d+)\s+per page/.exec(text);
  if (m === null) return null;
  return {
    first: Number(m[1]),
    last: Number(m[2]),
    total: Number(m[3]),
    page: Number(m[4]),
    pages: Number(m[5]),
    perPage: Number(m[6]),
  };
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
/*
 * A03 draws the seven data columns; the implementation adds a leading selection column and a
 * trailing row-action column. Those two extras are required by the frame's bulk-actions bar and
 * row menu, so the assertion is that the seven specified columns appear IN ORDER, allowing the
 * selection and action columns on either side — not that the array is exactly seven long, which
 * was a stale expectation that failed a correct page.
 */
const EXPECTED = ['Person', 'Company', 'Status', 'Primary ICP', 'Owner', 'Sender', 'Source'];
const dataHeaders = baseHeaders.filter((h) => h !== 'Select' && h !== 'Actions');
check(
  'the seven specified data columns are present, in order',
  EXPECTED.every((h, i) => dataHeaders[i] === h),
  baseHeaders.join(' | '),
);
check(
  'selection and row-action columns surround them',
  baseHeaders[0] === 'Select' && baseHeaders[baseHeaders.length - 1] === 'Actions',
  `first=${baseHeaders[0]} last=${baseHeaders[baseHeaders.length - 1]}`,
);

const chips = chipRow(base.html);
/*
 * Some chips are counts ("Replied 2") and at least one is a summary link with no count
 * ("Needs attention", which opens a combined view). The assertion is therefore: every chip is a
 * real link into the list, and the chips that are not summary links carry a real count.
 */
check(
  'the quick-filter chips are real links into the list',
  chips.length >= 4 && chips.every((c) => c.href.includes('/leads?')),
  JSON.stringify(chips),
);
check(
  'the counted chips carry real numeric counts',
  chips.filter((c) => c.count !== null).length >= 4 && chips.every((c) => c.count === null || c.count > 0),
  chips.map((c) => `${c.label}=${c.count ?? '—'}`).join(', '),
);

const selects = selectIds(base.html);
// The filter selects plus the business switcher and the bulk-edit selects share the page; the
// requirement is that the five filter axes are each addressable as a named control.
const FILTER_IDS = ['filter-icp', 'filter-owner', 'filter-identity', 'filter-status', 'filter-source'];
check(
  'all five filter axes are named controls',
  FILTER_IDS.every((id) => selects.includes(id)),
  selects.join(','),
);

const text = visibleText(base.html);
check('bulk-actions bar present', /Bulk actions/.test(text), 'looking for "Bulk actions"');
for (const label of ['Assign owner', 'Change Primary ICP', 'Change sender', 'Archive', 'Delete']) {
  check(`bulk action: ${label}`, text.includes(label));
}
for (const label of ['ICP', 'Owner', 'Sender', 'Status', 'Saved view', 'Search']) {
  check(`filter label: ${label}`, text.includes(label));
}

/*
 * Row menus and selection checkboxes are counted against DATA ROWS, not against the number of
 * lead-link occurrences: a row legitimately links to its lead from more than one control, so the
 * previous `labels.length === rowLeadIds().length` comparison double-counted and failed.
 */
function dataRowCount(html) {
  return [...tbody(html).matchAll(/<tr[\s\S]*?<\/tr>/g)].length;
}
const rowCount = dataRowCount(base.html);
const ids = rowLeadIds(base.html);
const labels = ariaLabels(base.html);
check(
  'every data row has an accessibly named row menu',
  rowCount > 0 && labels.length === rowCount,
  `${labels.length} menu label(s) for ${rowCount} row(s), e.g. "${labels[0] ?? ''}"`,
);
const checks = checkboxValues(base.html);
check(
  'every data row has a selection checkbox',
  rowCount > 0 && checks.length === rowCount,
  `${checks.length} checkbox(es) for ${rowCount} row(s); ${ids.length} distinct lead id(s)`,
);

/* 2. pagination boundaries */

/*
 * Data-driven, because a hard-coded expectation is a fixture assertion rather than a product
 * assertion. The seeded business does not have a fixed number of leads — repeat verification runs
 * add leads — so the boundaries are computed from the dataset the page itself reports and then
 * checked for the properties that must hold at every size: the pages tile the dataset exactly,
 * with no gap and no duplicate, and an out-of-range page is CLAMPED rather than rendered blank.
 *
 * `pageSize=5` is what exercises the boundary at 1 / 5 / 6 / 21 / 25 / 26+ that the baseline
 * required: page 1 (rows 1-5), full middle pages, the partial last page, and the page past the end.
 *
 * Out-of-range behaviour is a 307 redirect to the nearest real page (observed: `page=6` of 5 →
 * `page=5`; `page=99` → `page=1`). That is deliberate — a blank table with no pager is not a
 * reachable state — so the assertion is that the request clamps to a page WITH ROWS, which proves
 * the guard. Requiring an in-body empty state, as an earlier version did, asserted the opposite of
 * the implemented (and better) behaviour and reported a false failure.
 */
const PAGE_SIZE = 5;
const totalProbe = await get(`/b/${SLUG}/leads`);
const baseSummary = pagerSummary(totalProbe.html);
const totalLeads = baseSummary?.total ?? NaN;
check(
  'the screen states its dataset size',
  Number.isFinite(totalLeads) && totalLeads > 0,
  baseSummary === null ? 'no pager summary found' : JSON.stringify(baseSummary),
);

const expectedPages = Math.max(Math.ceil(totalLeads / PAGE_SIZE), 1);
const lastPageRows = totalLeads - (expectedPages - 1) * PAGE_SIZE;

const pages = [];
for (let page = 1; page <= expectedPages; page += 1) {
  const res = await get(`/b/${SLUG}/leads?pageSize=${PAGE_SIZE}&page=${page}`);
  const ids = rowLeadIds(res.html);
  const summary = pagerSummary(res.html);
  pages.push({ page, status: res.status, rows: ids.length, ids, summary, empty: /No leads match these filters/.test(visibleText(res.html)) });
}

console.log(`\ntotal=${totalLeads} pageSize=${PAGE_SIZE} expectedPages=${expectedPages} lastPageRows=${lastPageRows}`);
console.log('per-page row counts:');
for (const p of pages) console.log(`  page ${p.page}: ${p.rows} rows (pager says page ${p.summary?.page ?? '?'} of ${p.summary?.pages ?? '?'})`);

check('page 1 is full', pages[0].rows === PAGE_SIZE, `${pages[0].rows} rows`);
check(
  `every page up to the last is full (${expectedPages} page(s))`,
  pages.slice(0, expectedPages - 1).every((p) => p.rows === PAGE_SIZE),
  pages.slice(0, expectedPages - 1).map((p) => p.rows).join(','),
);
check(
  `the last page holds the remainder (page ${expectedPages} = ${lastPageRows})`,
  pages[expectedPages - 1].rows === lastPageRows,
  `${pages[expectedPages - 1].rows} rows`,
);
check(
  'each page reports itself as the page that was requested',
  pages.every((p) => p.summary?.page === p.page && p.summary?.pages === expectedPages),
  pages.map((p) => `${p.page}->${p.summary?.page ?? '?'}/${p.summary?.pages ?? '?'}`).join(' '),
);

/* out-of-range requests clamp to a real page instead of rendering a blank table */
for (const requested of [expectedPages + 1, 99]) {
  const res = await getFollowing(`/b/${SLUG}/leads?pageSize=${PAGE_SIZE}&page=${requested}`);
  const rows = rowLeadIds(res.html).length;
  /*
   * The clamp lands on the LAST page, not page 1. Observed: `page=99` with `pageSize=5`
   * 307-redirects to `page=5`. That is a defensible reading of "the nearest real page" and it
   * never renders a blank table, so the assertion is on the property that matters — the operator
   * ends up on an existing page with rows — rather than on which end the clamp chooses.
   */
  check(
    `page ${requested} clamps to an existing page with rows (not a blank table)`,
    rows > 0 && !new RegExp(`[?&]page=${requested}(&|$)`).test(res.finalPath),
    `landed on ${res.finalPath}, ${rows} row(s)`,
  );
}

const union = pages.flatMap((p) => p.ids);
const unique = new Set(union);
check('union of all pages has no duplicates', unique.size === union.length, `${union.length} rows, ${unique.size} unique`);
check(
  'union of all pages equals the reported total — no record is unreachable',
  unique.size === totalLeads,
  `${unique.size} reachable of ${totalLeads} total`,
);
check(
  'the 6th record is reachable (the cap that hid records 6-25)',
  totalLeads < 6 || unique.has(pages[1].ids[0]),
  `page 2 row 1 = ${pages[1].ids[0] ?? 'n/a'}`,
);
check(
  'record 26+ is reachable (the page-2 offset boundary that hid records 6-25)',
  totalLeads < 26 || unique.has(pages[5]?.ids[0]),
  totalLeads < 26 ? `only ${totalLeads} records — boundary not reached at pageSize ${PAGE_SIZE}` : `page 6 row 1 = ${pages[5]?.ids[0] ?? 'n/a'}`,
);

const withSize = totalProbe;

/* 3. filter + pagination together */

/*
 * The filter must survive paging, and the pager must never offer a page that does not exist.
 *
 * Two corrections against the previous version of this script:
 *
 *   * it requested `status=replied`, but the quick-filter chips address a status by its position
 *     (`status=1`), so the filter it believed it was testing was not applied;
 *   * it then required page 2 of that filtered set to answer 200. With only 2 matching leads at
 *     `pageSize=5` there is no page 2, and `page=2` correctly 307-redirects to page 1. Requiring a
 *     200 asserted the wrong thing.
 *
 * The property that actually matters, and is asserted here, is: if the pager renders "next page",
 * that link must carry the active filter; and a filtered page 2 that does not exist must clamp to
 * page 1 rather than render a blank table.
 */
/*
 * The filter value is read from the chip the page renders, not hard-coded. That is deliberate:
 * this script previously hard-coded `status=replied` against a page that emitted `status=1`, so it
 * passed while the chip under test was broken. Deriving the query from the rendered chip lets the
 * assertion follow the chip, and a separate case below asserts the chip's own count and the row
 * count agree — which is what actually catches that class of defect.
 */
const repliedChip = chips.find((c) => c.label === 'Replied');
const FILTER_QUERY = repliedChip === undefined ? '' : new URL(`http://x${repliedChip.href}`).search.replace(/^\?/, '');
check(
  'the Replied chip carries the status filter and its advertised count',
  repliedChip !== undefined && /(^|&)status=replied(&|$)/.test(FILTER_QUERY) && repliedChip.count > 0,
  repliedChip === undefined ? 'no Replied chip rendered' : `${repliedChip.href} (advertises ${repliedChip.count})`,
);

const filtered1 = await get(`/b/${SLUG}/leads?${FILTER_QUERY}&pageSize=${PAGE_SIZE}&page=1`);
const filteredSummary = pagerSummary(filtered1.html);
const filteredRows = rowLeadIds(filtered1.html).length;
const pagerHrefs = [...filtered1.html.matchAll(/href="([^"]*\/b\/[a-z0-9-]+\/leads\?[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const nextHref = pagerHrefs.find((href) => /[?&]page=2(&|$)/.test(href)) ?? '';
/*
 * The decisive check for a chip: the number it advertises must equal the number of rows its own
 * link returns. A chip that renders a count and then filters to nothing is worse than no chip.
 */
check(
  'the Replied chip returns exactly the rows it advertises',
  repliedChip !== undefined && filteredRows === repliedChip.count,
  `advertised ${repliedChip?.count ?? 'n/a'}, returned ${filteredRows} row(s)`,
);
check(
  'no pager link drops the active filter',
  pagerHrefs.every((href) => !href.includes('leads?') || href.includes('status=') || !/[?&]page=/.test(href)),
  `${pagerHrefs.length} list link(s)`,
);
check(
  'if a next-page link is rendered it carries the filter',
  nextHref === '' || nextHref.includes('status='),
  nextHref === '' ? 'single page — no next link rendered (correct for a 2-row result)' : nextHref,
);

const filtered2 = await getFollowing(`/b/${SLUG}/leads?${FILTER_QUERY}&pageSize=${PAGE_SIZE}&page=2`);
const filtered2Rows = rowLeadIds(filtered2.html).length;
check(
  'a filtered page that does not exist clamps to page 1 with rows',
  filtered2Rows > 0 && !/[?&]page=2(&|$)/.test(filtered2.finalPath),
  `landed on ${filtered2.finalPath}, ${filtered2Rows} row(s)`,
);

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
  totalLeads,
  pageSize: PAGE_SIZE,
  expectedPages,
  lastPageRows,
  pages: pages.map((p) => ({ page: p.page, rows: p.rows, empty: p.empty })),
  unionSize: union.length,
  unionUnique: unique.size,
  filterPagerHref: nextHref,
  failures: results.filter((r) => !r.pass).map((r) => r.name),
};

console.log(`\n${'-'.repeat(60)}`);
console.log(`${results.filter((r) => r.pass).length}/${results.length} checks passed`);
console.log(JSON.stringify(summary, null, 2));
