'use server';

/**
 * U11–U15 — the user-permissioned lead ingestion wizard.
 *
 * Contract (U11): "User-accessible File/Paste/Google/Apollo basic lead ingestion plus
 * recent imports/profile queue." U12 file, U13 paste, U14 Google, U15 Apollo.
 *
 * This file is a thin, validated adapter over `lib/repo/ingestion.ts` — the **same**
 * pipeline the admin Import Builder uses (validate → normalize → dedupe → evidence →
 * ICP/rules → lead → queue → audit). Nothing about ingestion is re-implemented here, so
 * a user import and an admin import cannot disagree about a duplicate or an ICP.
 *
 * spec `lead_sources.required_context_each_ingestion`: "Business, Primary ICP OR
 * Auto-match". Both are validated before any write, and the *business* is resolved from
 * the viewer's own list rather than trusted from the form.
 *
 * spec `lead_sources.apollo.prohibited_without_explicit_approval`: no enrichment call,
 * no email/phone lookup and no credit-spending action exists on this path. The "Enrichment
 * OFF" state is a property of the screen, not a toggle the operator can flip here.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { listBusinesses } from '@/lib/repo/businesses';
import {
  IMPORT_BATCH_SOURCES,
  MAPPING_FIELDS,
  mapRowsToCandidates,
  missingRequiredMapping,
  parseDelimitedText,
  prepareImportPreview,
  executeIngestion,
  suggestMapping,
  type ImportBatchSource,
  type MappingField,
  type RawRow,
} from '@/lib/repo/ingestion';
import { MAX_IMPORT_ROWS } from '@/lib/repo/user-sources';
import { formStringOrNull } from '@/lib/form-data';

export interface ImportActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly stage: 'input' | 'previewed' | 'executed';
  readonly headers: readonly string[];
  readonly mapping: Readonly<Record<MappingField, number>>;
  readonly rows: readonly ImportRowView[];
  readonly requestedIcpName: string | null | undefined;
  readonly autoMatch: boolean;
  readonly counts: ImportCounts | null;
}

export interface ImportRowView {
  readonly line: number;
  readonly name: string;
  readonly company: string;
  readonly jobTitle: string;
  readonly linkedinUrl: string | null | undefined;
  readonly outcome: string;
  readonly reason: string;
  readonly confidence: number | null | undefined;
  readonly matchedPersonName: string | null | undefined;
  readonly primaryIcpName: string | null | undefined;
  readonly needsProfile: boolean;
}

export interface ImportCounts {
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
  readonly batchId: string | null | undefined;
}

const EMPTY_MAPPING: Record<MappingField, number> = {
  name: -1,
  company: -1,
  jobTitle: -1,
  linkedinUrl: -1,
  location: -1,
  sourceUrl: -1,
};

function emptyState(error: string | null, stage: ImportActionResult['stage'] = 'input'): ImportActionResult {
  return {
    ok: error === null,
    error,
    stage,
    headers: [],
    mapping: { ...EMPTY_MAPPING },
    rows: [],
    requestedIcpName: null,
    autoMatch: true,
    counts: null,
  };
}

/**
 * The ingestion paths the user surface offers.
 *
 * `import_batches.source` also allows `external_ingest`, which belongs to the API gateway
 * and is not a button on this screen — the action refuses it even if it arrives in a
 * crafted POST.
 */
const USER_SOURCES: readonly ImportBatchSource[] = [
  'file_csv',
  'file_xlsx',
  'paste_list',
  'google_search',
  'apollo_basic',
];

const setupSchema = z.object({
  businessId: z.string().uuid(),
  sourceType: z.enum(IMPORT_BATCH_SOURCES),
  icpMode: z.enum(['primary', 'auto_match']),
  icpId: z.string().trim().max(60).nullish(),
});

const previewSchema = setupSchema.extend({
  rawText: z.string().min(1).max(2_000_000),
  /** The Google Search results URL (U14) or the Apollo search context (U15). */
  sourceUrl: z.string().trim().max(2000).nullish(),
});

/**
 * Resolves Business + Primary ICP/Auto-match, and refuses a business the viewer cannot
 * see before any pipeline work happens.
 */
async function resolveSetup(
  viewer: NonNullable<Awaited<ReturnType<typeof currentViewer>>>,
  data: z.infer<typeof setupSchema>,
): Promise<
  | {
      readonly ok: true;
      readonly businessId: string;
      readonly businessKey: string;
      readonly businessName: string;
      readonly sourceType: ImportBatchSource;
      readonly icpSelection: { readonly mode: 'primary'; readonly icpId: string } | { readonly mode: 'auto_match'; readonly icpId: null };
    }
  | { readonly ok: false; readonly error: string }
