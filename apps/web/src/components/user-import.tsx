'use client';

import { useActionState, useRef, useState, type ChangeEvent, type ReactElement } from 'react';

import {
  Alert,
  Button,
  Card,
  Chip,
  DataTable,
  EnrichmentOffChip,
  Field,
  Grid,
  Row,
  Select,
  Stack,
  Stat,
  TextArea,
  TextInput,
  type Column,
} from '@nexus/ui';

import {
  executeUserImportAction,
  previewUserImportAction,
  type ImportRowView,
} from '@/app/(app)/my-lead-sources/actions';

/**
 * The preview row shape is owned by the server action module and imported as a type above,
 * so the table cannot drift from what the action actually returns.
 */

interface ImportCounts {
  readonly total: number;
  readonly valid: number;
  readonly create: number;
  readonly merge: number;
  readonly review: number;
  readonly needsProfile: number;
  readonly failed: number;
  readonly created: number;
  readonly updated: number;
  readonly duplicate: number;
  readonly batchId: string | null;
}

interface ImportActionResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly stage: 'input' | 'previewed' | 'executed';
  readonly headers: readonly string[];
  readonly mapping: Readonly<Record<string, number>>;
  readonly rows: readonly ImportRowView[];
  readonly requestedIcpName: string | null;
  readonly autoMatch: boolean;
  readonly counts: ImportCounts | null;
}

const INITIAL: ImportActionResult = {
  ok: false,
  error: null,
  stage: 'input',
  headers: [],
  mapping: {},
  rows: [],
  requestedIcpName: null,
  autoMatch: true,
  counts: null,
};

export interface ImportOption {
  readonly value: string;
  readonly label: string;
}

export interface ImportBusinessOption extends ImportOption {
  readonly name: string;
}

export type UserImportMode = 'file' | 'paste' | 'google' | 'apollo';

/**
 * U11–U15 — the user ingestion wizard.
 *
 * Contract (U12): "CSV/XLSX upload with business + ICP tagging/auto-match, preview,
 * duplicate counts."
 * Contract (U13): "Paste rows/table; map name/company/title/optional LinkedIn URL;
 * business + ICP."
 * Contract (U14): "Enter Google search URL, collect candidate rows, create partial leads,
 * send missing profiles to queue."
 * Contract (U15): "Basic/zero-credit people search only by default; name/company/title;
 * enrichment OFF."
 *
 * The component is a thin shell: it collects text, shows the preview the *server* pipeline
 * produced, and submits. Validation, normalization, dedupe and ICP assignment all happen
 * in `lib/repo/ingestion.ts`, so this screen cannot disagree with the admin builder.
 *
 * All pasted and scraped content is untrusted: it is rendered as text (React escapes it)
 * and never as markup, and it is never executed.
 */
