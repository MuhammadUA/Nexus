'use server';

/**
 * Admin Import Builder actions (A20).
 *
 * spec `screen_inventory A20`: "Business + Primary ICP/Auto-match, source input,
 * preview, mapping, validation, duplicate/profile counts, import."
 *
 * The wizard is four server round-trips, each one validated on the server:
 *
 *   parse   → split the pasted/file text into header + rows
 *   preview → validate, normalize, dedupe and count, with NO writes
 *   execute → write the batch, the rows, the leads and the evidence
 *
 * The preview is never trusted. `execute` re-runs validation, normalization and
 * dedupe inside the write transaction, so a tampered form can change the mapped
 * cells but not the rules. Every payload is parsed with the shared Zod schemas
 * from `@nexus/core` (`ingestEnvelopeSchema` via `prepareIngestion`,
 * `candidatePersonSchema` per row); nothing here invents a laxer check.
 *
 * Idempotency: the whole import carries one key derived from
 * source_client + business + payload_type + payload + observed_at, recorded in
 * `ingest_requests`, which is unique on `(source_client, business_id,
 * idempotency_key)`. Re-submitting the identical import is refused rather than
 * silently duplicating leads.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { listBusinesses } from '@/lib/repo/businesses';
import {
  IMPORT_BATCH_SOURCES,
  mapRowsToCandidates,
  missingRequiredMapping,
  parseDelimitedText,
  suggestMapping,
  type ImportBatchSource,
  type MappingField,
  type RawRow,
  type RowPreview,
} from '@/lib/ingestion-view';
import { executeIngestion, prepareImportPreview } from '@/lib/repo/ingestion';
import { formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

/* ------------------------------------------------------------ form shapes -- */

const mappingShape = {
  'map.name': z.coerce.number().int().min(-1).max(200),
  'map.company': z.coerce.number().int().min(-1).max(200),
  'map.jobTitle': z.coerce.number().int().min(-1).max(200),
  'map.linkedinUrl': z.coerce.number().int().min(-1).max(200),
  'map.location': z.coerce.number().int().min(-1).max(200),
  'map.sourceUrl': z.coerce.number().int().min(-1).max(200),
} as const;

const setupSchema = z.object({
  businessSlug: z.string().trim().min(1).max(120),
  sourceType: z.enum(IMPORT_BATCH_SOURCES),
  icpMode: z.enum(['primary', 'auto_match']),
  icpId: z.string().trim().max(60).nullish(),
});

const parseSchema = setupSchema.extend({
  rawText: z.string().min(1).max(2_000_000),
  delimiter: z.string().max(4).nullish(),
});

const previewSchema = parseSchema.extend(mappingShape);

const executeSchema = setupSchema.extend({
  payload: z.string().min(2).max(4_000_000),
});

/** The wizard's state, mirrored back to the client component. */
export interface WizardState {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly stage: 'setup' | 'mapped' | 'previewed' | 'executed';
  readonly header: readonly string[];
  readonly mapping: Readonly<Record<MappingField, number>>;
  readonly sampleRows: readonly (readonly string[])[];
  readonly rowCount: number;
  readonly preview: WizardPreview | null;
  readonly result: WizardResult | null;
}

export interface WizardPreview {
  readonly requestedIcpName: string | null | undefined;
  readonly sourceType: string;
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
  /** The exact rows the execute step will post back (cells only, no rules). */
  readonly payload: string;
}

export interface WizardResult {
  readonly batchId: string;
  readonly created: number;
  readonly updated: number;
  readonly duplicate: number;
  readonly needsProfile: number;
  readonly failed: number;
  readonly skipped: number;
}

const EMPTY_MAPPING: Record<MappingField, number> = {
  name: -1,
  company: -1,
  jobTitle: -1,
  linkedinUrl: -1,
  location: -1,
  sourceUrl: -1,
};

function emptyState(error: string | null, stage: WizardState['stage'] = 'setup'): WizardState {
  return {
    ok: error === null,
    error,
    stage,
    header: [],
    mapping: { ...EMPTY_MAPPING },
    sampleRows: [],
    rowCount: 0,
    preview: null,
    result: null,
  };
}