> {
  if (!USER_SOURCES.includes(data.sourceType)) {
    return { ok: false, error: 'That ingestion path is not available on the user surface.' };
  }
  if (!USER_SOURCES.includes(data.sourceType)) {
    return { ok: false, error: 'That ingestion path is not available on the user surface.' };
  }
  const businesses = await listBusinesses(viewer.actor);
  const business = businesses.find((candidate) => candidate.id === data.businessId);
  if (business === undefined) {
    return { ok: false, error: 'That business is not available to you.' };
  }
  if (data.icpMode === 'primary') {
    if (data.icpId == null || data.icpId.length === 0) {
      return { ok: false, error: 'Select a Primary ICP, or switch to Auto-match.' };
    }
    return {
      ok: true,
      businessId: business.id,
      businessKey: business.key,
      businessName: business.name,
      sourceType: data.sourceType ?? undefined,
      icpSelection: { mode: 'primary', icpId: data.icpId },
    };
  }
  return {
    ok: true,
    businessId: business.id,
    businessKey: business.key,
    businessName: business.name,
    sourceType: data.sourceType ?? undefined,
    icpSelection: { mode: 'auto_match', icpId: null },
  };
}

/**
 * U12/U13/U14/U15 — validate, normalize, dedupe and count, with no writes.
 *
 * The preview is produced by the same `prepareIngestion` the import itself runs, so the
 * duplicate and profile counts the operator sees are the counts they will get.
 */
