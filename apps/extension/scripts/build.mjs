/**
 * Builds the extension the way a release does, and validates the artefact.
 *
 * The extension is the one piece of Nexus that runs inside a logged-in LinkedIn session, so the
 * artefact is checked rather than trusted: manifest shape, permission set, host scope, CSP, and a
 * scan of every shipped byte for a credential. The scan is deliberately simple and literal —
 * a secret that needs a clever regex to find is a secret that will be missed.
 */
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist');

/**
 * The permission set is fixed here, not taken from the environment.
 *
 *   sidePanel — the product is a side panel
 *   storage   — session token + list state
 *   tabs      — "open the prospect's profile in the active tab"
 *   alarms    — browser-session heartbeat
 *
 * `scripting` is deliberately absent: nothing in the extension calls `chrome.scripting`. The
 * LinkedIn capture is a declared content script, which needs no dynamic injection, so the
 * permission would be an unused capability.
 */
const REQUIRED_PERMISSIONS = ['sidePanel', 'storage', 'tabs', 'alarms'];
const FORBIDDEN_PERMISSIONS = ['cookies', 'webRequest', 'debugger', 'management', 'proxy', 'declarativeNetRequest'];

/** Host access is two origins. Anything wider is a defect, not a configuration. */
function assertHostPermissions(hosts, apiOrigin) {
  const expected = new Set(['https://www.linkedin.com/*', `${apiOrigin}/*`]);
  const problems = [];
  for (const host of hosts) {
    if (host === '<all_urls>' || host === '*://*/*' || host === 'http://*/*' || host === 'https://*/*') {
      problems.push(`host_permissions contains a wildcard origin: ${host}`);
    } else if (!expected.has(host)) {
      problems.push(`host_permissions contains an unexpected origin: ${host}`);
    }
  }
  for (const want of expected) {
    if (!hosts.includes(want)) problems.push(`host_permissions is missing ${want}`);
  }
  return problems;
}

async function validateManifest(distDir, apiOrigin) {
  const manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8'));
  const problems = [];

  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  for (const permission of REQUIRED_PERMISSIONS) {
    if (!manifest.permissions.includes(permission)) problems.push(`missing required permission: ${permission}`);
  }
  for (const permission of manifest.permissions) {
    if (!REQUIRED_PERMISSIONS.includes(permission)) problems.push(`unexpected permission: ${permission}`);
    if (FORBIDDEN_PERMISSIONS.includes(permission)) problems.push(`forbidden permission: ${permission}`);
  }
  problems.push(...assertHostPermissions(manifest.host_permissions ?? [], apiOrigin));

  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (csp.includes('unsafe-eval')) problems.push('CSP allows unsafe-eval');
  if (csp.includes('unsafe-inline')) problems.push('CSP allows unsafe-inline');
  if (!csp.includes("script-src 'self'")) problems.push("CSP must restrict script-src to 'self'");

  if (manifest.side_panel?.default_path !== 'sidepanel.html') problems.push('side_panel.default_path must be sidepanel.html');
  if (manifest.background?.service_worker !== 'background.js') problems.push('service worker must be background.js');
  if (manifest.content_scripts?.length !== 1) problems.push('exactly one content script is expected');
  for (const entry of manifest.content_scripts ?? []) {
    for (const match of entry.matches ?? []) {
      if (!match.startsWith('https://www.linkedin.com/')) problems.push(`content script match is out of scope: ${match}`);
    }
  }
  if (manifest.externally_connectable !== undefined) problems.push('externally_connectable must not be set');
  if (manifest.content_scripts?.some((entry) => entry.all_frames === true)) problems.push('content script runs in all frames');

  return { manifest, problems };
}

/**
 * Credential patterns that must never appear in a shipped byte.
 *
 * Each pattern has the shape of a real credential rather than being a bare substring. A literal
 * `sk-` needle, for instance, matches the CSS property `mask-type` in the bundled stylesheet
 * helper, and a scan that cries wolf gets ignored — so these require the surrounding shape a
 * credential actually has.
 */
