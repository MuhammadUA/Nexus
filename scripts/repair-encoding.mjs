/**
 * Repair double-encoded UTF-8 in this repository's text files.
 *
 * What happened: text that was already UTF-8 (an em dash "—" = E2 80 94) was decoded as Windows-1252
 * somewhere in the toolchain and re-encoded as UTF-8. Each original byte became one character, so the
 * three bytes of "—" became "—" and that was stored. The result is valid UTF-8 that renders as
 * garbage — the character corruption the implementation audit recorded as NX-007.
 *
 * The repair reverses exactly that: decode the file as UTF-8 to get the characters, re-encode each
 * character through Windows-1252 to recover the original bytes, then decode those bytes as UTF-8. The
 * round trip is only applied to a run that *is* recoverable; a run that does not decode as UTF-8 is
 * left byte-for-byte alone, which is what makes this safe to run over prose, comments and code
 * alike — a legitimate "€" in a source string is already valid UTF-8 and is not part of a run that
 * round-trips.
 *
 * Usage:
 *   node scripts/repair-encoding.mjs          # report only
 *   node scripts/repair-encoding.mjs --write  # apply
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = process.cwd();
const WRITE = process.argv.includes('--write');

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sql', '.md', '.json', '.css', '.html', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.data', '.turbo', 'coverage', 'test-results', 'playwright-report']);

/** Windows-1252 is not Latin-1 in the 0x80–0x9F range; these are the 27 bytes that differ. */
const CP1252_HIGH = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
  [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
  [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
  [0x9e, 0x017e], [0x9f, 0x0178],
]);

/** The byte a character came from, or -1 when it could not have come from a single byte. */
function toByte(codePoint) {
  if (codePoint <= 0xff) return codePoint;
  for (const [byte, cp] of CP1252_HIGH) if (cp === codePoint) return byte;
  return -1;
}

/** The inverse: the character Windows-1252 assigns to a byte. */
function fromByte(byte) {
  if (byte >= 0x80 && byte <= 0x9f) return String.fromCodePoint(CP1252_HIGH.get(byte) ?? byte);
  return String.fromCodePoint(byte);
}

/**
 * Reverses one maximal run of characters that all came from single bytes and whose original bytes are
 * valid UTF-8. Returns null when the run is not recoverable, so the caller leaves it alone.
 */
function repairRun(run) {
  const bytes = [];
  for (const character of run) {
    const byte = toByte(character.codePointAt(0));
    if (byte < 0) return null;
    bytes.push(byte);
  }

  const decoded = Buffer.from(bytes).toString('utf8');
  // A U+FFFD means the bytes were not valid UTF-8, so this was not double-encoded text.
  if (decoded.includes('\uFFFD')) return null;
  // No change means the run was already correct.
  if (decoded === run) return null;
  return decoded;
}

/** Splits text into alternating runs of "byte-like" characters and everything else. */
function repairText(text) {
  let output = '';
  let run = '';
  let changed = false;

  const flush = () => {
    if (run.length === 0) return;
    const repaired = repairRun(run);
    if (repaired === null) output += run;
    else {
      output += repaired;
      changed = true;
    }
    run = '';
  };

  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint >= 0x80 && toByte(codePoint) >= 0) run += character;
    else {
      flush();
      output += character;
    }
  }
  flush();

  return changed ? output : null;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) {
      yield join(dir, entry.name);
    }
  }
}

let scanned = 0;
let repaired = 0;
const samples = [];

for (const file of walk(ROOT)) {
  scanned += 1;
  const raw = readFileSync(file);
  // Skip anything that is not valid UTF-8; it is not covered by this repair.
  const original = raw.toString('utf8');
  if (original.includes('\uFFFD')) continue;

  // Repeated until it stops changing. Some text was mis-decoded more than once — an em dash that
  // survived two bad round trips is 'ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â' — and one pass only peels off the outer layer.
  // The loop is bounded so a pathological file cannot spin, and `repairText` returns null once a pass
  // finds nothing recoverable.
  let text = original;
  for (let pass = 0; pass < 4; pass += 1) {
    const fixed = repairText(text);
    if (fixed === null) break;
    text = fixed;
  }
  if (text === original) continue;

  repaired += 1;
  const path = relative(ROOT, file);
  if (samples.length < 12) {
    const firstChanged = [...original].findIndex((c, index) => text[index] !== c);
    samples.push(`${path}: ...${text.slice(Math.max(0, firstChanged - 30), firstChanged + 30).replace(/\n/g, ' ')}...`);
  }

  if (WRITE) writeFileSync(file, text, 'utf8');
}

console.log(`${WRITE ? 'Repaired' : 'Would repair'} ${repaired} of ${scanned} scanned files.`);
for (const sample of samples) console.log(`  ${sample}`);
if (!WRITE && repaired > 0) console.log('\nDry run. Re-run with --write to apply.');