/**
 * Validates the shared "which business, which source, which ICP" part of every import
 * step.
 *
 * Synchronous on purpose: it only parses the submitted form, so making it `async`
 * would imply a database round trip that does not happen.
 */
function resolveSetup(formData: FormData): 
  | { readonly ok: true; readonly slug: string; readonly sourceType: ImportBatchSource; readonly icpSelection: { mode: 'primary'; icpId: string } | { mode: 'auto_match'; icpId: null } }
  | { readonly ok: false; readonly error: string }
{
  const parsed = setupSchema.safeParse({
    businessSlug: formStringOrNull(formData, 'businessSlug'),
    sourceType: formStringOrNull(formData, 'sourceType'),
    icpMode: formStringOrNull(formData, 'icpMode'),
    icpId: formStringOrNull(formData, 'icpId'),
  });
  if (!parsed.success) {
    return { ok: false, error: 'Choose the source mode and how the Primary ICP is decided.' };
  }
  if (parsed.data.icpMode === 'primary') {
    // spec `lead_sources.required_context_each_ingestion`: Business + Primary ICP
    // OR Auto-match. A named mode with no ICP selected is not a valid import.
    if (parsed.data.icpId == null || parsed.data.icpId.length === 0) {
      return { ok: false, error: 'Select a Primary ICP, or switch to Auto-match.' };
    }
    return {
      ok: true,
      slug: parsed.data.businessSlug ?? undefined,
      sourceType: parsed.data.sourceType ?? undefined,
      icpSelection: { mode: 'primary', icpId: parsed.data.icpId },
    };
  }
  return {
    ok: true,
    slug: parsed.data.businessSlug ?? undefined,
    sourceType: parsed.data.sourceType ?? undefined,
    icpSelection: { mode: 'auto_match', icpId: null },
  };
}

/**
 * Step 2 — split the submitted text into columns.
 *
 * The header row is detected by its labels, not assumed, because a paste from a
 * spreadsheet often has none. The suggestion is only a starting point: the
 * operator confirms every column in the mapping step.
 */
export async function parseImportAction(
  _previous: WizardState,
  formData: FormData,
): Promise<WizardState> {
  const setup = resolveSetup(formData);
  if (!setup.ok) return emptyState(setup.error);

  const parsed = parseSchema.safeParse({
    businessSlug: formStringOrNull(formData, 'businessSlug'),
    sourceType: formStringOrNull(formData, 'sourceType'),
    icpMode: formStringOrNull(formData, 'icpMode'),
    icpId: formStringOrNull(formData, 'icpId'),
    rawText: formStringOrNull(formData, 'rawText'),
    delimiter: formStringOrNull(formData, 'delimiter'),
  });
  if (!parsed.success) {
    return emptyState('Paste some rows, or choose a CSV file, before continuing.');
  }

  const viewer = await currentViewer();
  if (viewer === null) return emptyState('Your session has expired. Sign in again.');

  const { header, rows } = parseDelimitedText(parsed.data.rawText);
  if (rows.length === 0) {
    return emptyState('No data rows were found in that input. Check that each row has a name, company and job title.');
  }

  const mapping = suggestMapping(header);
  return {
    ok: true,
    error: null,
    stage: 'mapped',
    header,
    mapping,
    sampleRows: rows.slice(0, 5),
    rowCount: rows.length,
    preview: null,
    result: null,
  };
}

/**
 * Step 3 — validate, normalize, dedupe and count.
 *
 * Nothing is written: this is `prepareIngestion`, the same code path the import
 * runs. spec A20 requires the duplicate and profile counts to be visible before
 * the import, and they are here before anything is committed.
 */
