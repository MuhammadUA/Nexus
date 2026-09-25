'use server';

/**
 * Lead mutations.
 *
 * Every action resolves the viewer server-side and delegates to the repository,
 * which runs inside `withActor`. The `viewer.userId` a caller might send is never
 * trusted: the actor comes from the signed session cookie only.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { REPLY_OUTCOMES, LEAD_STATES } from '@nexus/core';
import { draftMessageForLead } from '@/lib/ai/drafting';
import { formString, formStringOrNull } from '@/lib/form-data';
import { authorizeAction } from '@/lib/route-guard';
import {
  addNote,
  captureReply,
  completeTask,
  createTask,
  markConnectionSent,
  markMessageSent,
  permanentDeleteLead,
  restoreLead,
  snoozeLead,
  softDeleteLead,
  startReactivation,
  updateLead,
} from '@/lib/repo/leads';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

const notSignedIn: ActionResult = { ok: false, error: 'Your session has expired. Sign in again.' };

async function withViewer(
  businessSlug: string,
  leadId: string,
  fn: (viewer: NonNullable<Awaited<ReturnType<typeof currentViewer>>>) => Promise<ActionResult>,
): Promise<ActionResult> {
  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await fn(viewer);
  if (result.ok) {
    // The lead screen and the queue both depend on this record.
    revalidatePath(`/b/${businessSlug}/leads/${leadId}`);
    revalidatePath(`/b/${businessSlug}/leads`);
    revalidatePath('/my-day');
  }
  return result;
}

const leadIdSchema = z.string().uuid();

const noteSchema = z.object({
  leadId: leadIdSchema,
  body: z.string().trim().min(1).max(8000),
});

export async function addNoteAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const parsed = noteSchema.safeParse({
    leadId: formStringOrNull(formData, 'leadId'),
    body: formStringOrNull(formData, 'body'),
  });
  if (!parsed.success) return { ok: false, error: 'Write a note first.' };

  return withViewer(formString(formData, 'businessSlug', ''), parsed.data.leadId, async (viewer) => {
    const result = await addNote(viewer, parsed.data.leadId, parsed.data.body);
    return { ok: result.ok, error: result.error ?? null, message: 'Note added.' };
  });
}

const taskSchema = z.object({
  leadId: leadIdSchema,
  title: z.string().trim().min(1).max(200),
  type: z.string().trim().min(1).max(40),
  dueAt: z.string().trim().max(40).nullish(),
  priority: z.string().trim().min(1).max(20),
  note: z.string().trim().max(2000).nullish(),
});

export async function createTaskAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const parsed = taskSchema.safeParse({
    leadId: formStringOrNull(formData, 'leadId'),
    title: formStringOrNull(formData, 'title'),
    type: formString(formData, 'type', 'follow_up'),
    dueAt: formStringOrNull(formData, 'dueAt'),
    priority: formString(formData, 'priority', 'normal'),
    note: formStringOrNull(formData, 'note'),
  });
  if (!parsed.success) return { ok: false, error: 'Give the task a title.' };

  const dueRaw = parsed.data.dueAt;
  const dueAt = dueRaw != null && dueRaw.length > 0 ? new Date(dueRaw).toISOString() : null;

  return withViewer(formString(formData, 'businessSlug', ''), parsed.data.leadId, async (viewer) => {
    const result = await createTask(viewer, {
      leadId: parsed.data.leadId ?? undefined,
      title: parsed.data.title ?? undefined,
      type: parsed.data.type ?? undefined,
      dueAt,
      priority: parsed.data.priority ?? undefined,
      note: parsed.data.note ?? null,
    });
    return { ok: result.ok, error: result.error ?? null, message: 'Task created.' };
  });
}

export async function completeTaskAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const leadId = formString(formData, 'leadId', '');
  const taskId = formString(formData, 'taskId', '');
  if (!leadIdSchema.safeParse(leadId).success || !leadIdSchema.safeParse(taskId).success) {
    return { ok: false, error: 'That task could not be found.' };
  }

  return withViewer(formString(formData, 'businessSlug', ''), leadId, async (viewer) => {
    const result = await completeTask(viewer, taskId);
    return { ok: result.ok, error: result.error ?? null, message: 'Task completed.' };
  });
}

const replySchema = z.object({
  leadId: leadIdSchema,
  exactText: z.string().min(1).max(20_000),
  outcome: z.enum(REPLY_OUTCOMES),
  note: z.string().max(4000).nullish(),
});

/**
 * spec `reply_and_notes`: the exact inbound text is stored verbatim, the outcome is
 * classified, the internal note is kept separate, and the sequence pauses.
 */
