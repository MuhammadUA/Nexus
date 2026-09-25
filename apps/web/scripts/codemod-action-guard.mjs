/**
 * One-off: make the admin server actions authorize independently of their pages.
 *
 * A Server Action is a public endpoint once any page has rendered it: the client posts to an action
 * id and nothing about that request passes through the page. Guarding the page therefore protects
 * nothing for the action. This inserts a permission check at the top of each admin action, before
 * any parsing or repository call.
 *
 * The check is inserted after the `_previous: ActionResult, formData: FormData,` parameter block —
 * i.e. as the first statement of the body — so it cannot be skipped by an early return.
 *
 * Idempotent: running it twice changes nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TARGETS = [
  ['src/app/(app)/team/actions.ts', '/team'],
  ['src/app/(app)/team/[id]/actions.ts', '/team/:userId/permissions'],
  ['src/app/(app)/settings/actions.ts', '/settings'],
  ['src/app/(app)/integrations/actions.ts', '/integrations'],
  ['src/app/(app)/businesses/new/actions.ts', '/businesses/new'],
  ['src/app/(app)/business-domains/actions.ts', '/business-domains'],
  ['src/app/(app)/identities/[id]/actions.ts', '/identities'],
];

const IMPORT_LINE = "import { authorizeAction } from '@/lib/route-guard';";
const IMPORT_ANCHOR = "import { currentViewer } from '@/lib/current-viewer';";

let changed = 0;
for (const [file, route] of TARGETS) {
  if (route === undefined) continue;
  let source = readFileSync(file, 'utf8');

  if (!source.includes(IMPORT_LINE)) {
    if (source.includes(IMPORT_ANCHOR)) {
      source = source.replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}\n${IMPORT_LINE}`);
    } else {
      // No currentViewer import; anchor the import after the last import line instead.
      const lines = source.split(/\r?\n/);
      let lastImport = -1;
      for (const [index, line] of lines.entries()) {
        if (/^import /.test(line) || /^} from '/.test(line)) lastImport = index;
      }
      lines.splice(lastImport + 1, 0, IMPORT_LINE);
      source = lines.join('\n');
    }
  }

  // Insert the guard as the first statement of every exported action body.
  const actionPattern = /(export async function (\w+Action)\(\r?\n(?:[^)]*\r?\n)*?\)[^{]*\{\r?\n)/g;
  let inserted = 0;
  source = source.replace(actionPattern, (match, header, name) => {
    if (match.includes('authorizeAction(')) return match;
    inserted += 1;
    return `${header}  // Independently authorized: a Server Action is reachable without its page.\n  const refusal = await authorizeAction(null, { route: '${route}' });\n  if (refusal !== null) return refusal;\n\n`;
  });

  writeFileSync(file, source, 'utf8');
  changed += inserted;
  console.log(`${file}: ${String(inserted)} action(s) guarded with ${route}`);
}

console.log(`\n${String(changed)} actions guarded`);
