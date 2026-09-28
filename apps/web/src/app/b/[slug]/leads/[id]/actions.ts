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
import {
  AGENT_JOB_PRIORITIES,
  AGENT_JOB_TYPES,
  DISCOVERY_SOURCES,
  LEAD_STATES,
  REPLY_OUTCOMES,
  searchLinks,
  slugify,
  type Permission,
} from '@nexus/core';
import { acceptDraftVersion, draftMessageForLead } from '@/lib/ai/drafting';
import type { DraftErrorCode } from '@/lib/ai/draft-outcome';
import { enrichProfileFromPaste } from '@/lib/ai/extract';
import { formString, formStringOrNull } from '@/lib/form-data';
import { authorizeAction } from '@/lib/route-guard';
import { chainJobsForLead, createAgentJob } from '@/lib/repo/agent-jobs';
import { asNumber, asString, asStringArray, describeDbError, read } from '@/lib/repo/common';
import { recomputeLeadEnrichment } from '@/lib/repo/enrichment';
import { submitIngest } from '@/lib/repo/ingest';
import { loadViewerContext } from '@/lib/viewer-context';
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

/* ============================================================================
 * V1.2 enrichment actions (§31, §68.3, §69)
 *
 * Four rules hold for every action below, and they are the same rules the drafting
 * actions already follow:
 *
 *   1. **A Server Action is a public endpoint.** Each one re-resolves the viewer from the
 *      session cookie and re-checks both the route requirement its page declares *and* the
 *      fine-grained capability the operation needs, scoped to the business named in the
 *      form. Hiding a button is not authorization; neither is RLS on its own, because "the
 *      database refused it" needs a fixture to test and is invisible in the action's code.
 *   2. **Raw paste is never echoed.** `enrichProfileAction` never returns the text the
 *      operator pasted, never includes it in an error and never logs it. The refusal
 *      sentence is derived from the *error code* through a closed map, so even a provider
 *      that echoed the request body could not put it on the screen (§32.2.1/§32.2.6).
 *   3. **Nothing runs on render.** Every model call and every job creation happens inside
 *      one of these actions, never during a page render (§76.1).
 *   4. **The result is operator-shaped.** Each action returns something the form can
 *      render: what happened, whether a job was created or reused, and — for a new lead —
 *      the stored enrichment state plus the deterministic next search.
 * ========================================================================== */

/**
 * The one refusal sentence for a missing capability.
 *
 * Naming the permission would tell a caller which capability to go looking for, and the
 * difference between "you may not" and "that does not exist" is itself a disclosure — the
 * same reasoning `authorizeAction` uses.
 */
const CAPABILITY_REFUSAL: { readonly ok: false; readonly error: string } = {
  ok: false,
  error: 'You do not have permission to do that.',
};

/**
 * The result of a capability check: the **already-resolved** viewer, or one refusal sentence.
 *
 * The viewer context is resolved once and handed to `authorizeAction`, rather than letting the
 * guard resolve a second context of its own and the action resolve a third: §76.4 forbids a
 * second, per-component resolution of the same data.
 */
type CapabilityCheck =
  | { readonly ok: true; readonly viewer: NonNullable<Awaited<ReturnType<typeof currentViewer>>> }
  | { readonly ok: false; readonly error: string };

async function checkCapability(
  businessId: string | null,
  permissions: readonly Permission[],
  route: string = LEAD_DETAIL_ROUTE,
): Promise<CapabilityCheck> {
  const context = await loadViewerContext();
  const refusal = await authorizeAction(context, {
    route,
    businessId: businessId !== null && businessId.length > 0 ? businessId : null,
  });
  if (refusal !== null) return refusal;
  for (const permission of permissions) {
    if (!context.permissions.has(permission)) return CAPABILITY_REFUSAL;
  }
  return { ok: true, viewer: context.viewer };
}

/** Revalidates everything a lead change is visible on. */
function revalidateLead(businessSlug: string, leadId: string): void {
  revalidatePath(`/b/${businessSlug}/leads/${leadId}`);
  revalidatePath(`/b/${businessSlug}/leads`);
  revalidatePath('/my-day');
}

/* ------------------------------------------------------ profile enrichment -- */

export interface EnrichProfileActionResult extends ActionResult {
  /** Stable machine code — a code, never the provider's own text (§15.3). */
  readonly errorCode?: string;
  /** Structured field names the extraction committed. Never content. */
  readonly applied?: readonly string[];
  /** Field names that conflicted with a user-confirmed value (§66.2). */
  readonly review?: readonly string[];
  /** True when the staged raw body was deleted after the verified commit. */
  readonly rawDeleted?: boolean;
  /** True when a failed attempt left the staged body in place for a retry (§32.2.5). */
  readonly rawRetained?: boolean;
}

