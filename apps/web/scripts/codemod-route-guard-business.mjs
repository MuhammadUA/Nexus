/**
 * One-off: add the route guard to the business-scoped configuration surfaces.
 *
 * These are judged against the named business's own grant, not the union across every business the
 * operator can reach — which is the difference that stops a manager of one business opening
 * another's ICP manager. The guard therefore needs the resolved business id, so it is inserted after
 * `const business = resolveBusiness(...)` and the `notFound()` that follows it.
 *
 * Idempotent: running it twice changes nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** file -> route pattern. The business id comes from the page's own resolved business. */
const TARGETS = [
  ['src/app/b/[slug]/setup/brain/page.tsx', '/b/:businessSlug/setup/brain'],
  ['src/app/b/[slug]/setup/icps/page.tsx', '/b/:businessSlug/setup/icps'],
  ['src/app/b/[slug]/setup/sequences/page.tsx', '/b/:businessSlug/setup/sequences'],
  ['src/app/b/[slug]/setup/knowledge/page.tsx', '/b/:businessSlug/setup/knowledge'],
  ['src/app/b/[slug]/automations/page.tsx', '/b/:businessSlug/automations'],
  ['src/app/b/[slug]/insights/messaging/page.tsx', '/b/:businessSlug/insights/messaging'],
  ['src/app/b/[slug]/lead-sources/import/page.tsx', '/b/:businessSlug/lead-sources/import'],
  ['src/app/b/[slug]/profile-queue/page.tsx', '/b/:businessSlug/profile-queue'],
  ['src/app/b/[slug]/duplicates/page.tsx', '/b/:businessSlug/duplicates'],
  ['src/app/b/[slug]/trash/page.tsx', '/b/:businessSlug/trash'],
  ['src/app/b/[slug]/reactivation/page.tsx', '/b/:businessSlug/reactivation'],
  ['src/app/b/[slug]/lead-sources/page.tsx', '/b/:businessSlug/lead-sources'],
];

const IMPORT_LINE = "import { requireRouteAccess } from '@/lib/route-guard';";
const IMPORT_ANCHOR = "import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';";
const IMPORT_ANCHOR_ALT = "import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context'";

let changed = 0;
for (const [file, route] of TARGETS) {
  if (route === undefined) continue;
  let source = readFileSync(file, 'utf8');

  if (!source.includes(IMPORT_ANCHOR_ALT)) {
    console.log(`SKIP ${file}: unexpected viewer-context import`);
    continue;
  }
  if (!source.includes(IMPORT_LINE)) {
    source = source.replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}\n${IMPORT_LINE}`);
  }

  if (source.includes(`route: '${route}'`)) {
    writeFileSync(file, source, 'utf8');
    console.log(`already guarded ${file}`);
    continue;
  }

  // After the business is resolved and rejected-if-hidden, and before the first repository call.
  const pattern = /([ \t]*if \(business === null\) notFound\(\);[^\r\n]*\r?\n)/;
  if (!pattern.test(source)) {
    console.log(`SKIP ${file}: no business guard`);
    continue;
  }
  const guard = `\n  // Business-scoped configuration: judged against this business's grant alone.\n  await requireRouteAccess(context, { route: '${route}', businessId: business.id });\n`;
  source = source.replace(pattern, `$1${guard}`);
  writeFileSync(file, source, 'utf8');
  changed += 1;
  console.log(`guarded ${file} -> ${route}`);
}

console.log(`\n${String(changed)} files guarded`);
