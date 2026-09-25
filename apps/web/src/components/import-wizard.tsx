'use client';

/**
 * Admin Import Builder wizard (A20).
 *
 * Contract: "Business + Primary ICP/Auto-match, source input, preview, mapping,
 * validation, duplicate/profile counts, import."
 *
 * The wizard is four server round-trips, each one validated on the server:
 *
 *   parse   → split the pasted/file text into columns (writes nothing)
 *   preview → validate, normalize, dedupe and count (writes nothing)
 *   import  → write the batch, the rows, the leads and the evidence
 *
 * Everything rendered from pasted content is rendered as text through the UI kit —
 * never as markup — and nothing the operator pastes is executed. The preview is
 * produced by the same `@nexus/core` matcher the import itself runs, so it is not
 * an approximation, and the import step re-applies the rules server-side rather
 * than trusting what the browser posts back.
 */
import { useActionState, useState, type ChangeEvent, type ReactElement } from 'react';

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
  executeImportAction,
  parseImportAction,
  previewImportAction,
  type WizardState,
} from '@/app/b/[slug]/lead-sources/import/actions';
import type { RowPreview } from '@/lib/ingestion-view';

type MappingFieldName = 'name' | 'company' | 'jobTitle' | 'linkedinUrl' | 'location' | 'sourceUrl';

const EMPTY_MAPPING: Record<MappingFieldName, number> = {
  name: -1,
  company: -1,
  jobTitle: -1,
  linkedinUrl: -1,
  location: -1,
  sourceUrl: -1,
};

const INITIAL: WizardState = {
  ok: false,
  error: null,
  stage: 'setup',
  header: [],
  mapping: { ...EMPTY_MAPPING },
  sampleRows: [],
  rowCount: 0,
  preview: null,
  result: null,
};

const MAPPING_ROWS: readonly {
  readonly field: MappingFieldName;
  readonly label: string;
  readonly required: boolean;
}[] = [
  { field: 'name', label: 'Name', required: true },
  { field: 'company', label: 'Company', required: true },
  { field: 'jobTitle', label: 'Job title', required: true },
  { field: 'linkedinUrl', label: 'LinkedIn URL', required: false },
  { field: 'location', label: 'Location', required: false },
  { field: 'sourceUrl', label: 'Source URL', required: false },
];

export interface IcpOption {
  readonly value: string;
  readonly label: string;
}