export function UserImportWizard({
  mode,
  businesses,
  icps,
  canImport,
  defaultBusinessId,
}: {
  readonly mode: UserImportMode;
  readonly businesses: readonly ImportBusinessOption[];
  readonly icps: readonly ImportOption[];
  readonly canImport: boolean;
  readonly defaultBusinessId: string;
}): ReactElement {
  const [preview, previewAction, previewPending] = useActionState(previewUserImportAction, INITIAL);
  const [execution, executeAction, executePending] = useActionState(executeUserImportAction, INITIAL);
  const [rawText, setRawText] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const sourceType =
    mode === 'file'
      ? 'file_csv'
      : mode === 'paste'
        ? 'paste_list'
        : mode === 'google'
          ? 'google_search'
          : 'apollo_basic';

  const mappingField = Object.entries(preview.mapping)
    .filter(([, index]) => index >= 0)
    .map(([field, index]) => `${field}:${String(index)}`)
    .join(',');

  const acceptsFile = mode === 'file';

  /**
   * Reads an upload in the browser.
   *
   * CSV goes through as text. XLSX is converted to tab-separated text in the browser so
   * the shared server parser stays the single implementation of "text → rows"; a workbook
   * is a ZIP of XML, so the conversion is a small reader rather than a new dependency.
   */
  async function handleFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    setFileError(null);
    if (file.size > 4_000_000) {
      setRawText('');
      setFileError('That file is larger than 4 MB. Split it into smaller imports.');
      return;
    }
    try {
      const isXlsx = /\.xlsx$/i.test(file.name);
      if (!isXlsx) {
        setRawText(await file.text());
        return;
      }
      const buffer = new Uint8Array(await file.arrayBuffer());
      const text = await xlsxToText(buffer);
      if (text === null) {
        setRawText('');
        setFileError('That XLSX workbook could not be read. Save the first sheet as CSV and upload that instead.');
        return;
      }
      setRawText(text);
    } catch {
      setRawText('');
      setFileError('That file could not be read in this browser. Save it as CSV and upload that instead.');
    }
  }

  function clearInput(): void {
    setRawText('');
    setFileError(null);
    if (fileInput.current !== null) fileInput.current.value = '';
  }

  const columns: readonly Column<ImportRowView>[] = [
    { key: 'line', header: '#', numeric: true, cell: (row) => row.line },
    {
      key: 'name',
      header: 'Name',
      cell: (row) => (
        <Stack size="sm">
          <span>{row.name}</span>
          {row.linkedinUrl !== null && <span className="nx-hint">{row.linkedinUrl}</span>}
        </Stack>
      ),
    },
    { key: 'company', header: 'Company', cell: (row) => row.company },
    { key: 'title', header: 'Job title', cell: (row) => row.jobTitle },
    {
      key: 'outcome',
      header: 'Outcome',
      cell: (row) => (
        <Chip
          accent={
            row.outcome === 'create'
              ? 'green'
              : row.outcome === 'merge'
                ? 'cyan'
                : row.outcome === 'review'
                  ? 'amber'
                  : 'red'
          }
        >
          {row.outcome}
        </Chip>
      ),
    },
    { key: 'icp', header: 'Primary ICP', cell: (row) => row.primaryIcpName ?? <span className="nx-hint">—</span> },
    {
      key: 'profile',
      header: 'Profile',
      cell: (row) => (row.needsProfile ? <Chip accent="cyan">needs profile</Chip> : <span className="nx-hint">complete</span>),
    },
    {
      key: 'reason',
      header: 'Why',
      cell: (row) => (
        <Stack size="sm">
          <span className="nx-hint">{row.reason}</span>
          {row.confidence != null && <span className="nx-hint">confidence {row.confidence.toFixed(2)}</span>}
        </Stack>
      ),
    },
  ];

  return (
    <Stack>
      {!canImport && (
        <Alert accent="amber" title="Read-only" role="alert">
          Your access does not include using lead sources, so the import will be refused. Ask an administrator for
          the lead-source permission.
        </Alert>
      )}

      <Card
        title="Import setup"
        actions={
          <Row wrap>
            <Chip accent="indigo">{sourceType}</Chip>
            {mode === 'apollo' && <EnrichmentOffChip />}
          </Row>
        }
      >
        <form action={previewAction}>
          <input type="hidden" name="sourceType" value={sourceType} />
          <Stack>
            <Grid cols={2}>
              <Field
                label="Business"
                htmlFor="import-business"
                required
                hint="Every ingestion is scoped to one business."
              >
                <Select
                  id="import-business"
                  name="businessId"
                  defaultValue={defaultBusinessId}
                  required
                  options={businesses.map((business) => ({ value: business.value, label: business.label }))}
                />
              </Field>
              <Field
                label="Primary ICP"
                htmlFor="import-icp"
                hint="spec: Business + Primary ICP OR Auto-match is required for every ingestion."
              >
                <Select
                  id="import-icp"
                  name="icpId"
                  defaultValue=""
                  placeholder="Auto-match"
                  options={icps.map((icp) => ({ value: icp.value, label: icp.label }))}
                />
              </Field>
            </Grid>

            <Field
              label="ICP mode"
              htmlFor="import-icp-mode"
              hint="Auto-match scores each row against this business's ICPs and records secondary matches without creating extra leads."
            >
              <Select
                id="import-icp-mode"
                name="icpMode"
                defaultValue="auto_match"
                options={[
                  { value: 'auto_match', label: 'Auto-match' },
                  { value: 'primary', label: 'Use the Primary ICP above' },
                ]}
              />
            </Field>

            {(mode === 'google' || mode === 'apollo') && (
              <Field
                label={mode === 'google' ? 'Google search results URL' : 'Apollo search context URL'}
                htmlFor="import-source-url"
                hint="Recorded as the provenance of every row in this batch."
              >
                <TextInput
                  id="import-source-url"
                  name="sourceUrl"
                  defaultValue=""
                  type="url"
                  placeholder={mode === 'google' ? 'https://www.google.com/search?q=…' : 'https://app.apollo.io/…'}
                />
              </Field>
            )}

            {acceptsFile && (
              <Field
                label="CSV or XLSX file"
                htmlFor="import-file"
                hint="Minimum columns: name, company, job title. Optional: LinkedIn URL, location, source URL. The file is read in your browser; nothing is uploaded until you preview it."
              >
                <input
                  id="import-file"
                  ref={fileInput}
                  className="nx-input"
                  type="file"
                  accept=".csv,.xlsx,text/csv"
                  onChange={(event) => {
                    void handleFile(event);
                  }}
                />
              </Field>
            )}

            {fileError !== null && (
              <Alert accent="amber" role="alert">
                {fileError}
              </Alert>
            )}

            <Field
              label={mode === 'paste' ? 'Paste rows' : 'Rows'}
              htmlFor="import-text"
              required={!acceptsFile}
              hint={
                mode === 'paste'
                  ? 'Paste a table or rows. Column order name, company, job title, LinkedIn URL works with or without a header row.'
                  : 'Candidate rows collected from the search results. Paste as text; it is stored as text and never executed.'
              }
            >
              {/* The row text is the one input this screen has to own in React state,
                  because a browser cannot read an XLSX without conversion. It is echoed
                  back through `value` so what is submitted is exactly what is shown. */}
              <TextArea
                id="import-text"
                name="rawText"
                value={rawText}
                onChange={setRawText}
                rows={8}
                tall
                mono
                placeholder={'name,company,job title,linkedin url\nJane Doe,Acme,Head of Growth,https://www.linkedin.com/in/janedoe'}
              />
            </Field>

            {preview.error !== null && (
              <Alert accent="red" role="alert">
                {preview.error}
              </Alert>
            )}

            <Row wrap>
              <Button type="submit" variant="primary" busy={previewPending}>
                Preview import
              </Button>
              {rawText.length > 0 && (
                <Button type="button" variant="ghost" onClick={clearInput}>
                  Clear
                </Button>
              )}
              <span className="nx-hint">Nothing is written until you confirm the preview.</span>
            </Row>
          </Stack>
        </form>
      </Card>

      {preview.stage === 'previewed' && preview.counts !== null && (
        <Card
          title="Preview"
          actions={
            <Row wrap>
              <Chip accent={preview.autoMatch ? 'cyan' : 'indigo'}>
                {preview.requestedIcpName ?? 'Auto-match'}
              </Chip>
              <Chip>{preview.counts.total} rows</Chip>
            </Row>
          }
        >
          <Stack>
            <Grid cols={4}>
              <Stat value={preview.counts.create} label="New leads" meta="no existing match" />
              <Stat value={preview.counts.merge} label="Updated" meta="matched an existing person" />
              <Stat value={preview.counts.review} label="Duplicate review" meta="weak match, needs a decision" />
              <Stat value={preview.counts.needsProfile} label="Needs profile" meta="sent to the Profile Queue" />
            </Grid>

            {preview.counts.failed > 0 && (
              <Alert accent="amber" title="Some rows failed validation">
                {preview.counts.failed} row(s) will be recorded as failed and skipped. They are listed below with the
                reason.
              </Alert>
            )}

            <DataTable
              columns={columns}
              rows={preview.rows}
              rowKey={(row) => String(row.line)}
              caption="Row-by-row outcome of this import"
              empty={<span className="nx-hint">No usable rows.</span>}
            />

            <form action={executeAction}>
              <input type="hidden" name="businessId" value={defaultBusinessId} />
              <input type="hidden" name="sourceType" value={sourceType} />
              <input type="hidden" name="icpMode" value={preview.autoMatch ? 'auto_match' : 'primary'} />
              <input type="hidden" name="rawText" value={rawText} />
              <input type="hidden" name="mapping" value={mappingField} />
              <Stack size="sm">
                {execution.error !== null && (
                  <Alert accent="red" role="alert">
                    {execution.error}
                  </Alert>
                )}
                <Button type="submit" variant="primary" busy={executePending}>
                  Import {preview.counts.valid} row{preview.counts.valid === 1 ? '' : 's'}
                </Button>
              </Stack>
            </form>
          </Stack>
        </Card>
      )}

      {execution.stage === 'executed' && execution.counts !== null && (
        <Card title="Import complete" actions={<Chip accent="green">written</Chip>}>
          <Stack>
            <Grid cols={4}>
              <Stat value={execution.counts.created} label="Leads created" />
              <Stat value={execution.counts.updated} label="Leads updated" />
              <Stat value={execution.counts.duplicate} label="Sent to Duplicate Review" />
              <Stat value={execution.counts.needsProfile} label="Sent to Profile Queue" />
            </Grid>
            <Row wrap>
              <a className="nx-btn nx-btn--secondary" href="/my-leads">
                Open My Leads
              </a>
              <a className="nx-btn nx-btn--secondary" href="/my-profile-queue">
                Open Profile Queue
              </a>
              <a className="nx-btn nx-btn--secondary" href="/my-duplicates">
                Open Duplicate Review
              </a>
            </Row>
            {execution.counts.failed > 0 && (
              <span className="nx-hint">
                {execution.counts.failed} row(s) failed and were recorded in the batch ledger with their reason.
              </span>
            )}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

/* ------------------------------------------------------------ XLSX in-page -- */

/**
 * Converts the first worksheet of an XLSX upload to tab-separated text.
 *
 * Kept in the client component because it is purely a file-format concern: the server only
 * ever receives text, and the shared parser stays the one implementation of "text → rows".
 * Returns `null` when the file is not a readable workbook, so the operator is told rather
 * than getting a half-imported file.
 */
async function xlsxToText(data: Uint8Array): Promise<string | null> {
  const files = await readZip(data);
  if (files === null) return null;

  const shared = extractStrings(decode(files.get('xl/sharedStrings.xml')));
  const sheetName = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d*\.xml$/.test(name))
    .sort()[0];
  if (sheetName === undefined) return null;
  const sheet = decode(files.get(sheetName));
  if (sheet === null) return null;

  const lines: string[] = [];
  const rowPattern = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(sheet)) !== null) {
    const cells: string[] = [];
    const cellPattern = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(rowMatch[1] ?? '')) !== null) {
      const attributes = cellMatch[1] ?? cellMatch[2] ?? '';
      const body = cellMatch[3] ?? '';
      const reference = /r="([A-Z]+)\d+"/.exec(attributes)?.[1];
      const position = reference === undefined ? cells.length : columnIndex(reference);
      const type = /t="([^"]+)"/.exec(attributes)?.[1] ?? 'n';
      let value = '';
      if (type === 'inlineStr') value = collectText(body);
      else if (type === 's') value = shared[Number(collectText(body))] ?? '';
      else value = collectText(body);
      while (cells.length < position) cells.push('');
      cells[position] = value.replace(/[\t\r\n]+/g, ' ');
    }
    if (cells.some((cell) => cell.length > 0)) lines.push(cells.join('\t'));
  }
  return lines.length === 0 ? null : lines.join('\n');
}

