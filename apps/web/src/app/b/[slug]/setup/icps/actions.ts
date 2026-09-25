'use server';

/**
 * ICP and scoring mutations (A12).
 *
 * Every action resolves the viewer server-side and delegates to the repository, which
 * runs inside `withActor`. The actor never comes from form data, and every field —
 * including the ones that end up inside the `criteria`, `scoring_overrides` and
 * `routing` jsonb columns — is validated with Zod before it reaches SQL.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { SCORING_RULE_TARGETS, SIGNAL_KINDS, SIGNAL_POLARITIES } from '@nexus/core';

import { currentViewer } from '@/lib/current-viewer';
import { formString } from '@/lib/form-data';
import {
  ICP_PRIORITIES,
  createIcp,
  createScoringRule,
  deleteIcp,
  deleteScoringRule,
  updateIcp,
  updateScoringRule,
  type IcpCriteria,
  type IcpInput,
  type IcpRouting,
  type IcpScoringOverrides,
} from '@/lib/repo/icps';

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

/** Typed text lists arrive from `<textarea>`s as newline- or comma-separated text. */
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
  .pipe(z.array(z.string().min(1).max(200)).max(80));

/** Only the signal vocabulary the `scoring_rules_signal_kind_check` allows. */
const signalField = z
  .string()
  .max(4000)
  .nullish()
  .transform((value) => splitList(value))
  .pipe(z.array(z.enum(SIGNAL_KINDS)).max(30));

const optionalInt = (min: number, max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value == null || value.trim().length === 0 ? null : Number(value)))
    .pipe(z.number().int().min(min).max(max).nullable());

const uuidOrNull = z
  .string()
  .nullish()
  .transform((value) => (value == null || value.length === 0 ? null : value))
  .pipe(z.string().uuid().nullable());

const textOrNull = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => {
      const trimmed = (value ?? '').trim();
      return trimmed.length === 0 ? null : trimmed;
    });

const boolField = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Per-signal score overrides. A blank input means "inherit the business rule", so it
 * is dropped rather than stored as zero; anything non-numeric fails validation.
 */
const weightsField = z
  .record(z.string(), z.string())
  .transform((record) => {
    const weights: Record<string, number> = {};
    for (const [kind, raw] of Object.entries(record)) {
      if (raw.trim().length === 0) continue;
      weights[kind] = Number(raw);
    }
    return weights;
  })
  .pipe(z.record(z.string(), z.number().int().min(-10_000).max(10_000)));

function weightInputs(formData: FormData): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const kind of SIGNAL_KINDS) {
    const value = field(formData, `weight_${kind}`);
    if (value !== undefined) raw[kind] = value;
  }
  return raw;
}

const icpSchema = z.object({
  businessId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  description: textOrNull(4000),
  companyTypes: listField,
  markets: listField,
  buyerTitles: listField,
  exclusions: listField,
  requiredSignals: signalField,
  companySizeMin: optionalInt(0, 5_000_000),
  companySizeMax: optionalInt(0, 5_000_000),
  notes: textOrNull(4000),
  isDefault: boolField,
  isActive: boolField,
  defaultSequenceId: uuidOrNull,
  minScore: optionalInt(-10_000, 10_000),
  weights: weightsField,
  ownerUserId: uuidOrNull,
  outreachIdentityId: uuidOrNull,
  priority: z.enum(ICP_PRIORITIES),
  autoEnroll: boolField,
});

type IcpFormData = z.infer<typeof icpSchema>;

function readIcpForm(formData: FormData): unknown {
  return {
    businessId: field(formData, 'businessId'),
    name: field(formData, 'name'),
    description: field(formData, 'description'),
    companyTypes: field(formData, 'companyTypes'),
    markets: field(formData, 'markets'),
    buyerTitles: field(formData, 'buyerTitles'),
    exclusions: field(formData, 'exclusions'),
    requiredSignals: field(formData, 'requiredSignals'),
    companySizeMin: field(formData, 'companySizeMin'),
    companySizeMax: field(formData, 'companySizeMax'),
    notes: field(formData, 'notes'),
    isDefault: field(formData, 'isDefault'),
    isActive: field(formData, 'isActive'),
    defaultSequenceId: field(formData, 'defaultSequenceId'),
    minScore: field(formData, 'minScore'),
    weights: weightInputs(formData),
    ownerUserId: field(formData, 'ownerUserId'),
    outreachIdentityId: field(formData, 'outreachIdentityId'),
    priority: field(formData, 'priority'),
    autoEnroll: field(formData, 'autoEnroll'),
  };
}

function toIcpInput(data: IcpFormData): IcpInput {
  const criteria: IcpCriteria = {
    companyTypes: data.companyTypes ?? undefined,
    markets: data.markets ?? undefined,
    companySizeMin: data.companySizeMin ?? undefined,
    companySizeMax: data.companySizeMax ?? undefined,
    buyerTitles: data.buyerTitles ?? undefined,
    requiredSignals: data.requiredSignals ?? undefined,
    exclusions: data.exclusions ?? undefined,
    notes: data.notes ?? undefined,
  };
  const scoringOverrides: IcpScoringOverrides = { weights: data.weights, minScore: data.minScore };
  const routing: IcpRouting = {
    ownerUserId: data.ownerUserId ?? undefined,
    outreachIdentityId: data.outreachIdentityId ?? undefined,
    priority: data.priority ?? undefined,
    autoEnroll: data.autoEnroll ?? undefined,
  };
  return {
    name: data.name,
    description: data.description ?? null,
    criteria,
    isDefault: data.isDefault ?? false,
    isActive: data.isActive ?? true,
    scoringOverrides,
    defaultSequenceId: data.defaultSequenceId ?? null,
    routing,
  };
}