/**
 * Operator-safe sentences for the extraction's failure vocabulary.
 *
 * Deliberately a closed map keyed by code. `enrichProfileFromPaste` returns a sentence of
 * its own, but that sentence is *provider-adjacent* text, and the rule here is absolute: the
 * pasted body must never reach the screen or a log. A code with no entry gets a generic
 * refusal rather than a pass-through.
 */
const ENRICH_REFUSALS: Readonly<Record<string, string>> = {
  provider_not_configured:
    'No AI provider is configured on this deployment. The URL and manual edits still work, and nothing was committed.',
  provider_rate_limited: 'The AI provider is throttling requests. Nothing was committed; try again shortly.',
  provider_error: 'The AI provider could not be reached. Nothing was committed.',
  provider_timeout: 'The AI provider timed out. Nothing was committed.',
  invalid_answer: 'The extraction did not match the required structure, so nothing was committed.',
  ungrounded_answer: 'The extraction quoted nothing from the staged text, so nothing was committed.',
  schema_invalid: 'The extraction did not match the required structure, so nothing was committed.',
  commit_failed: 'The structured commit was refused, so nothing was written.',
  no_staged_raw: 'There was no staged text to extract from.',
  invalid_input: 'Paste the profile text and give the LinkedIn profile URL.',
};

function enrichRefusal(code: string): string {
  return ENRICH_REFUSALS[code] ?? 'The extraction was refused and nothing was committed.';
}

const enrichSchema = z.object({
  leadId: leadIdSchema,
  businessId: z.string().uuid(),
  linkedinUrl: z.string().trim().url().max(2048),
  /**
   * The staged body. Bounded because `raw_staging` is bounded (400k characters, enforced by
   * the database too) — the ceiling belongs at the edge so an oversized paste is refused
   * before it is transmitted rather than after.
   */
  pastedContent: z.string().trim().min(20).max(400_000),
});

/**
 * §31.1 step 6 — *Enrich with AI*.
 *
 * The raw lifecycle belongs to `enrichProfileFromPaste`: it stages the text, extracts,
 * validates, commits the grounded facts, deletes the staged row and advances the state.
 * This action only validates the input, authorises it, and maps the outcome to something a
 * form can render — it never touches `raw_staging` itself and never re-displays the body.
 */
export async function enrichProfileAction(
  _previous: EnrichProfileActionResult,
  formData: FormData,
): Promise<EnrichProfileActionResult> {
  const parsed = enrichSchema.safeParse({
    leadId: formStringOrNull(formData, 'leadId'),
    businessId: formStringOrNull(formData, 'businessId'),
    linkedinUrl: formStringOrNull(formData, 'linkedinUrl'),
    pastedContent: formStringOrNull(formData, 'pastedContent'),
  });
  if (!parsed.success) {
    return { ok: false, error: enrichRefusal('invalid_input'), errorCode: 'invalid_input' };
  }

  // Facts are changing, and the extraction stages raw text: both capabilities are required.
  const check = await checkCapability(parsed.data.businessId, ['lead.update', 'lead_source.use']);
  if (!check.ok) return { ok: false, error: check.error, errorCode: 'permission_denied' };

  const businessSlug = formString(formData, 'businessSlug', '');
  let outcome: Awaited<ReturnType<typeof enrichProfileFromPaste>>;
  try {
    outcome = await enrichProfileFromPaste(check.viewer, {
      leadId: parsed.data.leadId,
      linkedinUrl: parsed.data.linkedinUrl,
      pastedContent: parsed.data.pastedContent,
      sourceType: 'profile_paste',
      sourceUrl: parsed.data.linkedinUrl,
    });
  } catch (error) {
    return { ok: false, error: describeActionError(error), errorCode: 'extraction_failed' };
  }

  if (!outcome.ok) {
    return {
      ok: false,
      error: enrichRefusal(outcome.errorCode),
      errorCode: outcome.errorCode,
      rawRetained: outcome.rawRetained,
    };
  }

  revalidateLead(businessSlug, parsed.data.leadId);

  return {
    ok: true,
    error: null,
    applied: outcome.applied,
    review: outcome.review,
    rawDeleted: outcome.rawDeleted,
    message:
      outcome.review.length === 0
        ? 'Enriched from the pasted profile.'
        : 'Enriched, with values that need a review decision.',
  };
}

