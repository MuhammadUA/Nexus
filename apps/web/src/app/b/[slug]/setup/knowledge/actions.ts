'use server';

/**
 * Knowledge library mutations (A14).
 *
 * spec `business_brain_and_knowledge.claim_policy`: outbound may use only approved
 * factual claims and must never invent metrics or results. Nothing on this screen can
 * therefore make an asset retrieval-eligible in one step: a new asset starts as
 * `draft`, and the approval pipeline is enforced server-side on every transition.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { APPROVAL_STATES, KNOWLEDGE_ASSET_TYPES } from '@nexus/core';

import { currentViewer } from '@/lib/current-viewer';
import { formString } from '@/lib/form-data';
import {
  createKnowledgeAsset,
  deleteKnowledgeAsset,
  setApprovalState,
  updateKnowledgeAsset,
} from '@/lib/repo/knowledge';

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
  .pipe(z.array(z.string().min(1).max(120)).max(60));

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

/** A knowledge asset link must be a real http(s) URL, not free text. */
const urlOrNull = z
  .string()
  .max(2000)
  .nullish()
  .transform((value) => {
    const trimmed = (value ?? '').trim();
    return trimmed.length === 0 ? null : trimmed;
  })
  .pipe(z.string().regex(/^https?:\/\/\S+$/i, 'Enter a full http(s) URL.').nullable());

const assetSchema = z.object({
  businessId: z.string().uuid(),
  type: z.enum(KNOWLEDGE_ASSET_TYPES),
  url: urlOrNull,
  title: textOrNull(300),
  description: textOrNull(8000),
  tags: listField,
  aiUseAllowed: boolField,
  mayMentionClientName: boolField,
  mayMentionNumericResults: boolField,
});

function readAssetForm(formData: FormData): unknown {
  return {
    businessId: field(formData, 'businessId'),
    type: field(formData, 'type'),
    url: field(formData, 'url'),
    title: field(formData, 'title'),
    description: field(formData, 'description'),
    tags: field(formData, 'tags'),
    aiUseAllowed: field(formData, 'aiUseAllowed'),
    mayMentionClientName: field(formData, 'mayMentionClientName'),
    mayMentionNumericResults: field(formData, 'mayMentionNumericResults'),
  };
}

function revalidate(businessSlug: string): void {
  revalidatePath(`/b/${businessSlug}/setup/knowledge`);
}

export async function createAssetAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = assetSchema.safeParse(readAssetForm(formData));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue === undefined ? 'That asset is not valid.' : issue.message };
  }
  const data = parsed.data;

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await createKnowledgeAsset(viewer, data.businessId, {
    type: data.type ?? null,
    url: data.url ?? null,
    title: data.title ?? null,
    description: data.description ?? null,
    tags: data.tags ?? [],
    aiUseAllowed: data.aiUseAllowed ?? false,
    mayMentionClientName: data.mayMentionClientName ?? false,
    mayMentionNumericResults: data.mayMentionNumericResults ?? false,
  });

  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok
      ? 'Asset added as a draft. It is not retrieval-eligible until it is approved.'
      : undefined,
  };
}

export async function updateAssetAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const assetId = z.string().uuid().safeParse(field(formData, 'assetId'));
  const parsed = assetSchema.safeParse(readAssetForm(formData));
  if (!assetId.success || !parsed.success) {
    return { ok: false, error: 'That asset is not valid.' };
  }
  const data = parsed.data;

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await updateKnowledgeAsset(viewer, assetId.data, data.businessId, {
    type: data.type ?? null,
    url: data.url ?? null,
    title: data.title ?? null,
    description: data.description ?? null,
    tags: data.tags ?? [],
    aiUseAllowed: data.aiUseAllowed ?? false,
    mayMentionClientName: data.mayMentionClientName ?? false,
    mayMentionNumericResults: data.mayMentionNumericResults ?? false,
  });

  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Asset saved.' : undefined,
  };
}

const approvalSchema = z.object({
  assetId: z.string().uuid(),
  approvalState: z.enum(APPROVAL_STATES),
});

export async function setApprovalStateAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = approvalSchema.safeParse({
    assetId: field(formData, 'assetId'),
    approvalState: field(formData, 'approvalState'),
  });
  if (!parsed.success) return { ok: false, error: 'That approval step is not available.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await setApprovalState(viewer, parsed.data.assetId, parsed.data.approvalState);
  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok
      ? `Asset marked ${parsed.data.approvalState.replace(/_/g, ' ')}.`
      : undefined,
  };
}

export async function deleteAssetAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = z.string().uuid().safeParse(field(formData, 'assetId'));
  if (!parsed.success) return { ok: false, error: 'That asset could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await deleteKnowledgeAsset(viewer, parsed.data);
  const businessSlug = formString(formData, 'businessSlug', '');
  if (result.ok) revalidate(businessSlug);
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Asset removed from retrieval.' : undefined,
  };
}