const SECRET_PATTERNS = [
  ['Supabase service role', /service_role/],
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{8,}/],
  ['service-role env var', /SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE/],
  ['database URL with credentials', /(?:postgres|postgresql):\/\/[^\s"'`]*:[^\s"'`@]+@/],
  ['OpenAI-style API key', /\bsk-[A-Za-z0-9]{20,}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['DeepSeek API key assignment', /deepseek[_-]?api[_-]?key\s*[:=]/i],
  ['Apollo API key assignment', /apollo[_-]?api[_-]?key\s*[:=]/i],
  ['MCP secret assignment', /MCP_(?:MASTER|SERVICE|SECRET)[A-Z_]*\s*[:=]/],
  ['Nexus session secret assignment', /NEXUS_SESSION_SECRET\s*[:=]\s*['"][^'"]+/],
  ['PEM private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Nexus API token literal', /\bnxu_[A-Za-z0-9_-]{20,}/],
  ['remote script tag', /<script[^>]+src=["']https?:\/\//i],
];

/** MV3 forbids these, and a minifier will emit the bare identifier almost anywhere. */
const DANGEROUS_CALLS = [
  ['eval()', /\beval\s*\(/],
  ['new Function()', /new\s+Function\s*\(/],
  ['WebAssembly compilation', /WebAssembly\.(?:compile|instantiate)/],
];

async function scanForSecrets(distDir) {
  const { readdir } = await import('node:fs/promises');
  const findings = [];
  const files = [];

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(distDir);

  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const [label, pattern] of [...SECRET_PATTERNS, ...DANGEROUS_CALLS]) {
      const match = pattern.exec(text);
      if (match !== null) {
        findings.push({ file: path.relative(distDir, file), label, evidence: match[0].slice(0, 80) });
      }
    }
  }
  return { findings, files };
}

/** Hashes every shipped file so the package is reproducible and auditable. */
async function hashDist(distDir) {
  const { readdir } = await import('node:fs/promises');
  const entries = [];
  for (const entry of await readdir(distDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const bytes = await readFile(path.join(distDir, entry.name));
    entries.push({ name: entry.name, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

const apiOrigin = process.env.NEXUS_API_ORIGIN ?? 'http://127.0.0.1:3000';
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');

// A production artefact must never be built against a loopback origin by accident, and a
// loopback origin must never be shipped as if it were production.
if (production) {
  const parsed = new URL(apiOrigin);
  if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
    throw new Error(
      `NEXUS_API_ORIGIN is ${apiOrigin}: refusing to build a production artefact against a loopback origin. ` +
        'Set NEXUS_API_ORIGIN to the deployed Nexus URL.',
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`NEXUS_API_ORIGIN must be https for a production build, got ${apiOrigin}`);
  }
}

const content = await readFile(path.join(root, 'src/content.ts'), 'utf8');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: {
    background: path.join(root, 'src/background.ts'),
    content: path.join(root, 'src/content.ts'),
    sidepanel: path.join(root, 'src/mount.tsx'),
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome114'],
  jsx: 'automatic',
  outdir,
  sourcemap: production ? false : 'inline',
  minify: production,
  legalComments: 'none',
  logLevel: 'warning',
  define: {
    __NEXUS_API_ORIGIN__: JSON.stringify(apiOrigin),
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
  },
  loader: { '.css': 'css' },
});

await cp(path.join(root, '..', '..', 'packages', 'ui', 'src', 'styles.css'), path.join(outdir, 'styles.css'));
await cp(path.join(root, 'static'), outdir, { recursive: true });
void content;

await writeFile(
  path.join(outdir, 'manifest.json'),
  `${JSON.stringify(manifestFor(apiOrigin), null, 2)}\n`,
  'utf8',
);

/** The manifest, built from the constants above rather than from a literal. */
function manifestFor(origin) {
  return {
    manifest_version: 3,
    name: 'Nexus Companion',
    version: '1.0.0',
    description: 'Find, capture and work Nexus leads without leaving LinkedIn.',
    minimum_chrome_version: '114',
    permissions: REQUIRED_PERMISSIONS,
    host_permissions: ['https://www.linkedin.com/*', `${origin}/*`],
    background: { service_worker: 'background.js', type: 'module' },
    side_panel: { default_path: 'sidepanel.html' },
    action: { default_title: 'Nexus Companion' },
    content_scripts: [
      {
        matches: ['https://www.linkedin.com/*'],
        js: ['content.js'],
        run_at: 'document_idle',
      },
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'",
    },
  };
}

const { problems } = await validateManifest(outdir, apiOrigin);
const { findings, files } = await scanForSecrets(outdir);
const hashes = await hashDist(outdir);

console.log(`built dist/ (API origin: ${apiOrigin}, ${production ? 'production' : 'development'})`);
console.log(`files: ${String(files.length)}`);
for (const entry of hashes) console.log(`  ${entry.name.padEnd(18)} ${String(entry.bytes).padStart(9)}  ${entry.sha256.slice(0, 16)}`);

if (findings.length > 0) {
  console.error('\nSECRET SCAN FAILED');
  for (const finding of findings) console.error(`  ${finding.file}: ${finding.label} (${finding.needle})`);
}
if (problems.length > 0) {
  console.error('\nMANIFEST VALIDATION FAILED');
  for (const problem of problems) console.error(`  ${problem}`);
}

if (findings.length > 0 || problems.length > 0) process.exit(1);
console.log('\nmanifest valid, no credentials in the bundle');