/* --------------------------------------------------------- company research -- */

export interface ResearchCompanyActionResult extends ActionResult {
  /** Job types this call actually created. */
  readonly created: readonly string[];
  /** Job types that were already in flight and were reused rather than duplicated (§42.5). */
  readonly alreadyOpen: readonly string[];
}

/**
 * §68.3 / §31.1 step 7 — *Research Company*.
 *
 * It calls `chainJobsForLead`, which plans the outstanding hops for this lead and skips any
 * whose dedupe key is already live, then reports the split the operator actually cares
 * about: what this click created, and what was already open.
 */
export async function researchCompanyAction(
  _previous: ResearchCompanyActionResult,
  formData: FormData,
): Promise<ResearchCompanyActionResult> {
  const leadId = formString(formData, 'leadId', '');
  const businessId = formString(formData, 'businessId', '');
  if (!leadIdSchema.safeParse(leadId).success || !leadIdSchema.safeParse(businessId).success) {
    return { ok: false, error: 'That lead could not be found.', created: [], alreadyOpen: [] };
  }

  const check = await checkCapability(businessId, ['lead.update']);
  if (!check.ok) return { ok: false, error: check.error, created: [], alreadyOpen: [] };

  const businessSlug = formString(formData, 'businessSlug', '');

  try {
    const results = await chainJobsForLead(check.viewer, { businessId, leadId });
    const created = results.filter((entry) => entry.created).map((entry) => entry.jobType);
    const alreadyOpen = results.filter((entry) => !entry.created).map((entry) => entry.jobType);

    revalidateLead(businessSlug, leadId);

    return {
      ok: true,
      error: null,
      created,
      alreadyOpen,
      message:
        created.length > 0
          ? `Created ${created.join(', ')}. The job waits durably for an agent; this page does not block.`
          : alreadyOpen.length > 0
            ? `A job was already open (${alreadyOpen.join(', ')}), so it was reused rather than duplicated.`
            : 'No research job is outstanding for this lead: the chain has nothing left to plan.',
    };
  } catch (error) {
    return {
      ok: false,
      error: describeActionError(error),
      created: [],
      alreadyOpen: [],
    };
  }
}

/**
 * A sentence for an unexpected throw, without a stack or a SQL body.
 *
 * A driver error carries `code`/`detail`/`hint` and its `message` can embed the failing
 * statement and its bound parameter values, so it goes through `describeDbError`, which
 * whitelists the safe fields and logs the rest. Anything else is a sentence this codebase
 * wrote for an operator, bounded so a payload could not pass as one.
 */
function describeActionError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return describeDbError(error);
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.length <= 300 ? error.message : 'The request could not be completed.';
  }
  return 'The request could not be completed.';
}

/* -------------------------------------------------------- recompute / jobs -- */

/** §29.3 — recomputes the stored score and missing fields in one transaction. */
export async function recomputeEnrichmentAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const leadId = formString(formData, 'leadId', '');
  const businessId = formString(formData, 'businessId', '');
  if (!leadIdSchema.safeParse(leadId).success || !leadIdSchema.safeParse(businessId).success) {
    return { ok: false, error: 'That lead could not be found.' };
  }

  const check = await checkCapability(businessId, ['lead.update']);
  if (!check.ok) return { ok: false, error: check.error };

  const businessSlug = formString(formData, 'businessSlug', '');

  try {
    const result = await recomputeLeadEnrichment(check.viewer, leadId);
    if (!result.ok) return { ok: false, error: result.error };
    revalidateLead(businessSlug, leadId);
    return {
      ok: true,
      error: null,
      message: `Recomputed: ${result.status} at ${String(result.completenessScore)}%${
        result.missingFields.length === 0 ? '' : ` (missing ${result.missingFields.join(', ')})`
      }.`,
    };
  } catch (error) {
    return { ok: false, error: describeActionError(error) };
  }
}

const agentJobSchema = z.object({
  leadId: leadIdSchema,
  businessId: z.string().uuid(),
  jobType: z.enum(AGENT_JOB_TYPES),
  priority: z.enum(AGENT_JOB_PRIORITIES),
  reason: z.string().trim().max(300).nullish(),
});

/**
 * §68.3 *Create Agent Job* — one explicit job type, chosen by a person.
 *
 * Priority is a caller choice recorded on the row; the action never invents one, and it
 * cannot reach `COMPLETE`: completion belongs to the verified commit (§41.3), which no
 * product action can shortcut.
 */
