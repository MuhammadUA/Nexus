/**
 * Import Builder view model: the shapes and pure helpers shared by the server
 * repositories and the `'use client'` wizard.
 *
 * This module is deliberately **not** `server-only`. Everything in
 * `lib/repo/*` imports `server-only`, so a client component may not import from
 * there even for a type; the pieces the wizard needs therefore live here, and
 * `lib/repo/ingestion.ts` re-exports them so there is still exactly one
 * definition of each.
 *
 * Nothing here touches the database, the filesystem or the session. The parsing
 * helpers are pure functions over text the operator pasted, which is treated as
 * data: it is split, trimmed and bounded, never executed and never interpreted as
 * markup.
 */
import type { IcpSelection, LeadSourceType } from '@nexus/core';

/* ------------------------------------------------------------------ types -- */

/** `import_batches.source` — the database check constraint's exact value set. */
export const IMPORT_BATCH_SOURCES = [
  'file_csv',
  'file_xlsx',
  'paste_list',
  'google_search',
  'apollo_basic',
  'external_ingest',
] as const;
export type ImportBatchSource = (typeof IMPORT_BATCH_SOURCES)[number];

/** One source row, already mapped to the fields every ingestion path needs. */
export interface RawRow {
  /** 1-based source line, so a validation error points at the pasted text. */
  readonly line: number;
  readonly name: string;
  readonly company: string;
  readonly jobTitle: string;
  readonly linkedinUrl: string;
  readonly location: string;
  readonly sourceUrl: string;
}

export type MappingField = keyof Omit<RawRow, 'line'>;

export const MAPPING_FIELDS: readonly MappingField[] = [
  'name',
  'company',
  'jobTitle',
  'linkedinUrl',
  'location',
  'sourceUrl',
];

export interface MappingSummary {
  readonly icpId: string;
  readonly icpName: string;
  readonly reason: string;
  readonly secondaryIcpIds: readonly string[];
  readonly needsReview: boolean;
}

export interface PlannedRow {
  readonly line: number;
  readonly raw: RawRow;
  readonly prepared: boolean;
  /** `created` for a new lead, `updated` when the existing one is refreshed. */
  readonly outcome: 'created' | 'updated';
  readonly dedupe: 'create' | 'update' | 'review';
  readonly matchReason: string | null;
  readonly confidence: number;
  readonly matchedPersonId: string | null;
  readonly matchedPersonName: string | null;
  readonly matchedLeadId: string | null;
  readonly needsProfile: boolean;
  readonly reason: string;
  readonly mapping: MappingSummary;
  readonly normalized: {
    readonly fullName: string;
    readonly jobTitle: string | null;
    readonly location: string | null;
    readonly linkedinUrl: string | null;
    readonly companyName: string;
    readonly companyDomain: string | null;
    readonly sourceUrl: string | null;
  };
  readonly candidate: unknown;
  readonly rawPayload: unknown;
}

export interface FailedRow {
  readonly line: number;
  readonly message: string;
}

export interface IngestionPlan {
  readonly sourceType: ImportBatchSource;
  readonly icpSelection: IcpSelection;
  readonly rows: readonly PlannedRow[];
  readonly failed: readonly FailedRow[];
  /** Dedupe says "same person, certain" — the lead is updated, not duplicated. */
  readonly mergeCount: number;
  /** A weak match was found and is queued for Duplicate Review. */
  readonly reviewCount: number;
  /** No existing match: a new Person and Lead will be created. */
  readonly createCount: number;
  readonly needsProfileCount: number;
  readonly idempotencyKey: string;
  readonly observedAt: string;
  readonly payloadHash: string;
}

export type RowPreviewOutcome = 'create' | 'merge' | 'review' | 'failed';

export interface RowPreview {
  readonly line: number;
  readonly name: string;
  readonly company: string;
  readonly jobTitle: string;
  readonly linkedinUrl: string | null;
  readonly outcome: RowPreviewOutcome;
  readonly reason: string;
  readonly confidence: number | null;
  readonly matchedPersonName: string | null;
  readonly primaryIcpName: string | null;
  readonly primaryIcpReason: string | null;
  readonly secondaryIcpNames: readonly string[];
  readonly needsProfile: boolean;
}