function revalidate(businessSlug: string): void {
  revalidatePath(`/b/${businessSlug}/setup/icps`);
  revalidatePath(`/b/${businessSlug}/overview`);
}

export async function createIcpAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = icpSchema.safeParse(readIcpForm(formData));
  if (!parsed.success) return { ok: false, error: 'Some of those values are not valid.' };
  const data = parsed.data;
  if (
    data.companySizeMin !== null &&
    data.companySizeMax !== null &&
    data.companySizeMax < data.companySizeMin
  ) {
    return { ok: false, error: 'The maximum company size cannot be below the minimum.' };
  }

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await createIcp(viewer, data.businessId, toIcpInput(data));
  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'ICP created.' : undefined,
  };
}

export async function updateIcpAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const icpId = z.string().uuid().safeParse(field(formData, 'icpId'));
  const parsed = icpSchema.safeParse(readIcpForm(formData));
  if (!icpId.success || !parsed.success) {
    return { ok: false, error: 'Some of those values are not valid.' };
  }
  const data = parsed.data;
  if (
    data.companySizeMin !== null &&
    data.companySizeMax !== null &&
    data.companySizeMax < data.companySizeMin
  ) {
    return { ok: false, error: 'The maximum company size cannot be below the minimum.' };
  }

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await updateIcp(viewer, icpId.data, data.businessId, toIcpInput(data));
  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'ICP saved.' : undefined,
  };
}

export async function deleteIcpAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = z.string().uuid().safeParse(field(formData, 'icpId'));
  if (!parsed.success) return { ok: false, error: 'That ICP could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await deleteIcp(viewer, parsed.data);
  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'ICP archived. Historical matches are preserved.' : undefined,
  };
}

const scoringRuleSchema = z
  .object({
    businessId: z.string().uuid(),
    targetType: z.enum(SCORING_RULE_TARGETS),
    targetIcpId: uuidOrNull,
    signalKind: z.enum(SIGNAL_KINDS),
    polarity: z.enum(SIGNAL_POLARITIES),
    points: z
      .string()
      .trim()
      .min(1)
      .transform((value) => Number(value))
      .pipe(z.number().int().min(-10_000).max(10_000)),
    label: textOrNull(300),
    isActive: boolField,
  })
  .refine((value) => value.targetType !== 'icp' || value.targetIcpId !== null, {
    message: 'Choose the ICP this rule applies to.',
  });

function readScoringRuleForm(formData: FormData): unknown {
  return {
    businessId: field(formData, 'businessId'),
    targetType: field(formData, 'targetType'),
    targetIcpId: field(formData, 'targetIcpId'),
    signalKind: field(formData, 'signalKind'),
    polarity: field(formData, 'polarity'),
    points: field(formData, 'points'),
    label: field(formData, 'label'),
    isActive: field(formData, 'isActive'),
  };
}

export async function createScoringRuleAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = scoringRuleSchema.safeParse(readScoringRuleForm(formData));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue === undefined ? 'That rule is not valid.' : issue.message,
    };
  }
  const data = parsed.data;

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await createScoringRule(viewer, {
    businessId: data.businessId ?? undefined,
    targetType: data.targetType ?? undefined,
    targetId:
      data.targetType === 'global'
        ? null
        : data.targetType === 'icp'
          ? data.targetIcpId
          : data.businessId,
    signalKind: data.signalKind ?? undefined,
    polarity: data.polarity ?? undefined,
    points: data.points ?? undefined,
    label: data.label ?? undefined,
    isActive: data.isActive ?? undefined,
  });

  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Scoring rule added.' : undefined,
  };
}

export async function updateScoringRuleAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const ruleId = z.string().uuid().safeParse(field(formData, 'ruleId'));
  const parsed = scoringRuleSchema.safeParse(readScoringRuleForm(formData));
  if (!ruleId.success || !parsed.success) {
    return { ok: false, error: 'That rule is not valid.' };
  }
  const data = parsed.data;

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await updateScoringRule(viewer, ruleId.data, {
    businessId: data.businessId ?? undefined,
    targetType: data.targetType ?? undefined,
    targetId:
      data.targetType === 'global'
        ? null
        : data.targetType === 'icp'
          ? data.targetIcpId
          : data.businessId,
    signalKind: data.signalKind ?? undefined,
    polarity: data.polarity ?? undefined,
    points: data.points ?? undefined,
    label: data.label ?? undefined,
    isActive: data.isActive ?? undefined,
  });

  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Scoring rule saved.' : undefined,
  };
}

export async function deleteScoringRuleAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = z.string().uuid().safeParse(field(formData, 'ruleId'));
  if (!parsed.success) return { ok: false, error: 'That scoring rule could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await deleteScoringRule(viewer, parsed.data);
  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Scoring rule deleted.' : undefined,
  };
}
