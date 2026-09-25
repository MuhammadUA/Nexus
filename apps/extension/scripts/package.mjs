/**
 * Packages the built extension as a distributable ZIP.
 *
 * The archive contains the extension **root** — `manifest.json` at the top level, not inside a
 * folder — because that is what both consumers need:
 *
 *   * `chrome://extensions` → Developer mode → *Load unpacked* expects the directory that holds
 *     `manifest.json`, so the ZIP is extracted and that directory is selected;
 *   * Chrome Web Store submission uploads a ZIP whose root holds the manifest. A nested folder makes
 *     the upload fail validation with "Manifest file is missing or unreadable".
 *
 * Zip is written by hand rather than with a dependency: the format for a handful of small files is a
 * local header per entry plus a central directory, and a build that can produce its own artefact has
 * one less supply-chain surface. Compression is deflate via `node:zlib`, using the raw variant the
 * format requires.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const outFile = process.argv[2] ?? path.join(root, 'dist', 'nexus-companion.zip');

/** CRC-32, the checksum every ZIP entry carries. Table computed once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** DOS date/time, which is what a ZIP header stores. */
function dosDateTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

const entries = [];
const names = (await readdir(distDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();

// The archive must not contain itself.
const archiveName = path.basename(outFile);
if (names.includes(archiveName)) {
  throw new Error(`refusing to package ${archiveName} into itself`);
}

const now = new Date();
for (const name of names) {
  const content = await readFile(path.join(distDir, name));
  const compressed = deflateRawSync(content, { level: 9 });
  // Stored rather than deflated when compression does not help, which is the conventional choice.
  const useDeflate = compressed.length < content.length;
  entries.push({
    name,
    content,
    data: useDeflate ? compressed : content,
    method: useDeflate ? 8 : 0,
    crc: crc32(content),
  });
}

const localParts = [];
const centralParts = [];
let offset = 0;
const { time, day } = dosDateTime(now);

for (const entry of entries) {
  const nameBytes = Buffer.from(entry.name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
  local.writeUInt16LE(entry.method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(entry.crc, 14);
  local.writeUInt32LE(entry.data.length, 18);
  local.writeUInt32LE(entry.content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28); // extra field length

  localParts.push(local, nameBytes, entry.data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory signature
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(entry.method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(day, 14);
  central.writeUInt32LE(entry.crc, 16);
  central.writeUInt32LE(entry.data.length, 20);
  central.writeUInt32LE(entry.content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk number
  central.writeUInt16LE(0, 36); // internal attributes
  central.writeUInt32LE(0, 38); // external attributes
  central.writeUInt32LE(offset, 42);

  centralParts.push(central, nameBytes);
  offset += local.length + nameBytes.length + entry.data.length;
}

const centralDirectory = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); // end of central directory
end.writeUInt16LE(0, 4); // this disk
end.writeUInt16LE(0, 6); // disk with central directory
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralDirectory.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20); // comment length

await mkdir(path.dirname(outFile), { recursive: true });
const archive = Buffer.concat([...localParts, centralDirectory, end]);
await writeFile(outFile, archive);

// The manifest must be at the root of the archive for both consumers.
const manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8'));
if (!names.includes('manifest.json')) throw new Error('dist/ has no manifest.json to package');

console.log(`packaged ${String(entries.length)} files, ${String(archive.length)} bytes`);
for (const entry of entries) {
  console.log(`  ${entry.name.padEnd(18)} ${String(entry.content.length).padStart(9)} -> ${String(entry.data.length).padStart(9)}`);
}
console.log(`sha256 ${createHash('sha256').update(archive).digest('hex')}`);
console.log(`\n${outFile}`);
console.log(`manifest v${String(manifest.manifest_version)} "${manifest.name}" ${manifest.version} — manifest.json is at the archive root`);
