'use server';

/**
 * U16 — Profile Queue.
 *
 * Contract: "Work partial leads by opening LinkedIn, capturing URL + full profile content,
 * updating existing lead."
 *
 * spec `lead_sources.profile_queue_flow`: "... update the existing partial lead rather
 * than creating a new lead." The capture itself is `lib/repo/profile-queue.ts`'s
 * `captureProfile`, which re-plans the capture inside its own transaction and never inserts
 * a person or a lead — this file only validates the form and reports what happened.
 *
 * profile_queue.use gates the controls; the database enforces the same grant again.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { captureProfile, markQueueInProgress, skipQueueItem } from '@/lib/repo/profile-queue';
import { formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const notSignedIn: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

const captureSchema = z.object({
  queueId: z.string().uuid(),
  leadId: z.string().uuid(),
  linkedinUrl: z.string().trim().min(1).max(400),
  pageContent: z.string().trim().min(20, 'Paste the profile content you copied.').max(100_000),
});

export async function captureProfileAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = captureSchema.safeParse({
    queueId: formStringOrNull(formData, 'queueId'),
    leadId: formStringOrNull(formData, 'leadId'),
    linkedinUrl: formStringOrNull(formData, 'linkedinUrl'),
    pageContent: formStringOrNull(formData, 'pageContent'),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message;
    return {
      ok: false,
      error:
        issue !== undefined && issue.length > 0 && issue !== 'Invalid input'
          ? issue
          : 'Paste the LinkedIn profile URL and the copied profile content.',
    };
  }

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await captureProfile(viewer, {
    leadId: parsed.data.leadId ?? undefined,
    linkedinUrl: parsed.data.linkedinUrl ?? undefined,
    pageContent: parsed.data.pageContent ?? undefined,
  });

  if (result.ok) {
    revalidatePath('/my-profile-queue');
    revalidatePath('/my-leads');
    revalidatePath('/my-day');
    revalidatePath(`/leads/${parsed.data.leadId}`);
    return {
      ok: true,
      error: null,
      message: 'Profile captured. The existing lead was updated and no new lead was created.',
    };
  }

  return { ok: false, error: result.error ?? 'The capture was refused.' };
}

const queueIdSchema = z.object({ queueId: z.string().uuid() });

/** Claims a queue item while the operator works it, so a second operator sees it is taken. */
export async function claimQueueItemAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = queueIdSchema.safeParse({ queueId: formStringOrNull(formData, 'queueId') });
  if (!parsed.success) return { ok: false, error: 'That queue item could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await markQueueInProgress(viewer, parsed.data.queueId);
  if (result.ok) revalidatePath('/my-profile-queue');
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Marked in progress.' : undefined,
  };
}

const skipSchema = z.object({
  queueId: z.string().uuid(),
  reason: z.string().trim().min(1, 'Give a reason for skipping this lead.').max(500),
});

/**
 * Skips a queue item.
 *
 * A skipped item is not deleted: the lead keeps `needs_profile`, so the partial record and
 * the reason stay visible instead of the work disappearing.
 */
export async function skipQueueItemAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = skipSchema.safeParse({
    queueId: formStringOrNull(formData, 'queueId'),
    reason: formStringOrNull(formData, 'reason'),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message;
    return { ok: false, error: issue ?? 'Give a reason for skipping this lead.' };
  }

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await skipQueueItem(viewer, parsed.data.queueId, parsed.data.reason);
  if (result.ok) revalidatePath('/my-profile-queue');
  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Queue item skipped.' : undefined,
  };
}
