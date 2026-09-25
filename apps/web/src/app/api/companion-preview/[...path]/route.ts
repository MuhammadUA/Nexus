/**
 * Serves the built Companion panel from the app's own origin.
 *
 * The panel calls `http://127.0.0.1:3000`, and an unpacked extension may only reach origins in
 * its `host_permissions`. Serving the panel from a different port therefore fails at fetch
 * before the request leaves the browser, which looks like a broken sign-in but is an artefact of
 * the harness. Mounting the built bundle under the app's own origin removes that difference.
 *
 * This is a development preview only: it is off unless `NEXUS_COMPANION_PREVIEW=1`, it serves
 * one directory, and it never handles a request for any other path.
 */
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), '..', 'extension', 'dist');
const PREFIX = '/api/companion-preview';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export async function GET(request: Request): Promise<Response> {
  if (process.env.NEXUS_COMPANION_PREVIEW !== '1') {
    return new Response('companion preview is disabled', { status: 404 });
  }

  const url = new URL(request.url);
  const relative = url.pathname.slice(PREFIX.length);
  const requested = relative.length === 0 || relative === '/' ? '/sidepanel.html' : relative;
  const file = path.join(DIST, path.normalize(requested).replace(/^[\\/]+/, ''));

  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    return new Response('not found', { status: 404 });
  }

  const body = await readFile(file);
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    },
  });
}