export interface ImportPreview {
  readonly sourceType: ImportBatchSource;
  readonly icpMode: 'primary' | 'auto_match';
  readonly requestedIcpName: string | null;
  readonly totalRows: number;
  readonly validRows: number;
  readonly createCount: number;
  readonly mergeCount: number;
  readonly reviewCount: number;
  readonly needsProfileCount: number;
  readonly failedCount: number;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly rows: readonly RowPreview[];
  readonly header: readonly string[];
}

/** The wire form of a previewed import, posted back by the wizard to execute. */
export interface PlanPayload {
  readonly header: readonly string[];
  readonly rows: readonly RawRow[];
}

export interface ExecuteCounts {
  readonly created: number;
  readonly updated: number;
  readonly duplicate: number;
  readonly needsProfile: number;
  readonly failed: number;
  readonly skipped: number;
}

export const ZERO_EXECUTE_COUNTS: ExecuteCounts = {
  created: 0,
  updated: 0,
  duplicate: 0,
  needsProfile: 0,
  failed: 0,
  skipped: 0,
};

/* --------------------------------------------------------------- parsing -- */

/** Which header label each field is recognised by. */
const HEADER_HINTS: Readonly<Record<MappingField, readonly string[]>> = {
  name: ['name', 'full name', 'person', 'contact', 'first name'],
  company: ['company', 'organisation', 'organization', 'account', 'employer'],
  jobTitle: ['job title', 'title', 'position', 'role', 'headline'],
  linkedinUrl: ['linkedin', 'linkedin url', 'profile url', 'profile'],
  location: ['location', 'city', 'region', 'country', 'geo'],
  sourceUrl: ['source url', 'source', 'url', 'result'],
};

function pickDelimiter(line: string): string {
  const tabs = (line.match(/\t/g) ?? []).length;
  const semis = (line.match(/;/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  if (tabs >= semis && tabs >= commas && tabs > 0) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/** RFC4180-ish split: quoted fields, doubled quotes, embedded delimiters. */
function splitLine(line: string, delimiter: string): readonly string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current.trim());
  return out;
}

function looksLikeHeader(cells: readonly string[]): boolean {
  const joined = cells.join(' ').toLowerCase();
  const hasName = HEADER_HINTS.name.some((hint) => joined.includes(hint));
  const hasCompany = HEADER_HINTS.company.some((hint) => joined.includes(hint));
  return hasName && hasCompany;
}

/**
 * Splits pasted or file-derived text into a header row and a body.
 *
 * XLSX is read as *text* by the wizard — the browser's text reader, not a
 * spreadsheet parser — which is an assumption the wizard states on screen and
 * documents in its own copy: a binary workbook must be exported as CSV first.
 */
export function parseDelimitedText(text: string): {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
} {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };

  const delimiter = pickDelimiter(lines[0] as string);
  const first = splitLine(lines[0] as string, delimiter);
  const header = looksLikeHeader(first) ? first : [];
  const bodyLines = header.length > 0 ? lines.slice(1) : lines;
  const rows = bodyLines.map((line) => splitLine(line, delimiter));
  return { header, rows };
}

/** Best-effort initial mapping from the header labels. */
export function suggestMapping(header: readonly string[]): Record<MappingField, number> {
  const mapping: Record<MappingField, number> = {
    name: -1,
    company: -1,
    jobTitle: -1,
    linkedinUrl: -1,
    location: -1,
    sourceUrl: -1,
  };
  header.forEach((label, index) => {
    const normalised = label.toLowerCase().trim();
    for (const field of MAPPING_FIELDS) {
      if (mapping[field] !== -1) continue;
      if (HEADER_HINTS[field].some((hint) => normalised === hint || normalised.includes(hint))) {
        mapping[field] = index;
      }
    }
  });
  return mapping;
}

/**
 * Applies a column mapping to parsed rows.
 *
 * The mapping is the only thing that decides which cell becomes which field, so a
 * mis-mapped column shows up in the preview before anything is written.
 */