export async function previewImportAction(
  _previous: WizardState,
  formData: FormData,
): Promise<WizardState> {
  const setup = resolveSetup(formData);
  if (!setup.ok) return emptyState(setup.error);

  const parsed = previewSchema.safeParse({
    businessSlug: formStringOrNull(formData, 'businessSlug'),
    sourceType: formStringOrNull(formData, 'sourceType'),
    icpMode: formStringOrNull(formData, 'icpMode'),
    icpId: formStringOrNull(formData, 'icpId'),
    rawText: formStringOrNull(formData, 'rawText'),
    delimiter: formStringOrNull(formData, 'delimiter'),
    'map.name': formStringOrNull(formData, 'map.name') ?? -1,
    'map.company': formStringOrNull(formData, 'map.company') ?? -1,
    'map.jobTitle': formStringOrNull(formData, 'map.jobTitle') ?? -1,
    'map.linkedinUrl': formStringOrNull(formData, 'map.linkedinUrl') ?? -1,
    'map.location': formStringOrNull(formData, 'map.location') ?? -1,
    'map.sourceUrl': formStringOrNull(formData, 'map.sourceUrl') ?? -1,
  });
  if (!parsed.success) {
    return emptyState('The mapping could not be read. Re-parse the input and try again.');
  }

  const viewer = await currentViewer();
  if (viewer === null) return emptyState('Your session has expired. Sign in again.');

  const mapping: Record<MappingField, number> = {
    name: parsed.data['map.name'],
    company: parsed.data['map.company'],
    jobTitle: parsed.data['map.jobTitle'],
    linkedinUrl: parsed.data['map.linkedinUrl'],
    location: parsed.data['map.location'],
    sourceUrl: parsed.data['map.sourceUrl'],
  };

  const missing = missingRequiredMapping(mapping);
  if (missing.length > 0) {
    const { header, rows } = parseDelimitedText(parsed.data.rawText);
    return {
      ok: false,
      error: `Map every required column before previewing. Still missing: ${missing.join(', ')}.`,
      stage: 'mapped',
      header,
      mapping,
      sampleRows: rows.slice(0, 5),
      rowCount: rows.length,
      preview: null,
      result: null,
    };
  }

  const { header, rows } = parseDelimitedText(parsed.data.rawText);
  // spec `file.minimum_columns` + `google.expected_partial_data`: the required
  // columns are name, company and job title; LinkedIn URL, location and source URL
  // are optional.
  const candidates: readonly RawRow[] = mapRowsToCandidates(rows, mapping, header.length > 0 ? 1 : 0);

  return withBusiness(viewer, setup.slug, async (businessKey, businessId, businessName) => {
    const prepared = await prepareImportPreview(viewer.actor, {
      businessId,
      businessKey,
      businessName,
      sourceType: setup.sourceType,
      icpSelection: setup.icpSelection,
      rows: candidates,
      header,
    });

    return {
      ok: true,
      error: null,
      stage: 'previewed' as const,
      header,
      mapping,
      sampleRows: rows.slice(0, 5),
      rowCount: rows.length,
      preview: {
        requestedIcpName: prepared.preview.requestedIcpName,
        sourceType: prepared.preview.sourceType,
        totalRows: prepared.preview.totalRows,
        validRows: prepared.preview.validRows,
        createCount: prepared.preview.createCount,
        mergeCount: prepared.preview.mergeCount,
        reviewCount: prepared.preview.reviewCount,
        needsProfileCount: prepared.preview.needsProfileCount,
        failedCount: prepared.preview.failedCount,
        idempotencyKey: prepared.preview.idempotencyKey,
        payloadHash: prepared.preview.payloadHash,
        rows: prepared.preview.rows,
        payload: JSON.stringify(prepared.payload),
      },
      result: null,
    };
  });
}

/**
 * Step 4 — write it.
 *
 * The request body carries only the mapped rows; the rules are re-applied here.
 */