export async function previewUserImportAction(
  _previous: ImportActionResult,
  formData: FormData,
): Promise<ImportActionResult> {
  const parsed = previewSchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    sourceType: formStringOrNull(formData, 'sourceType'),
    icpMode: formStringOrNull(formData, 'icpMode'),
    icpId: formStringOrNull(formData, 'icpId'),
    rawText: formStringOrNull(formData, 'rawText'),
    sourceUrl: formStringOrNull(formData, 'sourceUrl'),
  });
  if (!parsed.success) {
    return emptyState('Choose the business, the ICP mode and paste or upload some rows first.');
  }

  const viewer = await currentViewer();
  if (viewer === null) return emptyState('Your session has expired. Sign in again.');

  const setup = await resolveSetup(viewer, parsed.data);
  if (!setup.ok) return emptyState(setup.error);

  // The shared parser decides the delimiter and whether the first line is a header; the
  // mapping is then suggested from the labels and confirmed in the preview below.
  const { header, rows } = parseDelimitedText(parsed.data.rawText);
  if (rows.length === 0) {
    return emptyState('No data rows were found. Check that each row has a name, company and job title.');
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return emptyState(`Import at most ${String(MAX_IMPORT_ROWS)} rows at a time; this file has ${String(rows.length)}.`);
  }

  const mapping = suggestMapping(header);

  // spec `lead_sources.google.input` / `apollo`: the search URL is the provenance of every
  // row, so it fills the source-URL field when the parsed row has no column of its own.
  const fallbackSource = parsed.data.sourceUrl ?? '';
  const candidates = mapRowsToCandidates(rows, mapping, header.length > 0 ? 1 : 0).map((row) => ({
    ...row,
    sourceUrl: row.sourceUrl.length > 0 ? row.sourceUrl : fallbackSource.slice(0, 500),
  }));

  // A mapping with no name column cannot produce people; the operator is told which
  // required column is missing before anything is written.
  if (mapping.name < 0) {
    return {
      ok: false,
      error:
        'No name column was recognised. Include a header row with at least name, company and job title.',
      stage: 'input',
      headers: header,
      mapping: { ...EMPTY_MAPPING },
      rows: [],
      requestedIcpName: null,
      autoMatch: setup.icpSelection.mode === 'auto_match',
      counts: null,
    };
  }

  const missing = missingRequiredMapping(mapping);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Map every required column before previewing. Still missing: ${missing.join(', ')}.`,
      stage: 'input',
      headers: header,
      mapping,
      rows: [],
      requestedIcpName: null,
      autoMatch: setup.icpSelection.mode === 'auto_match',
      counts: null,
    };
  }

  const prepared = await prepareImportPreview(viewer.actor, {
    businessId: setup.businessId,
    businessKey: setup.businessKey,
    businessName: setup.businessName,
    sourceType: setup.sourceType,
    icpSelection: setup.icpSelection,
    rows: candidates,
    header,
  });

  return {
    ok: true,
    error: null,
    stage: 'previewed',
    headers: header,
    mapping,
    rows: prepared.preview.rows.map((row) => ({
      line: row.line,
      name: row.name,
      company: row.company,
      jobTitle: row.jobTitle,
      linkedinUrl: row.linkedinUrl,
      outcome: row.outcome,
      reason: row.reason,
      confidence: row.confidence,
      matchedPersonName: row.matchedPersonName,
      primaryIcpName: row.primaryIcpName,
      needsProfile: row.needsProfile,
    })),
    requestedIcpName: prepared.preview.requestedIcpName,
    autoMatch: prepared.preview.icpMode === 'auto_match',
    counts: {
      total: prepared.preview.totalRows,
      valid: prepared.preview.validRows,
      create: prepared.preview.createCount,
      merge: prepared.preview.mergeCount,
      review: prepared.preview.reviewCount,
      needsProfile: prepared.preview.needsProfileCount,
      failed: prepared.preview.failedCount,
      created: 0,
      updated: 0,
      duplicate: 0,
      batchId: null,
    },
  };
}

const executeSchema = previewSchema.extend({
  rawText: z.string().min(1).max(2_000_000),
  mapping: z.string().max(400),
});

/**
 * U12–U15 — run the import.
 *
 * The rows are re-parsed and re-validated here; the preview is never trusted. Idempotency
 * comes from `executeIngestion`'s `ingest_requests` ledger, so a double submit is refused
 * rather than importing twice.
 */
export async function executeUserImportAction(
  _previous: ImportActionResult,
  formData: FormData,
): Promise<ImportActionResult> {
  const parsed = executeSchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    sourceType: formStringOrNull(formData, 'sourceType'),
    icpMode: formStringOrNull(formData, 'icpMode'),
    icpId: formStringOrNull(formData, 'icpId'),
    rawText: formStringOrNull(formData, 'rawText'),
    sourceUrl: formStringOrNull(formData, 'sourceUrl'),
    mapping: formStringOrNull(formData, 'mapping'),
  });
  if (!parsed.success) {
    return emptyState('The import could not be read. Preview it again.');
  }

  const viewer = await currentViewer();
  if (viewer === null) return emptyState('Your session has expired. Sign in again.');

  const setup = await resolveSetup(viewer, parsed.data);
  if (!setup.ok) return emptyState(setup.error);

  const mapping = parseMapping(parsed.data.mapping);
  if (mapping === null) return emptyState('The column mapping could not be read. Preview the import again.');

  const { header, rows } = parseDelimitedText(parsed.data.rawText);
  if (rows.length === 0) return emptyState('No data rows were found. Preview the import again.');
  if (rows.length > MAX_IMPORT_ROWS) {
    return emptyState(`Import at most ${String(MAX_IMPORT_ROWS)} rows at a time.`);
  }

  const fallbackSource = parsed.data.sourceUrl ?? '';
  const candidates: readonly RawRow[] = mapRowsToCandidates(rows, mapping, header.length > 0 ? 1 : 0).map((row) => ({
    ...row,
    sourceUrl: row.sourceUrl.length > 0 ? row.sourceUrl : fallbackSource.slice(0, 500),
  }));

  const outcome = await executeIngestion(viewer, {
    businessId: setup.businessId,
    businessKey: setup.businessKey,
    businessName: setup.businessName,
    sourceType: setup.sourceType,
    icpSelection: setup.icpSelection,
    rows: candidates,
  });

  if (!outcome.ok) {
    return {
      ok: false,
      error: outcome.error ?? 'The import could not be completed.',
      stage: 'previewed',
      headers: header,
      mapping,
      rows: [],
      requestedIcpName: null,
      autoMatch: setup.icpSelection.mode === 'auto_match',
      counts: null,
    };
  }

  revalidatePath('/my-lead-sources');
  revalidatePath('/my-leads');
  revalidatePath('/my-profile-queue');
  revalidatePath('/my-duplicates');
  revalidatePath('/trash');
  revalidatePath('/my-day');

  return {
    ok: true,
    error: null,
    stage: 'executed',
    headers: header,
    mapping,
    rows: [],
    requestedIcpName: null,
    autoMatch: setup.icpSelection.mode === 'auto_match',
    counts: {
      total: candidates.length,
      valid: candidates.length,
      create: 0,
      merge: 0,
      review: 0,
      needsProfile: outcome.counts.needsProfile,
      failed: outcome.counts.failed,
      created: outcome.counts.created,
      updated: outcome.counts.updated,
      duplicate: outcome.counts.duplicate,
      batchId: outcome.batchId,
    },
  };
}

/** The mapping travels as `field:index` pairs so it stays a plain string field. */
function parseMapping(raw: string): Record<MappingField, number> | null {
  const mapping: Record<MappingField, number> = { ...EMPTY_MAPPING };
  const parts = raw.split(',').filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  for (const part of parts) {
    const [field, index] = part.split(':');
    if (field === undefined || index === undefined) continue;
    if (!(MAPPING_FIELDS as readonly string[]).includes(field)) continue;
    const parsedIndex = Number(index);
    mapping[field as MappingField] = Number.isFinite(parsedIndex) ? Math.trunc(parsedIndex) : -1;
  }
  return mapping;
}