export function mapRowsToCandidates(
  rows: readonly (readonly string[])[],
  mapping: Readonly<Record<MappingField, number>>,
  offset = 1,
): readonly RawRow[] {
  return rows.map((cells, index) => {
    const cell = (field: MappingField): string => {
      const column = mapping[field];
      if (column < 0) return '';
      return (cells[column] ?? '').trim();
    };
    return {
      line: index + 1 + offset,
      name: cell('name'),
      company: cell('company'),
      jobTitle: cell('jobTitle'),
      linkedinUrl: cell('linkedinUrl'),
      location: cell('location'),
      sourceUrl: cell('sourceUrl'),
    };
  });
}

/** A mapping is usable only when every required column is bound. */
export function missingRequiredMapping(
  mapping: Readonly<Record<MappingField, number>>,
): readonly string[] {
  const labels: Record<MappingField, string> = {
    name: 'name',
    company: 'company',
    jobTitle: 'job title',
    linkedinUrl: 'LinkedIn URL',
    location: 'location',
    sourceUrl: 'source URL',
  };
  return (['name', 'company', 'jobTitle'] as const)
    .filter((field) => mapping[field] < 0)
    .map((field) => labels[field]);
}

/**
 * serialises the reviewed rows for the execute step.
 *
 * Only cells cross the boundary — never a decision. The execute action re-runs
 * validation, normalization and dedupe, so an edited payload cannot change the
 * rules that produced the preview.
 */
export function planPayloadFor(plan: IngestionPlan, header: readonly string[]): PlanPayload {
  return {
    header,
    rows: plan.rows.map((row) => row.raw),
  };
}

/**
 * Turns a plan into what the operator reviews.
 *
 * The preview is computed with the same `@nexus/core` matcher the import itself
 * runs, so it is not an approximation of the result — and the counts A20 requires
 * (duplicates, needs-profile, validation failures) are visible before a write.
 */
export function toImportPreview(
  plan: IngestionPlan,
  header: readonly string[],
  icpNames: ReadonlyMap<string, string>,
): ImportPreview {
  const rows: RowPreview[] = [
    ...plan.rows.map((row): RowPreview => ({
      line: row.line,
      name: row.normalized.fullName,
      company: row.normalized.companyName,
      jobTitle: row.normalized.jobTitle ?? '—',
      linkedinUrl: row.normalized.linkedinUrl,
      outcome: row.dedupe === 'update' ? 'merge' : row.dedupe === 'review' ? 'review' : 'create',
      reason: row.reason,
      confidence: row.confidence > 0 ? row.confidence : null,
      matchedPersonName: row.matchedPersonName,
      primaryIcpName: row.mapping.icpName,
      primaryIcpReason: row.mapping.reason,
      secondaryIcpNames: row.mapping.secondaryIcpIds.map((id) => icpNames.get(id) ?? 'ICP'),
      needsProfile: row.needsProfile,
    })),
    ...plan.failed.map((row): RowPreview => ({
      line: row.line,
      name: '—',
      company: '—',
      jobTitle: '—',
      linkedinUrl: null,
      outcome: 'failed',
      reason: row.message,
      confidence: null,
      matchedPersonName: null,
      primaryIcpName: null,
      primaryIcpReason: null,
      secondaryIcpNames: [],
      needsProfile: false,
    })),
  ].sort((a, b) => a.line - b.line);

  return {
    sourceType: plan.sourceType,
    icpMode: plan.icpSelection.mode,
    requestedIcpName:
      plan.icpSelection.mode === 'primary' ? (icpNames.get(plan.icpSelection.icpId) ?? null) : 'Auto-match',
    totalRows: plan.rows.length + plan.failed.length,
    validRows: plan.rows.length,
    createCount: plan.createCount,
    mergeCount: plan.mergeCount,
    reviewCount: plan.reviewCount,
    needsProfileCount: plan.needsProfileCount,
    failedCount: plan.failed.length,
    idempotencyKey: plan.idempotencyKey,
    payloadHash: plan.payloadHash,
    rows,
    header,
  };
}

/** Re-exported so a caller can name the source type without importing the repo. */
export type { LeadSourceType };
