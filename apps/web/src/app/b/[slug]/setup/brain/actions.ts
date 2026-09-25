'use server';

/**
 * Business Brain mutations (screen A11).
 *
 * The actor always comes from the signed session via `currentViewer()`; the
 * `businessId` a browser submits is only a hint. The repository runs inside
 * `withActor`, and the Business Brain write policies require `public.is_admin()`, so
 * a forged business id produces a privilege error instead of a cross-tenant write.
 *
 * Every field is validated with Zod before it reaches SQL.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import type { MutationResult } from '@/lib/repo/common';
import { formString, formStringOrNull } from '@/lib/form-data';
import {
  BRAIN_ASSET_KINDS,
  createOffer,
  createPersona,
  createService,
  createValueProposition,
  setBrainAssetApproval,
  snapshotBusinessContext,
} from '@/lib/repo/brain';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const notSignedIn: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

const businessIdSchema = z.string().uuid();

function toResult(result: MutationResult, message: string): ActionResult {
  return { ok: result.ok, error: result.error ?? null, message: result.ok ? message : undefined };
}

/** Shared preamble: resolve the viewer, revalidate the screen on success. */
async function run(
  formData: FormData,
  fn: (viewer: NonNullable<Awaited<ReturnType<typeof currentViewer>>>) => Promise<ActionResult>,
): Promise<ActionResult> {
  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await fn(viewer);
  if (result.ok) {
    const slug = formString(formData, 'businessSlug', '');
    if (slug.length > 0) revalidatePath(`/b/${slug}/setup/brain`);
  }
  return result;
}

/* -------------------------------------------------------------- creation --- */

const offerSchema = z.object({
  businessId: businessIdSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullish(),
  positioning: z.string().trim().max(4000).nullish(),
  ctaStyle: z.string().trim().max(200).nullish(),
});

export async function createOfferAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = offerSchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    name: formStringOrNull(formData, 'name'),
    description: formStringOrNull(formData, 'description'),
    positioning: formStringOrNull(formData, 'positioning'),
    ctaStyle: formStringOrNull(formData, 'ctaStyle'),
  });
  if (!parsed.success) return { ok: false, error: 'Give the offer a name.' };

  return run(formData, async (viewer) =>
    toResult(
      await createOffer(viewer, {
        businessId: parsed.data.businessId ?? undefined,
        name: parsed.data.name ?? undefined,
        description: emptyToNull(parsed.data.description ?? undefined),
        positioning: emptyToNull(parsed.data.positioning ?? undefined),
        ctaStyle: emptyToNull(parsed.data.ctaStyle ?? undefined),
      }),
      'Offer saved as a draft. Approve it before the AI may use it.',
    ),
  );
}

const serviceSchema = z.object({
  businessId: businessIdSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullish(),
  category: z.string().trim().max(120).nullish(),
});

export async function createServiceAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = serviceSchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    name: formStringOrNull(formData, 'name'),
    description: formStringOrNull(formData, 'description'),
    category: formStringOrNull(formData, 'category'),
  });
  if (!parsed.success) return { ok: false, error: 'Give the service a name.' };

  return run(formData, async (viewer) =>
    toResult(
      await createService(viewer, {
        businessId: parsed.data.businessId ?? undefined,
        name: parsed.data.name ?? undefined,
        description: emptyToNull(parsed.data.description ?? undefined),
        category: emptyToNull(parsed.data.category ?? undefined),
      }),
      'Service saved as a draft.',
    ),
  );
}

const personaSchema = z.object({
  businessId: businessIdSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullish(),
  painPoints: z.string().trim().max(4000).nullish(),
  goals: z.string().trim().max(4000).nullish(),
});

export async function createPersonaAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = personaSchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    name: formStringOrNull(formData, 'name'),
    description: formStringOrNull(formData, 'description'),
    painPoints: formStringOrNull(formData, 'painPoints'),
    goals: formStringOrNull(formData, 'goals'),
  });
  if (!parsed.success) return { ok: false, error: 'Give the persona a name.' };

  return run(formData, async (viewer) =>
    toResult(
      await createPersona(viewer, {
        businessId: parsed.data.businessId ?? undefined,
        name: parsed.data.name ?? undefined,
        description: emptyToNull(parsed.data.description ?? undefined),
        painPoints: splitList(parsed.data.painPoints),
        goals: splitList(parsed.data.goals),
      }),
      'Persona saved as a draft.',
    ),
  );
}

const valuePropSchema = z.object({
  businessId: businessIdSchema,
  statement: z.string().trim().min(1).max(4000),
  personaId: z.string().uuid().nullish(),
  proofRequired: z.boolean(),
});

export async function createValuePropositionAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = valuePropSchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    statement: formStringOrNull(formData, 'statement'),
    personaId: formStringOrNull(formData, 'personaId') || undefined,
    proofRequired: formStringOrNull(formData, 'proofRequired') === 'on',
  });
  if (!parsed.success) return { ok: false, error: 'Write the value proposition first.' };

  return run(formData, async (viewer) =>
    toResult(
      await createValueProposition(viewer, {
        businessId: parsed.data.businessId ?? undefined,
        statement: parsed.data.statement ?? undefined,
        personaId: parsed.data.personaId ?? null,
        proofRequired: parsed.data.proofRequired ?? undefined,
      }),
      'Value proposition saved as a draft.',
    ),
  );
}

/* -------------------------------------------------------------- approval --- */

const approvalSchema = z.object({
  businessId: businessIdSchema,
  kind: z.enum(BRAIN_ASSET_KINDS),
  id: z.string().uuid(),
  approved: z.boolean(),
});

/**
 * spec `business_brain_and_knowledge.claim_policy`: "Outbound may use only approved
 * factual claims." Approval is therefore a deliberate, audited toggle — the UI never
 * flips it implicitly.
 */
export async function setApprovalAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = approvalSchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    kind: formStringOrNull(formData, 'kind'),
    id: formStringOrNull(formData, 'id'),
    approved: formStringOrNull(formData, 'approved') === 'true',
  });
  if (!parsed.success) return { ok: false, error: 'That asset could not be found.' };

  return run(formData, async (viewer) =>
    toResult(
      await setBrainAssetApproval(viewer, parsed.data.kind, parsed.data.id, parsed.data.approved),
      parsed.data.approved
        ? 'Approved. It is now eligible for AI drafting and retrieval.'
        : 'Approval removed. It is no longer eligible for AI drafting.',
    ),
  );
}

/* ------------------------------------------------------------ versioning --- */

const snapshotSchema = z.object({
  businessId: businessIdSchema,
  reason: z.string().trim().max(400).nullish(),
});

/**
 * spec `business_brain_and_knowledge.versioning`: "Sent messages retain referenced
 * asset versions." Freezing the Brain is how a message can point at the exact
 * approved claims that were live when it was written.
 */
export async function snapshotContextAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = snapshotSchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    reason: formStringOrNull(formData, 'reason'),
  });
  if (!parsed.success) return { ok: false, error: 'That business could not be found.' };

  return run(formData, async (viewer) =>
    toResult(
      await snapshotBusinessContext(viewer, parsed.data.businessId, emptyToNull(parsed.data.reason ?? undefined)),
      'Context version frozen.',
    ),
  );
}

/* --------------------------------------------------------------- helpers --- */

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Comma- or newline-separated input -> `text[]`, used for persona pain points/goals. */
function splitList(value: string | null | undefined): readonly string[] {
  if (value == null) return [];
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 50);
}