export async function createAgentJobAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = agentJobSchema.safeParse({
    leadId: formStringOrNull(formData, 'leadId'),
    businessId: formStringOrNull(formData, 'businessId'),
    jobType: formString(formData, 'jobType', 'OTHER'),
    priority: formString(formData, 'priority', 'normal'),
    reason: formStringOrNull(formData, 'reason'),
  });
  if (!parsed.success) return { ok: false, error: 'Choose a job type for this lead.' };

  const check = await checkCapability(parsed.data.businessId, ['lead.update']);
  if (!check.ok) return { ok: false, error: check.error };

  const businessSlug = formString(formData, 'businessSlug', '');

  try {
    const result = await createAgentJob(check.viewer, {
      businessId: parsed.data.businessId,
      jobType: parsed.data.jobType,
      leadId: parsed.data.leadId,
      priority: parsed.data.priority,
      reason: parsed.data.reason ?? 'Requested from the Leads screen',
    });
    revalidateLead(businessSlug, parsed.data.leadId);
    return {
      ok: true,
      error: null,
      message: result.created
        ? `Created a ${parsed.data.jobType.replace(/_/g, ' ').toLowerCase()} job.`
        : `A ${parsed.data.jobType.replace(/_/g, ' ').toLowerCase()} job is already open, so it was reused.`,
    };
  } catch (error) {
    return { ok: false, error: describeActionError(error) };
  }
}

/* ------------------------------------------------------------- add lead (§2) -- */

export interface CreatedLeadSummary {
  readonly leadId: string;
  readonly personName: string;
  readonly leadHref: string;
  /** The **stored** enrichment state. A missing row reads as MINIMAL with 0 (§68.2). */
  readonly enrichmentState: string;
  readonly completenessScore: number;
  readonly missingFields: readonly string[];
  /** The deterministic `find_linkedin` link (§30.2), or null with the reason why. */
  readonly findLinkedinUrl: string | null;
  readonly findLinkedinQuery: string | null;
  readonly findLinkedinBlockedReason: string | null;
}

export interface CreateLeadResult extends ActionResult {
  readonly created?: CreatedLeadSummary;
  /** True when the idempotency key had already been applied, so nothing was written twice. */
  readonly idempotent?: boolean;
}

const createLeadSchema = z.object({
  businessId: z.string().uuid(),
  fullName: z.string().trim().min(1).max(200),
  companyName: z.string().trim().max(200).nullish(),
  location: z.string().trim().max(200).nullish(),
  source: z.enum(DISCOVERY_SOURCES),
  sourceUrl: z.string().trim().max(2048).nullish(),
  jobTitle: z.string().trim().max(200).nullish(),
  headline: z.string().trim().max(500).nullish(),
  snippet: z.string().trim().max(2000).nullish(),
});

/** The `source_client` this path submits under, so the ledger names the web UI. */
const WEB_LEAD_SOURCE_CLIENT = 'web:leads-add';

/**
 * §2 — create a Lead from a name, and optionally a company, location and source.
 *
 * The insert is **not** performed here. `submitIngest` is the audited pipeline that
 * validates, normalises, dedupes the person, persists the source evidence, applies the
 * business/ICP rules, creates or updates the lead and writes the audit event — and it is
 * what lets the `leads_seed_enrichment` trigger create the `lead_enrichment` row. Writing
 * `leads`/`people`/`companies` directly would skip every one of those steps, which is
 * exactly the defect §8 warns about.
 *
 * The idempotency key is derived from the submitted identity and the day, so a double
 * submit (or a reload-and-resubmit) is a true replay that writes nothing, while a
 * deliberate re-add on a later day is processed again and deduped by person rather than
 * creating a second lead. No AI call is made on this path.
 */
