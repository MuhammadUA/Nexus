'use server';

/**
 * Profile Queue mutations (A06).
 *
 * spec `lead_sources.profile_queue_flow`: "Open search/profile, capture LinkedIn
 * URL + full copied profile data, update the existing partial lead rather than
 * creating a new lead."
 *
 * The action passes the operator's raw input straight to the repository, where it
 * is parsed with `profileCaptureSchema` and written against a `lead_id` that came
 * from the queue — there is no code path here that creates a lead or a person.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { formStringOrNull } from '@/lib/form-data';
import {
  captureProfile,
  markQueueInProgress,
  retryQueueItem,
  skipQueueItem,
} from '@/lib/repo/profile-queue';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const notSignedIn: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

const captureSchema = z.object({
  businessSlug: z.string().trim().min(1).max(120),
  leadId: z.string().uuid(),
  linkedinUrl: z.string().trim().min(1).max(2048),
  // The page content is validated again by `profileCaptureSchema` (bounded and
  // control-character-stripped); this bound only stops an obviously hostile body.
  pageContent: z.string().min(1).max(400_000),
  extractorConfidence: z.coerce.number().min(0).max(1).nullish(),
});

function revalidateQueue(slug: string, leadId: string): void {
  revalidatePath(`/b/${slug}/profile-queue`);
  revalidatePath(`/b/${slug}/leads/${leadId}`);
  revalidatePath(`/b/${slug}/leads`);
}

export async function captureProfileAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = captureSchema.safeParse({
    businessSlug: formStringOrNull(formData, 'businessSlug'),
    leadId: formStringOrNull(formData, 'leadId'),
    linkedinUrl: formStringOrNull(formData, 'linkedinUrl'),
    pageContent: formStringOrNull(formData, 'pageContent'),
    extractorConfidence:
      formStringOrNull(formData, 'extractorConfidence') === null || formStringOrNull(formData, 'extractorConfidence') === ''
        ? undefined
        : formStringOrNull(formData, 'extractorConfidence'),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error:
        'Paste the full copied LinkedIn profile and the profile URL. Both are required — the capture updates the existing lead.',
    };
  }

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await captureProfile(viewer, {
    leadId: parsed.data.leadId,
    linkedinUrl: parsed.data.linkedinUrl,
    pageContent: parsed.data.pageContent,
    ...(parsed.data.extractorConfidence === undefined
      ? {}
      : { extractorConfidence: parsed.data.extractorConfidence }),
  });

  if (result.ok) revalidateQueue(parsed.data.businessSlug, parsed.data.leadId);

  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? (result.message ?? 'Profile captured. The existing lead was updated.') : undefined,
  };
}

const queueIdSchema = z.object({
  businessSlug: z.string().trim().min(1).max(120),
  queueId: z.string().uuid(),
});

/** Moves a pending item to in_progress when the operator starts working on it. */
export async function markInProgressAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = queueIdSchema.safeParse({
    businessSlug: formStringOrNull(formData, 'businessSlug'),
    queueId: formStringOrNull(formData, 'queueId'),
  });
  if (!parsed.success) return { ok: false, error: 'That queue item could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await markQueueInProgress(viewer, parsed.data.queueId);
  if (result.ok) revalidatePath(`/b/${parsed.data.businessSlug}/profile-queue`);
  return { ok: result.ok, error: result.error ?? null, message: result.ok ? 'Marked in progress.' : undefined };
}

const skipSchema = queueIdSchema.extend({ reason: z.string().trim().min(1).max(500) });

export async function skipQueueItemAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = skipSchema.safeParse({
    businessSlug: formStringOrNull(formData, 'businessSlug'),
    queueId: formStringOrNull(formData, 'queueId'),
    reason: formStringOrNull(formData, 'reason'),
  });
  if (!parsed.success) return { ok: false, error: 'Give a short reason for skipping this lead.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await skipQueueItem(viewer, parsed.data.queueId, parsed.data.reason);
  if (result.ok) revalidatePath(`/b/${parsed.data.businessSlug}/profile-queue`);
  return { ok: result.ok, error: result.error ?? null, message: result.ok ? 'Queue item skipped.' : undefined };
}

export async function retryQueueItemAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = queueIdSchema.safeParse({
    businessSlug: formStringOrNull(formData, 'businessSlug'),
    queueId: formStringOrNull(formData, 'queueId'),
  });
  if (!parsed.success) return { ok: false, error: 'That queue item could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await retryQueueItem(viewer, parsed.data.queueId);
  if (result.ok) revalidatePath(`/b/${parsed.data.businessSlug}/profile-queue`);
  return { ok: result.ok, error: result.error ?? null, message: result.ok ? 'Queued for another attempt.' : undefined };
}