export async function captureReplyAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const parsed = replySchema.safeParse({
    leadId: formStringOrNull(formData, 'leadId'),
    exactText: formStringOrNull(formData, 'exactText'),
    outcome: formStringOrNull(formData, 'outcome'),
    note: formStringOrNull(formData, 'note'),
  });
  if (!parsed.success) return { ok: false, error: 'Paste the exact reply and choose an outcome.' };

  return withViewer(formString(formData, 'businessSlug', ''), parsed.data.leadId, async (viewer) => {
    const result = await captureReply(viewer, {
      leadId: parsed.data.leadId ?? undefined,
      exactText: parsed.data.exactText ?? undefined,
      outcome: parsed.data.outcome ?? undefined,
      note: parsed.data.note ?? null,
    });
    return {
      ok: result.ok,
      error: result.error ?? null,
      message: result.ok ? 'Reply recorded. Pending steps were paused.' : undefined,
    };
  });
}

export async function snoozeAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const leadId = formString(formData, 'leadId', '');
  const until = formString(formData, 'until', '');
  const reason = formString(formData, 'reason', '');
  if (!leadIdSchema.safeParse(leadId).success || until.length === 0) {
    return { ok: false, error: 'Choose when to be reminded.' };
  }

  return withViewer(formString(formData, 'businessSlug', ''), leadId, async (viewer) => {
    const result = await snoozeLead(viewer, {
      leadId,
      until: new Date(until).toISOString(),
      reason: reason.length === 0 ? null : reason,
    });
    return { ok: result.ok, error: result.error ?? null, message: 'Snoozed.' };
  });
}

export async function connectionSentAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const leadId = formString(formData, 'leadId', '');
  const identityId = formString(formData, 'identityId', '');
  const withNote = formString(formData, 'withNote', 'false') === 'true';

  if (!leadIdSchema.safeParse(leadId).success || !leadIdSchema.safeParse(identityId).success) {
    return { ok: false, error: 'Choose the sender identity that sent the connection.' };
  }

  return withViewer(formString(formData, 'businessSlug', ''), leadId, async (viewer) => {
    const result = await markConnectionSent(viewer, leadId, identityId, withNote);
    return { ok: result.ok, error: result.error ?? null, message: 'Connection marked sent.' };
  });
}

export async function messageSentAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const leadId = formString(formData, 'leadId', '');
  const instanceId = formString(formData, 'messageInstanceId', '');
  const identityId = formString(formData, 'identityId', '');

  if (
    !leadIdSchema.safeParse(leadId).success ||
    !leadIdSchema.safeParse(instanceId).success ||
    !leadIdSchema.safeParse(identityId).success
  ) {
    return { ok: false, error: 'This step cannot be marked sent without a sender identity.' };
  }

  return withViewer(formString(formData, 'businessSlug', ''), leadId, async (viewer) => {
    const result = await markMessageSent(viewer, instanceId, identityId);
    return {
      ok: result.ok,
      error: result.error ?? null,
      message: result.ok ? 'Marked sent. The message content is now immutable.' : undefined,
    };
  });
}

const editSchema = z.object({
  leadId: leadIdSchema,
  primaryIcpId: z.string().uuid().nullish(),
  ownerUserId: z.string().uuid().nullish(),
  outreachIdentityId: z.string().uuid().nullish(),
  status: z.enum(LEAD_STATES).nullish(),
});