export async function createLeadAction(
  _previous: CreateLeadResult,
  formData: FormData,
): Promise<CreateLeadResult> {
  const parsed = createLeadSchema.safeParse({
    businessId: formStringOrNull(formData, 'businessId'),
    fullName: formStringOrNull(formData, 'fullName'),
    companyName: formStringOrNull(formData, 'companyName'),
    location: formStringOrNull(formData, 'location'),
    source: formString(formData, 'source', 'manual'),
    sourceUrl: formStringOrNull(formData, 'sourceUrl'),
    jobTitle: formStringOrNull(formData, 'jobTitle'),
    headline: formStringOrNull(formData, 'headline'),
    snippet: formStringOrNull(formData, 'snippet'),
  });
  if (!parsed.success) return { ok: false, error: 'Give the lead a full name.' };

  const sourceUrl = parsed.data.sourceUrl ?? null;
  if (sourceUrl !== null && !/^https?:\/\//i.test(sourceUrl)) {
    return { ok: false, error: 'The source URL must start with http:// or https://.' };
  }

  const check = await checkCapability(
    parsed.data.businessId,
    ['lead.create', 'lead_source.use'],
    '/b/:businessSlug/leads',
  );
  if (!check.ok) return { ok: false, error: check.error };

  const viewer = check.viewer;
  const businessSlug = formString(formData, 'businessSlug', '');
  const observedAt = new Date().toISOString();

  /*
   * The payload names the fields the pipeline reads (`full_name`, `company_name`,
   * `job_title`, `location`, `source_url`) plus the V1.2 discovery source, headline and
   * snippet, which travel with the ingest request so the recording is complete. The
   * pipeline writes `leads.source_type = 'external_ingest'` for this path — the V1
   * vocabulary — and §18.3 is still `> OPEN:` about how the V1.2 list is persisted, so the
   * chosen source is carried here rather than being asserted into a column that would
   * reject it.
   */
  const payload = {
    full_name: parsed.data.fullName,
    company_name: parsed.data.companyName ?? null,
    location: parsed.data.location ?? null,
    job_title: parsed.data.jobTitle ?? null,
    headline: parsed.data.headline ?? null,
    snippet: parsed.data.snippet ?? null,
    source: parsed.data.source,
    source_url: sourceUrl,
  };

  const idempotencyKey = [
    'web-lead',
    parsed.data.businessId,
    slugify(parsed.data.fullName),
    slugify(parsed.data.companyName ?? ''),
    observedAt.slice(0, 10),
  ].join(':');

  let leadId: string | undefined;
  let idempotent = false;
  try {
    const outcome = await submitIngest(viewer.actor, {
      sourceClient: WEB_LEAD_SOURCE_CLIENT,
      businessId: parsed.data.businessId,
      payloadType: 'candidate',
      payload,
      idempotencyKey,
      observedAt,
      businessKeyOrId: businessSlug,
      // The surface the person was found on, recorded as provenance on the
      // evidence row and projected onto `leads.source_type`. Without this the
      // chosen V1.2 source would only exist inside the ingest payload.
      discoverySource: parsed.data.source,
    });
    leadId = outcome.leadId;
    idempotent = outcome.idempotent;
  } catch (error) {
    return { ok: false, error: describeActionError(error) };
  }

  if (leadId === undefined) {
    return { ok: false, error: 'The lead was submitted but no record was returned.' };
  }

  revalidateLead(businessSlug, leadId);

  // Read back what the database actually stored rather than what the form hoped for: the
  // enrichment state and score are the pipeline's and the trigger's answer, and a missing
  // enrichment row is reported as MINIMAL with 0, exactly as the list does.
  let personName = parsed.data.fullName;
  let enrichmentState = 'MINIMAL';
  let completenessScore = 0;
  let missingFields: readonly string[] = [];

  try {
    const stored = await read(viewer.actor, async (sql) => {
      const result = await sql.query<Record<string, unknown>>(
        `select p.full_name as person_name,
                e.status as enrichment_status,
                e.completeness_score,
                e.missing_fields
           from public.leads l
           join public.people p on p.id = l.person_id
           left join public.lead_enrichment e on e.lead_id = l.id
          where l.id = $1`,
        [leadId],
      );
      return result.rows[0];
    });
    if (stored !== undefined) {
      personName = asString(stored.person_name, parsed.data.fullName);
      enrichmentState = asString(stored.enrichment_status, 'MINIMAL');
      completenessScore = asNumber(stored.completeness_score, 0);
      missingFields = asStringArray(stored.missing_fields);
    }
  } catch {
    // A read-back failure must not turn a successful create into an error: the lead exists,
    // and the list it was created into states the enrichment state on its next render.
    missingFields = [];
  }

  const companyName = parsed.data.companyName ?? null;
  const location = parsed.data.location ?? null;
  const links = searchLinks({ fullName: personName, companyName, location });
  const findLinkedin = links.find((link) => link.key === 'find_linkedin') ?? null;

  return {
    ok: true,
    error: null,
    idempotent,
    message: `${personName} was added to this business.`,
    created: {
      leadId,
      personName,
      leadHref: `/b/${businessSlug}/leads/${leadId}`,
      enrichmentState,
      completenessScore,
      missingFields,
      findLinkedinUrl: findLinkedin?.url ?? null,
      findLinkedinQuery: findLinkedin?.query ?? null,
      findLinkedinBlockedReason:
        findLinkedin === null ? 'the person name is missing' : null,
    },
  };
}