function columnIndex(reference: string): number {
  let value = 0;
  for (const char of reference) value = value * 26 + (char.charCodeAt(0) - 64);
  return value - 1;
}

function decode(bytes: Uint8Array | undefined): string | null {
  if (bytes === undefined) return null;
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

function collectText(xml: string): string {
  let out = '';
  const pattern = /<t\b[^>]*>([\s\S]*?)<\/t>|<v\b[^>]*>([\s\S]*?)<\/v>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) out += decodeEntities(match[1] ?? match[2] ?? '');
  return out;
}

function extractStrings(xml: string | null): readonly string[] {
  if (xml === null) return [];
  const strings: string[] = [];
  const pattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) strings.push(collectText(match[1] ?? ''));
  return strings;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

/**
 * Declared inline rather than imported: `DecompressionStream` is a browser API and this
 * keeps the build free of any Node-only module on the client.
 *
 * The `Uint8Array<ArrayBuffer>` annotations are load-bearing. TypeScript widens a bare
 * `Uint8Array` to `Uint8Array<ArrayBufferLike>`, which is *not* assignable to the
 * `BufferSource` the stream writer and reader accept, because `ArrayBufferLike` could be
 * a `SharedArrayBuffer`. Naming `ArrayBuffer` states what is actually true here.
 */
