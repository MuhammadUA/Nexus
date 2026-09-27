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
import { acceptDraftVersion, draftMessageForLead } from '@/lib/ai/drafting';
import type { DraftErrorCode } from '@/lib/ai/draft-outcome';
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

/**
 * `ActionResult` plus the detail a drafting control needs, following the contract's rule that a
 * refusal which is really a different screen state carries a stable code (§2.1).
 *
 * `errorCode` is the closed `DraftErrorCode` vocabulary from `lib/ai/draft-outcome`, which also owns
 * how each code reads to the operator. Nothing here can carry a secret: `error` is the provider
 * layer's operator-safe sentence, `issues` names schema fields and rule codes only, and no field holds
 * a key, a base URL or an upstream body.
 */
export interface DraftActionResult extends ActionResult {
  /** Present whenever the refusal is a state the control renders differently. */
  readonly errorCode?: DraftErrorCode;
  /** Whether another attempt could plausibly succeed. */
  readonly retryable?: boolean;
  /** Rule/field codes when the model's answer was unusable. Never content. */
  readonly issues?: readonly string[];
  /** The version the draft was stored as, so the operator can accept it. */
  readonly draft?: {
    readonly body: string;
    readonly wordCount: number;
    readonly model: string;
    readonly messageVersionId: string;
  };
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

/**
 * `withViewer` for the drafting actions, whose result carries more than `ActionResult`.
 *
 * A separate helper rather than a generic `withViewer`: the signed-out result of a generic version
 * would need a type assertion to satisfy the caller's narrower result type, and asserting here is
 * exactly the kind of shortcut that hides a real mismatch later.
 */
async function withDraftViewer(
  businessSlug: string,
  leadId: string,
  fn: (viewer: NonNullable<Awaited<ReturnType<typeof currentViewer>>>) => Promise<DraftActionResult>,
): Promise<DraftActionResult> {
  const viewer = await currentViewer();
  if (viewer === null) {
    return { ok: false, error: 'Your session has expired. Sign in again.', errorCode: 'session_expired' };
  }

  const result = await fn(viewer);
  if (result.ok) {
    revalidatePath(`/b/${businessSlug}/leads/${leadId}`);
    revalidatePath(`/b/${businessSlug}/leads`);
    revalidatePath('/my-day');
  }
  return result;
}

/**
 * The route requirement the drafting actions repeat.
 *
 * Resolved from the same matrix the page uses, so the control is offered to exactly the viewers the
 * action will serve. `businessId` comes from the form and is only ever *checked* against the grant; a
 * missing one denies rather than falling back to the union of the operator's businesses.
 */
const LEAD_DETAIL_ROUTE = '/b/:businessSlug/leads/:leadId';

async function draftRouteRefusal(businessId: string): Promise<{ readonly ok: false; readonly error: string } | null> {
  return authorizeAction(null, {
    route: LEAD_DETAIL_ROUTE,
    businessId: businessId.length > 0 ? businessId : null,
  });
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
 * stored. Every refusal is returned with the provider's own `kind`, because "the AI is rate limited",
 * "the AI is not configured" and "the model wrote something unusable" need different responses from
 * the operator — and, for the last two, the reassurance that nothing was stored.
 *
 * Context is loaded server-side from the ids in the form: the business, the lead, the message
 * instance and its step, the personalization signal, and the approved/AI-usable knowledge assets.
 * Nothing secret travels in either direction.
 */
export async function draftMessageAction(
  _previous: DraftActionResult,
  formData: FormData,
): Promise<DraftActionResult> {
  const leadId = formString(formData, 'leadId', '');
  const messageInstanceId = formString(formData, 'messageInstanceId', '');
  const businessId = formString(formData, 'businessId', '');

  if (!leadIdSchema.safeParse(leadId).success || !leadIdSchema.safeParse(messageInstanceId).success) {
    return { ok: false, error: 'That message is not available for drafting.', errorCode: 'invalid_input' };
  }

  // A Server Action is a public endpoint, so it repeats the check its page performs. The business
  // scope is required: `lead.view_all` for one business must not authorise drafting in another.
  const refusal = await draftRouteRefusal(businessId);
  if (refusal !== null) return { ok: false, error: refusal.error, errorCode: 'permission_denied' };

  return withDraftViewer(formString(formData, 'businessSlug', ''), leadId, async (viewer) => {
    const outcome = await draftMessageForLead(viewer, { messageInstanceId });
    if (!outcome.ok) {
      return {
        ok: false,
        error: outcome.error,
        errorCode: outcome.kind,
        retryable: outcome.retryable,
        ...(outcome.issues === undefined ? {} : { issues: outcome.issues }),
      };
    }

    // The generation succeeded but the version was not written: the instance became SENT between the
    // read and the write. Reported as a refusal rather than a success, because the body the model
    // produced exists nowhere the operator can send it from.
    if (outcome.messageVersionId === null) {
      return {
        ok: false,
        error: 'This message has already been sent, so the draft was not stored.',
        errorCode: 'invalid_input',
      };
    }

    return {
      ok: true,
      error: null,
      message: `Draft stored as a new version (${String(outcome.draft.wordCount)} words, ${outcome.draft.provenance.model}). Accept it, or regenerate for another.`,
      draft: {
        body: outcome.draft.body,
        wordCount: outcome.draft.wordCount,
        model: outcome.draft.provenance.model,
        messageVersionId: outcome.messageVersionId,
      },
    };
  });
}

/**
 * Records the operator's acceptance of a generated draft.
 *
 * The body is already a stored version — generation writes it and repoints the instance — so this
 * action adds the durable, attributed record that a person accepted the AI's wording, which is the
 * part a later audit needs. It refuses when the version is no longer current, so an acceptance cannot
 * be attached to a draft that has since been replaced or sent.
 */
export async function acceptDraftAction(
  _previous: DraftActionResult,
  formData: FormData,
): Promise<DraftActionResult> {
  const leadId = formString(formData, 'leadId', '');
  const messageInstanceId = formString(formData, 'messageInstanceId', '');
  const messageVersionId = formString(formData, 'messageVersionId', '');
  const businessId = formString(formData, 'businessId', '');

  if (
    !leadIdSchema.safeParse(leadId).success ||
    !leadIdSchema.safeParse(messageInstanceId).success ||
    !leadIdSchema.safeParse(messageVersionId).success
  ) {
    return { ok: false, error: 'That draft is not available.', errorCode: 'invalid_input' };
  }

  const refusal = await draftRouteRefusal(businessId);
  if (refusal !== null) return { ok: false, error: refusal.error, errorCode: 'permission_denied' };

  return withDraftViewer(formString(formData, 'businessSlug', ''), leadId, async (viewer) => {
    const result = await acceptDraftVersion(viewer, { instanceId: messageInstanceId, versionId: messageVersionId });
    if (!result.ok) return { ok: false, error: result.error, errorCode: 'invalid_input' };
    return {
      ok: true,
      error: null,
      message: 'Draft accepted and kept as the current version. Recorded in the audit trail.',
    };
  });
}
