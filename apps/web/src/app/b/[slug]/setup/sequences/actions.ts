'use server';

/**
 * Sequence mutations (A13).
 *
 * Publishing is the one write that must not be reimplemented here: it delegates to
 * `public.publish_sequence_version`, which freezes SENT content, leaves LOCKED alone,
 * invalidates eligible DYNAMIC unsent instances and records what it did. This module
 * previews that impact with `computePublishImpact` and then calls the RPC.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { DELAY_BASES, SEQUENCE_STEP_KINDS } from '@nexus/core';

import { currentViewer } from '@/lib/current-viewer';
import { formString } from '@/lib/form-data';
import {
  GENERATION_MODES,
  PROOF_POLICIES,
  SEQUENCE_STATUSES,
  archiveSequence,
  createDraftVersion,
  createSequence,
  getSequenceTimingSettings,
  publishSequenceVersion,
  updateSequence,
  updateStep,
} from '@/lib/repo/sequences';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const notSignedIn: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

function splitList(value: unknown): readonly string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const listField = z
  .string()
  .max(4000)
  .nullish()
  .transform((value) => splitList(value))
  .pipe(z.array(z.string().min(1).max(200)).max(60));

const textOrNull = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => {
      const trimmed = (value ?? '').trim();
      return trimmed.length === 0 ? null : trimmed;
    });

const intField = (min: number, max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value == null || value.trim().length === 0 ? null : Number(value)))
    .pipe(z.number().int().min(min).max(max).nullable());

const boolField = z.enum(['true', 'false']).transform((value) => value === 'true');

function revalidate(businessSlug: string): void {
  revalidatePath(`/b/${businessSlug}/setup/sequences`);
  revalidatePath(`/b/${businessSlug}/overview`);
}

/* ------------------------------------------------------------- sequences -- */

const sequenceSchema = z.object({
  businessId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  description: textOrNull(4000),
  isDefault: boolField,
  status: z.enum(SEQUENCE_STATUSES),
});

function readSequenceForm(formData: FormData): unknown {
  return {
    businessId: field(formData, 'businessId'),
    name: field(formData, 'name'),
    description: field(formData, 'description'),
    isDefault: field(formData, 'isDefault'),
    // The create form has no status control, so a new sequence is always a draft.
    status: field(formData, 'status') ?? 'draft',
  };
}

export async function createSequenceAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = sequenceSchema.safeParse(readSequenceForm(formData));
  if (!parsed.success) return { ok: false, error: 'Give the sequence a name.' };
  const data = parsed.data;

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await createSequence(viewer, data.businessId, {
    name: data.name,
    description: data.description ?? null,
    isDefault: data.isDefault ?? false,
  });
  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Sequence created. Add a draft version to define its steps.' : undefined,
  };
}

export async function updateSequenceAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const sequenceId = z.string().uuid().safeParse(field(formData, 'sequenceId'));
  const parsed = sequenceSchema.safeParse(readSequenceForm(formData));
  if (!sequenceId.success || !parsed.success) {
    return { ok: false, error: 'Give the sequence a name.' };
  }
  const data = parsed.data;

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await updateSequence(viewer, sequenceId.data, data.businessId, {
    name: data.name ?? null,
    description: data.description ?? null,
    isDefault: data.isDefault ?? null,
    status: data.status ?? null,
  });
  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Sequence saved.' : undefined,
  };
}

export async function archiveSequenceAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = z.string().uuid().safeParse(field(formData, 'sequenceId'));
  if (!parsed.success) return { ok: false, error: 'That sequence could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await archiveSequence(viewer, parsed.data);
  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Sequence archived.' : undefined,
  };
}

/* -------------------------------------------------------------- versions -- */

const versionSchema = z.object({
  businessId: z.string().uuid(),
  sequenceId: z.string().uuid(),
  sourceVersionId: z
    .string()
    .nullish()
    .transform((value) => (value == null || value.length === 0 ? null : value))
    .pipe(z.string().uuid().nullable()),
  changeSummary: textOrNull(1000),
});