async function inflateRaw(payload: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  // Copied into a fresh ArrayBuffer-backed view: a subarray of a larger buffer is not a
  // `BufferSource` the stream writer accepts.
  const chunk = new Uint8Array(payload.byteLength);
  chunk.set(payload);
  void writer.write(chunk);
  void writer.close();
  const parts: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    parts.push(read.value);
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function readZip(data: Uint8Array): Promise<Map<string, Uint8Array> | null> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  const minimum = Math.max(0, data.byteLength - 66_000);
  for (let offset = data.byteLength - 22; offset >= minimum; offset -= 1) {
    if (offset >= 0 && view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) return Promise.resolve(null);

  const total = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const entries: { name: string; compression: number; payload: Uint8Array }[] = [];

  for (let entry = 0; entry < total; entry += 1) {
    if (pointer + 46 > data.byteLength || view.getUint32(pointer, true) !== 0x02014b50) break;
    const compression = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = new TextDecoder('utf-8').decode(
      data.subarray(pointer + 46, pointer + 46 + nameLength),
    );
    pointer += 46 + nameLength + extraLength + commentLength;

    if (localOffset + 30 > data.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const end = Math.min(start + compressedSize, data.byteLength);
    const payload = data.subarray(start, end);
    if (payload.byteLength === 0) continue;
    entries.push({ name, compression, payload });
  }

  return (async (): Promise<Map<string, Uint8Array>> => {
    const files = new Map<string, Uint8Array>();
    for (const entry of entries) {
      if (entry.compression === 0) {
        files.set(entry.name, entry.payload);
        continue;
      }
      if (entry.compression !== 8) continue;
      try {
        files.set(entry.name, await inflateRaw(entry.payload));
      } catch {
        // A single unreadable part must not fail the whole workbook: the caller then
        // reports that the sheet could not be read.
      }
    }
    return files;
  })();
}