export async function updateLeadAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const parsed = editSchema.safeParse({
    leadId: formStringOrNull(formData, 'leadId'),
    primaryIcpId: formStringOrNull(formData, 'primaryIcpId') || undefined,
    ownerUserId: formStringOrNull(formData, 'ownerUserId') || undefined,
    outreachIdentityId: formStringOrNull(formData, 'outreachIdentityId') || undefined,
    status: formStringOrNull(formData, 'status') || undefined,
  });
  if (!parsed.success) return { ok: false, error: 'Some of those values are not valid.' };

  return withViewer(formString(formData, 'businessSlug', ''), parsed.data.leadId, async (viewer) => {
    // Only include keys the operator actually chose, so an empty select means
    // "leave unchanged" rather than "clear this field".
    const result = await updateLead(viewer, parsed.data.leadId, {
      ...(parsed.data.primaryIcpId === undefined ? {} : { primaryIcpId: parsed.data.primaryIcpId }),
      ...(parsed.data.ownerUserId === undefined ? {} : { ownerUserId: parsed.data.ownerUserId }),
      ...(parsed.data.outreachIdentityId === undefined
        ? {}
        : { outreachIdentityId: parsed.data.outreachIdentityId }),
      ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
    });
    return { ok: result.ok, error: result.error ?? null, message: 'Lead updated.' };
  });
}

export async function softDeleteAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const leadId = formString(formData, 'leadId', '');
  if (!leadIdSchema.safeParse(leadId).success) return { ok: false, error: 'That lead could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await softDeleteLead(viewer, leadId);
  if (result.ok) {
    revalidatePath(`/b/${formString(formData, 'businessSlug', '')}/leads`);
    revalidatePath('/my-day');
  }
  return { ok: result.ok, error: result.error ?? null, message: 'Moved to Trash.' };
}

export async function restoreLeadAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const leadId = formString(formData, 'leadId', '');
  if (!leadIdSchema.safeParse(leadId).success) return { ok: false, error: 'That lead could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await restoreLead(viewer, leadId);
  if (result.ok) revalidatePath(`/b/${formString(formData, 'businessSlug', '')}/trash`);
  return { ok: result.ok, error: result.error ?? null, message: 'Lead restored.' };
}

export async function permanentDeleteAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const leadId = formString(formData, 'leadId', '');
  const confirmation = formString(formData, 'confirmation', '');
  if (!leadIdSchema.safeParse(leadId).success) return { ok: false, error: 'That lead could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return notSignedIn;

  const result = await permanentDeleteLead(viewer, leadId, confirmation);
  if (result.ok) revalidatePath(`/b/${formString(formData, 'businessSlug', '')}/trash`);
  return { ok: result.ok, error: result.error ?? null, message: 'Lead permanently deleted.' };
}

export async function reactivateAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const leadId = formString(formData, 'leadId', '');
  if (!leadIdSchema.safeParse(leadId).success) return { ok: false, error: 'That lead could not be found.' };

  return withViewer(formString(formData, 'businessSlug', ''), leadId, async (viewer) => {
    const result = await startReactivation(viewer, leadId);
    return { ok: result.ok, error: result.error ?? null, message: 'Reactivation opened.' };
  });
}

/**
 * Generates a draft for one message instance.
 *
 * The generated body is validated against the messaging rules before anything is written, so a draft
 * that asserts an unapproved claim or misses its personalization signal is rejected rather than
 * stored. Refusals are reported with the provider's own reason, because "the AI is rate limited" and
 * "the AI is not configured" need different responses from the operator.
 */
export async function draftMessageAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const leadId = formString(formData, 'leadId', '');
  const messageInstanceId = formString(formData, 'messageInstanceId', '');
  const businessId = formString(formData, 'businessId', '');

  if (!leadIdSchema.safeParse(leadId).success || !leadIdSchema.safeParse(messageInstanceId).success) {
    return { ok: false, error: 'That message is not available for drafting.' };
  }

  // A Server Action is a public endpoint, so it repeats the check its page performs. The business
  // scope is required: `lead.view_all` for one business must not authorise drafting in another.
  const refusal = await authorizeAction(null, {
    route: '/b/:businessSlug/leads/:leadId',
    businessId: businessId.length > 0 ? businessId : null,
  });
  if (refusal !== null) return { ok: false, error: refusal.error };

  return withViewer(formString(formData, 'businessSlug', ''), leadId, async (viewer) => {
    const outcome = await draftMessageForLead(viewer, { messageInstanceId });
    if (!outcome.ok) return { ok: false, error: outcome.error };
    return {
      ok: true,
      error: null,
      message: `Draft generated (${String(outcome.draft.wordCount)} words, ${outcome.draft.provenance.model}).`,
    };
  });
}
