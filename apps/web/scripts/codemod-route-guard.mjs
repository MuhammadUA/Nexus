/**
 * One-off: add the route guard to the admin configuration surfaces.
 *
 * Kept in the repository as the record of exactly which files were changed and how, rather than as
 * a hand-edit nobody can audit afterwards. It is idempotent: running it twice changes nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** file -> [route pattern, the line that establishes the context]. */
const TARGETS = [
  ['src/app/(app)/business-domains/page.tsx', '/business-domains'],
  ['src/app/(app)/team/page.tsx', '/team'],
  ['src/app/(app)/team/[id]/page.tsx', '/team/:userId/permissions'],
  ['src/app/(app)/settings/page.tsx', '/settings'],
  ['src/app/(app)/integrations/page.tsx', '/integrations'],
  ['src/app/(app)/identities/page.tsx', '/identities'],
  ['src/app/(app)/identities/[id]/page.tsx', '/identities/:identityId'],
  ['src/app/(app)/my-access/page.tsx', '/my-access'],
  ['src/app/(app)/trash/page.tsx', '/trash'],
];

const IMPORT_ANCHORS = [
  "import { loadViewerContext } from '@/lib/viewer-context';",
  "import { loadViewerContext, type ViewerContext } from '@/lib/viewer-context';",
];
const IMPORT_LINE = "import { requireRouteAccess } from '@/lib/route-guard';";

let changed = 0;
for (const [file, route] of TARGETS) {
  if (route === undefined) continue;
  let source = readFileSync(file, 'utf8');

  const anchor = IMPORT_ANCHORS.find((candidate) => source.includes(candidate));
  if (anchor === undefined) {
    console.log(`SKIP ${file}: no loadViewerContext import`);
    continue;
  }
  if (!source.includes(IMPORT_LINE)) {
    source = source.replace(anchor, `${anchor}\n${IMPORT_LINE}`);
  }

  const guard = `  await requireRouteAccess(context, { route: '${route}' });`;
  if (source.includes(`route: '${route}'`)) {
    writeFileSync(file, source, 'utf8');
    console.log(`already guarded ${file}`);
    continue;
  }

  // Insert immediately after the viewer context is established, before any repository call.
  // Tolerant of CRLF and of a trailing comment on the same line.
  const pattern = /([ \t]*const context = await loadViewerContext\(\);[^\r\n]*\r?\n)/;
  const match = pattern.exec(source);
  if (match === null) {
    console.log(`SKIP ${file}: no context assignment`);
    continue;
  }
  source = source.replace(pattern, `$1${guard}\n`);
  writeFileSync(file, source, 'utf8');
  changed += 1;
  console.log(`guarded ${file} -> ${route}`);
}

console.log(`\n${String(changed)} files guarded`);