export async function createVersionAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = versionSchema.safeParse({
    businessId: field(formData, 'businessId'),
    sequenceId: field(formData, 'sequenceId'),
    sourceVersionId: field(formData, 'sourceVersionId'),
    changeSummary: field(formData, 'changeSummary'),
  });
  if (!parsed.success) return { ok: false, error: 'That sequence could not be found.' };
  const data = parsed.data;

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  // The seeded cadence is business configuration, read here rather than hard-coded so
  // a business that changed its delays gets its own numbers in a new draft.
  const timing = await getSequenceTimingSettings(viewer.actor, data.businessId);

  const result = await createDraftVersion(viewer, data.sequenceId, {
    sourceVersionId: data.sourceVersionId ?? null,
    followupDelays: timing.followupDelays,
    changeSummary: data.changeSummary ?? null,
  });
  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Draft version created.' : undefined,
  };
}

const stepSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(SEQUENCE_STEP_KINDS),
  delayDays: intField(0, 3650).transform((value) => value ?? 0),
  delayBasis: z.enum(DELAY_BASES),
  goal: textOrNull(2000),
  allowedContext: listField,
  wordMax: intField(1, 2000),
  ctaStyle: textOrNull(300),
  prohibitedPhrases: listField,
  proofPolicy: z
    .string()
    .nullish()
    .transform((value) => (value == null || value.length === 0 ? null : value))
    .pipe(z.enum(PROOF_POLICIES).nullable()),
  tone: textOrNull(300),
  generationMode: z.enum(GENERATION_MODES),
  isActive: boolField,
});

export async function updateStepAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const stepId = z.string().uuid().safeParse(field(formData, 'stepId'));
  const parsed = stepSchema.safeParse({
    name: field(formData, 'name'),
    kind: field(formData, 'kind'),
    delayDays: field(formData, 'delayDays'),
    delayBasis: field(formData, 'delayBasis'),
    goal: field(formData, 'goal'),
    allowedContext: field(formData, 'allowedContext'),
    wordMax: field(formData, 'wordMax'),
    ctaStyle: field(formData, 'ctaStyle'),
    prohibitedPhrases: field(formData, 'prohibitedPhrases'),
    proofPolicy: field(formData, 'proofPolicy'),
    tone: field(formData, 'tone'),
    generationMode: field(formData, 'generationMode'),
    isActive: field(formData, 'isActive'),
  });
  if (!stepId.success || !parsed.success) {
    return { ok: false, error: 'Some of those step values are not valid.' };
  }
  const data = parsed.data;

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await updateStep(viewer, stepId.data, {
    name: data.name ?? undefined,
    kind: data.kind ?? undefined,
    delayDays: data.delayDays ?? undefined,
    delayBasis: data.delayBasis ?? undefined,
    goal: data.goal ?? null,
    allowedContext: data.allowedContext ?? [],
    wordMax: data.wordMax ?? null,
    ctaStyle: data.ctaStyle ?? null,
    prohibitedPhrases: data.prohibitedPhrases ?? [],
    proofPolicy: data.proofPolicy ?? null,
    tone: data.tone ?? null,
    generationMode: data.generationMode ?? undefined,
    isActive: data.isActive ?? undefined,
  });
  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Step saved.' : undefined,
  };
}

/**
 * Publishing.
 *
 * The server re-checks the version before calling the RPC and reports the counts the
 * RPC actually applied, so the number the operator saw in the preview can be compared
 * with what the database did.
 */
export async function publishVersionAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = z.string().uuid().safeParse(field(formData, 'versionId'));
  if (!parsed.success) return { ok: false, error: 'That sequence version could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await publishSequenceVersion(viewer, parsed.data);
  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) {
    revalidate(businessSlug);
    revalidatePath(`/b/${businessSlug}/leads`);
    revalidatePath('/my-day');
  }
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok
      ? 'Version published. SENT messages are unchanged, LOCKED messages are untouched, and eligible DYNAMIC unsent messages now need regeneration.'
      : undefined,
  };
}