export async function executeImportAction(
  _previous: WizardState,
  formData: FormData,
): Promise<WizardState> {
  const setup = resolveSetup(formData);
  if (!setup.ok) return emptyState(setup.error);

  const parsed = executeSchema.safeParse({
    businessSlug: formStringOrNull(formData, 'businessSlug'),
    sourceType: formStringOrNull(formData, 'sourceType'),
    icpMode: formStringOrNull(formData, 'icpMode'),
    icpId: formStringOrNull(formData, 'icpId'),
    payload: formStringOrNull(formData, 'payload'),
  });
  if (!parsed.success) {
    return emptyState('The previewed rows could not be read. Preview the import again.');
  }

  const viewer = await currentViewer();
  if (viewer === null) return emptyState('Your session has expired. Sign in again.');

  const payload = parsePlanPayload(parsed.data.payload);
  if (payload === null || payload.rows.length === 0) {
    return emptyState('The previewed rows could not be read. Preview the import again.');
  }

  return withBusiness(viewer, setup.slug, async (businessKey, businessId, businessName) => {
    // Re-derive the mapping-free raw rows: the client only ever sends cells, and
    // each cell is re-validated by `candidatePersonSchema` inside the pipeline.
    const outcome = await executeIngestion(viewer, {
      businessId,
      businessKey,
      businessName,
      sourceType: setup.sourceType,
      icpSelection: setup.icpSelection,
      rows: payload.rows,
    });

    if (!outcome.ok) {
      return {
        ok: false,
        error: outcome.error,
        stage: 'previewed' as const,
        header: payload.header,
        mapping: { ...EMPTY_MAPPING },
        sampleRows: [],
        rowCount: payload.rows.length,
        preview: null,
        result: null,
      };
    }

    revalidatePath(`/b/${setup.slug}/lead-sources`);
    revalidatePath(`/b/${setup.slug}/leads`);
    revalidatePath(`/b/${setup.slug}/profile-queue`);
    revalidatePath(`/b/${setup.slug}/duplicates`);
    revalidatePath(`/b/${setup.slug}/trash`);

    return {
      ok: true,
      error: null,
      stage: 'executed' as const,
      header: payload.header,
      mapping: { ...EMPTY_MAPPING },
      sampleRows: [],
      rowCount: payload.rows.length,
      preview: null,
      result: {
        batchId: outcome.batchId ?? '',
        created: outcome.counts.created,
        updated: outcome.counts.updated,
        duplicate: outcome.counts.duplicate,
        needsProfile: outcome.counts.needsProfile,
        failed: outcome.counts.failed,
        skipped: outcome.counts.skipped,
      },
    };
  });
}

/**
 * Resolves the business named in the form against the viewer's own list, so a
 * crafted POST cannot target a business the viewer cannot see. The database would
 * refuse the write anyway; doing it here means the operator gets a real reason.
 */
async function withBusiness<T>(
  viewer: NonNullable<Awaited<ReturnType<typeof currentViewer>>>,
  slug: string,
  fn: (businessKey: string, businessId: string, businessName: string) => Promise<T>,
): Promise<T | WizardState> {
  const businesses = await listBusinesses(viewer.actor);
  const business = businesses.find((candidate) => candidate.key === slug);
  if (business === undefined) {
    return emptyState('That business is not available to you.');
  }
  return fn(business.key, business.id, business.name);
}

function parsePlanPayload(raw: string): { readonly header: readonly string[]; readonly rows: readonly RawRow[] } | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const header = Array.isArray((value as { header?: unknown }).header)
      ? ((value as { header: unknown[] }).header.filter((entry): entry is string => typeof entry === 'string'))
      : [];
    const rows: RawRow[] = [];
    const source = (value as { rows?: unknown }).rows;
    if (!Array.isArray(source)) return null;
    for (const entry of source) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const text = (key: string): string => (typeof row[key] === 'string' ? (row[key]).slice(0, 5000) : '');
      rows.push({
        line: typeof row.line === 'number' ? row.line : rows.length + 1,
        name: text('name'),
        company: text('company'),
        jobTitle: text('jobTitle'),
        linkedinUrl: text('linkedinUrl'),
        location: text('location'),
        sourceUrl: text('sourceUrl'),
      });
    }
    return { header, rows };
  } catch {
    return null;
  }
}