export function ImportWizard({
  businessSlug,
  businessName,
  sourceType,
  defaultIcpId,
  icps,
}: {
  readonly businessSlug: string;
  readonly businessName: string;
  readonly sourceType: string;
  readonly defaultIcpId: string;
  readonly icps: readonly IcpOption[];
}): ReactElement {
  const [readState, readAction, readPending] = useActionState(parseImportAction, INITIAL);
  const [previewState, previewAction, previewPending] = useActionState(previewImportAction, INITIAL);
  const [execState, executeAction, execPending] = useActionState(executeImportAction, INITIAL);

  const [icpMode, setIcpMode] = useState<'primary' | 'auto_match'>('primary');
  const [icpId, setIcpId] = useState<string>(defaultIcpId);
  const [rawText, setRawText] = useState<string>('');
  const [fileNote, setFileNote] = useState<string | null>(null);

  const preview = previewState.preview;
  const result = execState.result;
  // The newest step that produced something wins; the earlier step's error stays
  // visible because "read columns" and "preview" are separate actions.
  const active = previewState.stage === 'setup' ? readState : previewState;
  const header = active.header;
  const rowCount = active.rowCount;
  const columnCount = header.length > 0 ? header.length : Math.max(active.sampleRows[0]?.length ?? 0, 1);

  const apollo = sourceType === 'apollo_basic';

  function onFilePicked(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      setFileNote(
        `${file.name} is a binary spreadsheet and this screen reads text only. Export it as CSV and choose that file instead.`,
      );
      return;
    }
    file
      .text()
      .then((text) => {
        setRawText(text);
        setFileNote(`${file.name} loaded — ${String(text.length)} characters. Map the columns next.`);
      })
      .catch(() => {
        setFileNote(`Could not read ${file.name}. Paste the rows instead.`);
      });
  }

  const setupHidden = (
    <>
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="sourceType" value={sourceType} />
      <input type="hidden" name="icpMode" value={icpMode} />
      {icpMode === 'primary' && <input type="hidden" name="icpId" value={icpId} />}
      {/*
        The textarea is uncontrolled-looking but its value is mirrored into React
        state, and this hidden field is what actually travels with the mapping and
        execute forms: both of those live in different <form> elements, so neither
        can read the textarea's own value.
      */}
      <input type="hidden" name="rawText" value={rawText} />
    </>
  );

  const previewColumns: readonly Column<RowPreview>[] = [
    { key: 'line', header: 'Row', numeric: true, cell: (row) => row.line },
    { key: 'name', header: 'Name', cell: (row) => <strong>{row.name}</strong> },
    { key: 'company', header: 'Company', cell: (row) => row.company },
    { key: 'title', header: 'Job title', cell: (row) => row.jobTitle },
    {
      key: 'dedupe',
      header: 'Dedupe result',
      cell: (row) => (
        <Row wrap>
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
            dataState={row.outcome}
          >
            {row.outcome === 'merge' ? 'updates existing person' : row.outcome}
          </Chip>
          {row.confidence !== null && <Chip>{`confidence ${row.confidence.toFixed(2)}`}</Chip>}
        </Row>
      ),
    },
    { key: 'why', header: 'Why', cell: (row) => <span className="nx-hint">{row.reason}</span> },
    {
      key: 'icp',
      header: 'Primary ICP',
      cell: (row) =>
        row.primaryIcpName === null ? (
          <span className="nx-hint">—</span>
        ) : (
          <Stack size="sm">
            <Chip accent="indigo">{row.primaryIcpName}</Chip>
            {row.primaryIcpReason !== null && <span className="nx-hint">{row.primaryIcpReason}</span>}
          </Stack>
        ),
    },
    {
      key: 'profile',
      header: 'Profile',
      cell: (row) =>
        row.needsProfile ? (
          <Chip accent="cyan" dataState="needs-profile">
            needs profile
          </Chip>
        ) : (
          <Chip accent="green" dataState="has-linkedin">
            LinkedIn key
          </Chip>
        ),
    },
  ];

  return (
    <Stack size="lg">
      <Card
        title="1 · Source mode"
        actions={
          <Row wrap>
            <Chip accent="indigo">{sourceType.replace(/_/g, ' ')}</Chip>
            {apollo && <EnrichmentOffChip />}
          </Row>
        }
      >
        <Stack size="sm">
          <span className="nx-hint">
            Importing into <strong>{businessName}</strong>. Every ingestion requires the Business plus either a
            Primary ICP or Auto-match, and runs normalization and dedupe before a lead is created.
          </span>
          {apollo && (
            <Alert accent="amber" title="Apollo basic discovery only">
              This accepts People Search results you have already copied: name, company, title and free metadata.
              Email and phone enrichment, paid exports and any credit-spending action are disabled, and this screen
              never spends credits.
            </Alert>
          )}
        </Stack>
      </Card>

      <Card title="2 · Primary ICP and source input">
        <form action={readAction}>
          {setupHidden}
          <Stack size="md">
            <Grid cols={2}>
              <Field label="Business" htmlFor="iw-business" hint="Fixed by the URL — the import is scoped to it.">
                <TextInput id="iw-business" name="businessDisplay" defaultValue={businessName} readOnly />
              </Field>
              <Field
                label="How is the Primary ICP decided?"
                htmlFor="iw-icp-mode"
                required
                hint="Required context for every ingestion path."
              >
                <Select
                  id="iw-icp-mode"
                  value={icpMode}
                  onChange={(value) => setIcpMode(value === 'auto_match' ? 'auto_match' : 'primary')}
                  options={[
                    { value: 'primary', label: 'I choose the Primary ICP' },
                    { value: 'auto_match', label: 'Auto-match against ICP criteria' },
                  ]}
                />
              </Field>
            </Grid>

            {icpMode === 'primary' && (
              <Field
                label="Primary ICP"
                htmlFor="iw-icp"
                required
                hint="Secondary ICP matches are recorded too and never create a second lead."
              >
                <Select
                  id="iw-icp"
                  value={icpId}
                  onChange={setIcpId}
                  required
                  placeholder="Select an ICP"
                  options={icps.map((icp) => ({ value: icp.value, label: icp.label }))}
                />
              </Field>
            )}

            <Field
              label="Read a CSV file"
              htmlFor="iw-file"
              hint="CSV text only. An XLSX file must be exported as CSV first — this screen does not parse binary spreadsheets."
            >
              <input id="iw-file" type="file" accept=".csv,.txt,text/csv" onChange={onFilePicked} />
            </Field>
            {fileNote !== null && <Alert accent="amber">{fileNote}</Alert>}

            <Field
              label="Rows"
              htmlFor="iw-rows"
              required
              hint="One record per line. Required columns: name, company, job title. Optional: LinkedIn URL, location, source URL."
            >
              <TextArea
                id="iw-rows"
                tall
                mono
                value={rawText}
                onChange={setRawText}
                rows={12}
                placeholder={'name,company,job title,linkedin url\nJane Doe,Northwind Ltd,Head of Ops,https://www.linkedin.com/in/janedoe'}
              />
            </Field>

            {readState.error !== null && (
              <Alert accent="red" role="alert">
                {readState.error}
              </Alert>
            )}

            <Row>
              <Button type="submit" variant="secondary" busy={readPending}>
                Read columns
              </Button>
            </Row>
          </Stack>
        </form>
      </Card>

      {rowCount > 0 && (
        <Card
          title="3 · Preview: mapping, validation and duplicates"
          actions={
            <Row wrap>
              <Chip accent="indigo">{rowCount} rows read</Chip>
              <Chip>{header.length > 0 ? `${header.length} detected columns` : 'no header row detected'}</Chip>
            </Row>
          }
        >
          <form action={previewAction}>
            {setupHidden}
            <Stack size="md">
              <span className="nx-hint">
                {header.length > 0
                  ? 'Columns were detected from the header. Confirm which column supplies each field — nothing is written yet.'
                  : 'No header row was found, so columns are numbered left to right. Map at least name, company and job title.'}
              </span>

              <Grid cols={2}>
                {MAPPING_ROWS.map((entry) => (
                  <Field
                    key={entry.field}
                    label={entry.label}
                    htmlFor={`iw-map-${entry.field}`}
                    required={entry.required}
                    hint={entry.required ? 'Required column' : 'Optional column'}
                  >
                    <Select
                      id={`iw-map-${entry.field}`}
                      name={`map.${entry.field}`}
                      defaultValue={String(active.mapping[entry.field] ?? -1)}
                      options={[
                        { value: '-1', label: '— not mapped —' },
                        ...Array.from({ length: columnCount }, (_, index) => ({
                          value: String(index),
                          label:
                            header[index] === undefined || header[index] === ''
                              ? `Column ${String(index + 1)}`
                              : `Column ${String(index + 1)} · ${header[index] ?? ''}`,
                        })),
                      ]}
                    />
                  </Field>
                ))}
              </Grid>

              {active.sampleRows.length > 0 && (
                <Stack size="sm">
                  <span className="nx-hint">First rows exactly as read (plain text, never interpreted):</span>
                  <div className="nx-input nx-input--readonly">
                    {active.sampleRows
                      .map((cells) => cells.map((cell) => cell.slice(0, 160)).join(' | '))
                      .join('\n')}
                  </div>
                </Stack>
              )}

              {previewState.error !== null && (
                <Alert accent="red" role="alert">
                  {previewState.error}
                </Alert>
              )}

              <Row>
                <Button type="submit" variant="primary" busy={previewPending}>
                  Preview validation and duplicates
                </Button>
              </Row>
            </Stack>
          </form>
        </Card>
      )}

      {preview !== null && (
        <Card
          title="4 · Preview result"
          actions={
            <Row wrap>
              <Chip accent="indigo">{preview.requestedIcpName ?? 'Auto-match'}</Chip>
              <Chip>{preview.sourceType.replace(/_/g, ' ')}</Chip>
            </Row>
          }
        >
          <Stack size="md">
            <Grid cols={4}>
              <Stat value={preview.totalRows} label="Rows read" />
              <Stat value={preview.createCount} label="New leads" meta="no existing match" />
              <Stat value={preview.mergeCount} label="Existing people" meta="lead updated, not duplicated" />
              <Stat value={preview.reviewCount} label="Possible duplicates" meta="queued for Duplicate Review" />
            </Grid>
            <Grid cols={4}>
              <Stat value={preview.needsProfileCount} label="Needs profile" meta="queued for capture" />
              <Stat value={preview.failedCount} label="Failed validation" meta="nothing written for these" />
              <Stat value={preview.validRows} label="Valid rows" meta="will be written" />
              <Stat value={preview.validRows + preview.failedCount} label="Rows accounted for" />
            </Grid>

            <Alert accent="amber" title="How a duplicate is handled">
              A row matching an existing person by LinkedIn URL, email, or name plus company domain is merged onto
              that person&apos;s lead — the person is never created twice. A weaker match still creates the lead but is
              queued in Duplicate Review with its match reason and confidence, so a truly different person can be kept
              separate and a real duplicate merged.
            </Alert>

            <DataTable
              columns={previewColumns}
              rows={preview.rows}
              rowKey={(row) => String(row.line)}
              caption="Per-row validation, dedupe and ICP outcome"
              empty={<span className="nx-hint">No rows to preview.</span>}
            />

            <Row wrap>
              <span className="nx-hint nx-table__mono">idempotency {preview.idempotencyKey.slice(0, 24)}…</span>
              <span className="nx-hint nx-table__mono">payload hash {preview.payloadHash.slice(0, 24)}…</span>
            </Row>

            <form action={executeAction}>
              {setupHidden}
              <input type="hidden" name="payload" value={preview.payload} />
              <Stack size="sm">
                {execState.error !== null && (
                  <Alert accent="red" role="alert">
                    {execState.error}
                  </Alert>
                )}
                <Button type="submit" variant="primary" busy={execPending} disabled={preview.validRows === 0}>
                  Import {preview.validRows} row{preview.validRows === 1 ? '' : 's'}
                </Button>
                <span className="nx-hint">
                  Valid rows are written with an import batch that can be undone from the Lead Sources hub. Failed rows
                  are recorded with their reason and write nothing.
                </span>
              </Stack>
            </form>
          </Stack>
        </Card>
      )}

      {result !== null && (
        <Card title="Import complete" actions={<Chip accent="green">completed</Chip>}>
          <Stack size="md">
            <Grid cols={4}>
              <Stat value={result.created} label="Leads created" />
              <Stat value={result.updated} label="Leads updated" />
              <Stat value={result.duplicate} label="Sent to review" />
              <Stat value={result.needsProfile} label="Needs profile" />
            </Grid>
            <Grid cols={2}>
              <Stat value={result.failed} label="Failed" meta="reason recorded per row" />
              <Stat value={result.skipped} label="Skipped" meta="for example a soft-deleted lead" />
            </Grid>
            <Row wrap>
              <a className="nx-btn nx-btn--primary" href={`/b/${businessSlug}/leads`}>
                Open leads
              </a>
              <a className="nx-btn nx-btn--secondary" href={`/b/${businessSlug}/profile-queue`}>
                Profile Queue
              </a>
              <a className="nx-btn nx-btn--secondary" href={`/b/${businessSlug}/duplicates`}>
                Duplicate Review
              </a>
              <a className="nx-btn nx-btn--secondary" href={`/b/${businessSlug}/lead-sources`}>
                Lead Sources
              </a>
            </Row>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
