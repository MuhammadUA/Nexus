/**
 * Sequence / message engine.
 *
 * Spec `lead_lifecycle`, `sequence_engine`, `messaging_rules`.
 *
 * This module is pure and clock-injected: every function takes an `at: Date`, so
 * the whole lifecycle (connection -> M1 -> FU1 -> FU2 -> FU3 -> Dormant ->
 * Reactivation) is deterministic and testable without waiting for real time.
 *
 * Deliberate design decisions tied to the spec:
 *   - "Do not pre-generate all future follow-ups. Generate near due time" ->
 *     `ensureDueMessageInstance` only materialises the *current* step's instance.
 *   - "After FU3 without reply, move to Dormant and schedule reactivation review
 *     around 60 days (business configurable)" -> `advanceSequence` returns a
 *     `dormant` transition carrying `reactivationDueAt`.
 *   - "Any captured reply pauses/cancels pending automatic sequence steps by
 *     default" -> `applyReplyOutcome` is the only path that records an outcome and
 *     it always parks the enrollment.
 */

import type {
  EnrollmentState,
  LeadState,
  MessageState,
  NextActionType,
  ReplyOutcome,
  SequenceStepKind,
} from './vocabulary.js';

/* ------------------------------------------------------------- constants - */

/** spec `lead_lifecycle.default_outreach_sequence`. */
export const DEFAULT_SEQUENCE_STEPS: readonly SequenceStepDefinition[] = [
  {
    stepOrder: 1,
    kind: 'message',
    name: 'Message 1',
    delayDays: 0,
    delayBasis: 'after_previous',
    purpose: 'initial outreach',
  },
  {
    stepOrder: 2,
    kind: 'followup',
    name: 'Follow-up 1',
    delayDays: 3,
    delayBasis: 'after_previous',
    purpose: 'short relevant follow-up',
  },
  {
    stepOrder: 3,
    kind: 'followup',
    name: 'Follow-up 2',
    delayDays: 4,
    delayBasis: 'after_previous',
    purpose: 'new angle/proof',
  },
  {
    stepOrder: 4,
    kind: 'followup',
    name: 'Follow-up 3',
    delayDays: 7,
    delayBasis: 'after_previous',
    purpose: 'close loop / low-pressure final touch',
  },
];

/** spec `lead_lifecycle.after_followup_3`: "around 60 days (business configurable)". */
export const DEFAULT_REACTIVATION_COOLDOWN_DAYS = 60;

/** Step order reserved for the connection request (not a message instance). */
export const CONNECTION_STEP_ORDER = 0;

/**
 * How a step's `delayDays` is anchored. The canonical delay-basis vocabulary,
 * mirrored by the `sequence_steps_delay_basis_check` constraint in
 * `0007_sequences.sql`:
 *
 *   immediate         — due as soon as the step is eligible
 *   after_previous    — N days after the previous step was actually sent
 *                       (the default; for Message 1 the previous event is
 *                       connection acceptance, which is what makes "accepted
 *                       connection makes Message 1 due" work)
 *   after_connection  — N days after the connection was accepted
 *   after_enrollment  — N days after the enrollment started
 */
export const DELAY_BASES = [
  'immediate',
  'after_previous',
  'after_connection',
  'after_enrollment',
] as const;

export type DelayBasis = (typeof DELAY_BASES)[number];

/** spec `sequence_engine.sequence_step_instruction_fields`. */
export interface SequenceStepDefinition {
  readonly stepOrder: number;
  readonly kind: SequenceStepKind;
  readonly name: string;
  readonly delayDays: number;
  readonly delayBasis: DelayBasis;
  readonly purpose: string;
  readonly goal?: string;
  readonly allowedContext?: readonly string[];
  readonly wordMax?: number;
  readonly ctaStyle?: string;
  readonly prohibitedPhrases?: readonly string[];
  readonly proofPolicy?: 'approved_only' | 'none_required' | 'required';
  readonly tone?: string;
  readonly generationMode?: 'dynamic' | 'manual_only';
}

/* ------------------------------------------------------------ enrollment - */

export interface SequenceEnrollment {
  readonly id: string;
  readonly businessId: string;
  readonly leadId: string;
  readonly sequenceId: string;
  readonly sequenceVersionId: string;
  readonly state: EnrollmentState;
  readonly currentStepOrder: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly pausedAt: string | null;
  readonly pauseReason: string | null;
  readonly dormantAt: string | null;
  readonly reactivationDueAt: string | null;
  readonly lastStepSentAt: string | null;
  readonly connectionSentAt: string | null;
  readonly connectionAcceptedAt: string | null;
}

export interface MessageInstance {
  readonly id: string;
  readonly businessId: string;
  readonly leadId: string;
  readonly conversationId: string;
  readonly sequenceStepId: string;
  readonly stepOrder: number;
  readonly stepKind: SequenceStepKind;
  readonly state: MessageState;
  readonly currentVersionId: string | null;
  readonly dueAt: string | null;
  readonly sentAt: string | null;
  readonly snoozedUntil: string | null;
  readonly invalidatedAt: string | null;
  readonly regenerationReason: string | null;
}

/* ------------------------------------------------------------- helpers --- */

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 86_400_000);
}

export function addHours(at: Date, hours: number): Date {
  return new Date(at.getTime() + hours * 3_600_000);
}

/** Day granularity comparison for "is this due?". */
export function isDue(dueAt: string | Date | null, at: Date): boolean {
  if (dueAt === null) return false;
  const due = typeof dueAt === 'string' ? new Date(dueAt) : dueAt;
  return due.getTime() <= at.getTime();
}

function maxDate(a: string | null, b: Date): Date {
  if (a === null) return b;
  const parsed = new Date(a);
  return parsed.getTime() > b.getTime() ? parsed : b;
}

/**
 * The instant a step's `delayDays` counts from.
 *
 * `at` is always "now" for the transition being computed, so every basis is
 * clamped to be no earlier than `at`: scheduling a due date in the past would
 * make the step instantly overdue and re-fire on the next queue build.
 */
export function baseForBasis(
  basis: DelayBasis,
  enrollment: Pick<SequenceEnrollment, 'startedAt' | 'connectionAcceptedAt'>,
  at: Date,
): Date {
  switch (basis) {
    case 'immediate':
      return at;
    case 'after_connection':
      return maxDate(enrollment.connectionAcceptedAt, at);
    case 'after_enrollment':
      return maxDate(enrollment.startedAt, at);
    case 'after_previous':
      return at;
  }
}

/* ------------------------------------------------- state machine -------- */

export type SequenceTransition =
  | {
      readonly type: 'connection_due';
      readonly enrollment: SequenceEnrollment;
      readonly leadStatus: LeadState;
      readonly nextActionType: NextActionType;
      readonly nextActionAt: string | null;
    }
  | {
      readonly type: 'connection_sent';
      readonly enrollment: SequenceEnrollment;
      readonly leadStatus: LeadState;
      readonly nextActionType: NextActionType;
      readonly nextActionAt: string | null;
      /**
       * spec `companion_extension.connection_action.options`: "Send with note" /
       * "Send without note". The connection step produces no message instance, so
       * the flag travels on the transition itself and the caller persists it onto
       * the connection `message_events` row.
       */
      readonly withNote: boolean;
    }
  | {
      readonly type: 'message_1_due';
      readonly enrollment: SequenceEnrollment;
      readonly leadStatus: LeadState;
      readonly nextActionType: NextActionType;
      readonly nextActionAt: string;
    }
  | {
      readonly type: 'step_due';
      readonly enrollment: SequenceEnrollment;
      readonly leadStatus: LeadState;
      readonly nextActionType: NextActionType;
      readonly stepOrder: number;
      readonly nextActionAt: string;
    }
  | {
      readonly type: 'step_sent';
      readonly enrollment: SequenceEnrollment;
      readonly leadStatus: LeadState;
      readonly nextActionType: NextActionType;
      readonly nextActionAt: string | null;
      readonly nextStepOrder: number | null;
    }
  | {
      readonly type: 'dormant';
      readonly enrollment: SequenceEnrollment;
      readonly leadStatus: LeadState;
      readonly nextActionType: NextActionType;
      readonly reactivationDueAt: string;
    }
  | {
      readonly type: 'reactivation_due';
      readonly enrollment: SequenceEnrollment;
      readonly leadStatus: LeadState;
      readonly nextActionType: NextActionType;
      readonly nextActionAt: string;
    }
  | {
      readonly type: 'paused';
      readonly enrollment: SequenceEnrollment;
      readonly leadStatus: LeadState;
      readonly nextActionType: NextActionType;
      readonly reason: string;
    }
  | {
      readonly type: 'completed';
      readonly enrollment: SequenceEnrollment;
      readonly leadStatus: LeadState;
      readonly nextActionType: NextActionType;
    };

export interface SequenceConfig {
  readonly steps: readonly SequenceStepDefinition[];
  readonly reactivationCooldownDays: number;
}

export const DEFAULT_SEQUENCE_CONFIG: SequenceConfig = {
  steps: DEFAULT_SEQUENCE_STEPS,
  reactivationCooldownDays: DEFAULT_REACTIVATION_COOLDOWN_DAYS,
};

/* --------------------------------------------------------- construction - */

export function startEnrollment(params: {
  id: string;
  businessId: string;
  leadId: string;
  sequenceId: string;
  sequenceVersionId: string;
  at: Date;
  connectionAlreadySent?: boolean;
}): SequenceEnrollment {
  return {
    id: params.id,
    businessId: params.businessId,
    leadId: params.leadId,
    sequenceId: params.sequenceId,
    sequenceVersionId: params.sequenceVersionId,
    state: 'active',
    currentStepOrder: CONNECTION_STEP_ORDER,
    startedAt: params.at.toISOString(),
    completedAt: null,
    pausedAt: null,
    pauseReason: null,
    dormantAt: null,
    reactivationDueAt: null,
    lastStepSentAt: null,
    connectionSentAt: params.connectionAlreadySent === true ? params.at.toISOString() : null,
    connectionAcceptedAt: null,
  };
}

/* --------------------------------------------------------- transitions -- */

/**
 * "User manually marks connection sent."
 * spec `companion_extension.connection_action.after_manual_send`.
 *
 * A sent connection does NOT make Message 1 due — "Accepted connection makes
 * Message 1 due" (spec `lead_lifecycle.accepted_connection`). So this only moves
 * the lead into `connection_sent` with no due date until acceptance arrives.
 */
export function markConnectionSent(
  enrollment: SequenceEnrollment,
  at: Date,
  options: { withNote: boolean } = { withNote: false },
): SequenceTransition {
  const next: SequenceEnrollment = {
    ...enrollment,
    currentStepOrder: CONNECTION_STEP_ORDER,
    connectionSentAt: at.toISOString(),
  };
  return {
    type: 'connection_sent',
    enrollment: next,
    leadStatus: 'connection_sent',
    nextActionType: 'review',
    nextActionAt: null,
    withNote: options.withNote,
  };
}

/**
 * "When a connection is accepted, Message 1 becomes due."
 * spec `lead_lifecycle.accepted_connection`.
 */
export function markConnectionAccepted(
  enrollment: SequenceEnrollment,
  config: SequenceConfig,
  at: Date,
): SequenceTransition {
  const firstStep = config.steps[0];
  const accepted: SequenceEnrollment = { ...enrollment, connectionAcceptedAt: at.toISOString() };
  // Message 1's own basis is what this transition evaluates, and the acceptance
  // instant is recorded first so an `after_connection` basis resolves correctly.
  const dueAt = firstStep
    ? addDays(baseForBasis(firstStep.delayBasis, accepted, at), firstStep.delayDays)
    : at;
  const next: SequenceEnrollment = {
    ...accepted,
    state: 'active',
    currentStepOrder: firstStep?.stepOrder ?? 1,
  };
  return {
    type: 'message_1_due',
    enrollment: next,
    leadStatus: 'message_due',
    nextActionType: 'message_1',
    nextActionAt: dueAt.toISOString(),
  };
}

/** The step definition for an order, or undefined when the sequence has ended. */
export function stepAt(
  config: SequenceConfig,
  stepOrder: number,
): SequenceStepDefinition | undefined {
  return config.steps.find((s) => s.stepOrder === stepOrder);
}

export function nextActionTypeForStep(step: SequenceStepDefinition): NextActionType {
  if (step.kind === 'message') return 'message_1';
  if (step.kind === 'followup') {
    if (step.stepOrder === 2) return 'followup_1';
    if (step.stepOrder === 3) return 'followup_2';
    if (step.stepOrder === 4) return 'followup_3';
    return 'review';
  }
  if (step.kind === 'reactivation') return 'reactivation';
  if (step.kind === 'connection') return 'connection';
  return 'review';
}

/**
 * Advance to the next step after a successful send.
 *
 * spec `generation_timing`: the next follow-up is *scheduled* here but not
 * generated; generation happens when it becomes due.
 *
 * Delay semantics: a step's own `delayBasis` says what its `delayDays` counts
 * from, so the next step's date is derived from the basis of the step we *just
 * sent* — `after_previous` therefore means "N days after the message that just
 * went out", which is what spec `sequence_engine.default_steps` requires
 * ("~3 days" for FU1 after Message 1, "~4 days after FU1" for FU2). Reading the
 * basis off the *next* step instead would collapse the cadence, because FU1's
 * basis is `after_previous` and would anchor FU2 to connection acceptance.
 */
export function advanceAfterSent(
  enrollment: SequenceEnrollment,
  config: SequenceConfig,
  sentStepOrder: number,
  at: Date,
): SequenceTransition {
  const sentStep = stepAt(config, sentStepOrder);
  const nextStep = stepAt(config, sentStepOrder + 1);

  const markedSent: SequenceEnrollment = {
    ...enrollment,
    lastStepSentAt: at.toISOString(),
    currentStepOrder: sentStepOrder,
  };

  if (!nextStep) {
    // Last step sent with no reply -> Dormant (spec: "If no reply, move to
    // Dormant and schedule reactivation review around 60 days").
    const reactivationDueAt = addDays(at, config.reactivationCooldownDays);
    return {
      type: 'dormant',
      enrollment: {
        ...markedSent,
        state: 'dormant',
        dormantAt: at.toISOString(),
        reactivationDueAt: reactivationDueAt.toISOString(),
        completedAt: at.toISOString(),
      },
      leadStatus: 'dormant',
      nextActionType: 'reactivation',
      reactivationDueAt: reactivationDueAt.toISOString(),
    };
  }

  // The basis belongs to the step we just sent: `after_previous` resolves to
  // `at` (the moment that message went out), while `after_connection` /
  // `after_enrollment` anchor to the recorded facts and are clamped so the next
  // step can never be scheduled in the past.
  const basis = sentStep?.delayBasis ?? 'after_previous';
  const dueAt = addDays(baseForBasis(basis, enrollment, at), nextStep.delayDays);

  return {
    type: 'step_sent',
    enrollment: { ...markedSent, state: 'active', currentStepOrder: nextStep.stepOrder },
    leadStatus: 'followup_due',
    nextActionType: nextActionTypeForStep(nextStep),
    nextActionAt: dueAt.toISOString(),
    nextStepOrder: nextStep.stepOrder,
  };
}

/**
 * spec: "Prefer a fresh buying signal/new angle. Do not blindly repeat the old
 * sequence." — a reactivation opens a *new* enrollment context rather than
 * restarting at Message 1 of the old one.
 */
export function startReactivation(
  enrollment: SequenceEnrollment,
  config: SequenceConfig,
  at: Date,
): SequenceTransition {
  const firstStep = config.steps[0];
  const dueAt = firstStep
    ? addDays(baseForBasis(firstStep.delayBasis, enrollment, at), firstStep.delayDays)
    : at;
  return {
    type: 'reactivation_due',
    enrollment: {
      ...enrollment,
      state: 'reactivation_due',
      currentStepOrder: firstStep?.stepOrder ?? 1,
    },
    leadStatus: 'reactivation_due',
    nextActionType: 'reactivation',
    nextActionAt: dueAt.toISOString(),
  };
}

/** A dormant enrollment whose cooldown has elapsed becomes reactivation_due. */
export function evaluateReactivation(
  enrollment: SequenceEnrollment,
  config: SequenceConfig,
  at: Date,
): SequenceTransition | null {
  if (enrollment.state !== 'dormant') return null;
  const due = enrollment.reactivationDueAt;
  if (due === null) {
    return startReactivation(enrollment, config, at);
  }
  if (new Date(due).getTime() > at.getTime()) return null;
  return startReactivation(enrollment, config, at);
}

/* ------------------------------------------------------------- replies -- */

export type OutcomeEffect =
  | { readonly kind: 'dnc'; readonly suppressChannels: readonly string[] }
  | { readonly kind: 'cooldown'; readonly cooldownDays: number }
  | { readonly kind: 'terminal'; readonly leadStatus: LeadState }
  | { readonly kind: 'handoff'; readonly leadStatus: LeadState }
  | { readonly kind: 'neutral' };

/** Default cooldown for an ordinary "not interested", in days. */
export const DEFAULT_NOT_INTERESTED_COOLDOWN_DAYS = 90;

/** Default "maybe later" cooldown, in days. */
export const DEFAULT_MAYBE_LATER_COOLDOWN_DAYS = 45;

/**
 * Map a reply outcome to its side effects.
 *
 * spec `sequence_engine.do_not_contact`: "Explicit DNC creates global Person+channel
 * suppression across all outreach identities. Do not bypass via another account."
 * spec `sequence_engine.ordinary_not_interested`: "May create business-specific
 * cooldown; it is not the same as DNC."
 */
export function outcomeEffect(
  outcome: ReplyOutcome,
  options: { notInterestedCooldownDays?: number; maybeLaterCooldownDays?: number } = {},
): OutcomeEffect {
  switch (outcome) {
    case 'Do not contact':
      // Channel-agnostic by default so a second identity on another channel cannot
      // be used to evade the suppression.
      return { kind: 'dnc', suppressChannels: ['linkedin', 'email', 'phone'] };
    case 'Not interested':
      return {
        kind: 'cooldown',
        cooldownDays: options.notInterestedCooldownDays ?? DEFAULT_NOT_INTERESTED_COOLDOWN_DAYS,
      };
    case 'Already has supplier':
      return {
        kind: 'cooldown',
        cooldownDays: options.notInterestedCooldownDays ?? DEFAULT_NOT_INTERESTED_COOLDOWN_DAYS,
      };
    case 'No current need':
      return {
        kind: 'cooldown',
        cooldownDays: options.maybeLaterCooldownDays ?? DEFAULT_MAYBE_LATER_COOLDOWN_DAYS,
      };
    case 'Maybe later':
      return {
        kind: 'cooldown',
        cooldownDays: options.maybeLaterCooldownDays ?? DEFAULT_MAYBE_LATER_COOLDOWN_DAYS,
      };
    case 'Wrong person':
      return { kind: 'terminal', leadStatus: 'wrong_person' };
    case 'Interested':
    case 'Positive / needs info':
      return { kind: 'handoff', leadStatus: 'interested' };
    case 'Other':
      return { kind: 'neutral' };
  }
}

export interface ReplyApplication {
  readonly outcome: ReplyOutcome;
  readonly enrollment: SequenceEnrollment;
  readonly leadStatus: LeadState;
  readonly effect: OutcomeEffect;
  /** Ids of message instances that must be cancelled. */
  readonly cancelInstanceIds: readonly string[];
  readonly cooldownEndsAt: string | null;
  readonly reactivationDueAt: string | null;
}

/**
 * Apply a captured reply.
 *
 * spec `lead_lifecycle.reply`: "Any captured reply pauses/cancels pending
 * automatic sequence steps by default." — this is unconditional, before any
 * outcome-specific handling.
 */
export function applyReplyOutcome(params: {
  outcome: ReplyOutcome;
  enrollment: SequenceEnrollment;
  instances: readonly MessageInstance[];
  at: Date;
  options?: { notInterestedCooldownDays?: number; maybeLaterCooldownDays?: number };
}): ReplyApplication {
  const { outcome, enrollment, instances, at } = params;
  const effect = outcomeEffect(outcome, params.options ?? {});

  const pending = instances.filter(
    (i) => i.state === 'DYNAMIC' || i.state === 'LOCKED',
  );

  let state: EnrollmentState = 'paused';
  let leadStatus: LeadState = 'replied';
  let cooldownEndsAt: string | null = null;
  let reactivationDueAt: string | null = null;

  if (effect.kind === 'cooldown') {
    state = 'paused';
    leadStatus = 'cooldown';
    cooldownEndsAt = addDays(at, effect.cooldownDays).toISOString();
    reactivationDueAt = cooldownEndsAt;
  } else if (effect.kind === 'terminal') {
    state = 'cancelled';
    leadStatus = effect.leadStatus;
  } else if (effect.kind === 'dnc') {
    state = 'cancelled';
    leadStatus = 'do_not_contact';
  } else if (effect.kind === 'handoff') {
    state = 'paused';
    leadStatus = effect.leadStatus;
  }

  return {
    outcome,
    enrollment: {
      ...enrollment,
      state,
      pausedAt: at.toISOString(),
      pauseReason: `reply outcome: ${outcome}`,
      completedAt: effect.kind === 'terminal' || effect.kind === 'dnc' ? at.toISOString() : null,
      reactivationDueAt,
    },
    leadStatus,
    effect,
    cancelInstanceIds: pending.map((i) => i.id),
    cooldownEndsAt,
    reactivationDueAt,
  };
}

/* ------------------------------------------------- message state rules -- */

export type MessageMutation =
  | { readonly allowed: true; readonly state: MessageState }
  | { readonly allowed: false; readonly reason: string };

/** spec `sequence_engine.message_states`. */
export function canRegenerate(state: MessageState): MessageMutation {
  if (state === 'SENT') return { allowed: false, reason: 'SENT messages are immutable' };
  if (state === 'LOCKED') {
    return {
      allowed: false,
      reason: 'LOCKED messages were manually edited/approved and must not be overwritten',
    };
  }
  return { allowed: true, state: 'DYNAMIC' };
}

export function canEdit(state: MessageState): MessageMutation {
  if (state === 'SENT') return { allowed: false, reason: 'SENT messages are immutable' };
  return { allowed: true, state: 'LOCKED' };
}

export function canMarkSent(state: MessageState): MessageMutation {
  if (state === 'SENT') return { allowed: false, reason: 'message already marked SENT' };
  return { allowed: true, state: 'SENT' };
}

/* ------------------------------------------------- publish behaviour ---- */

export type PublishAction = 'unchanged' | 'invalidate';

export interface PublishImpactItem {
  readonly instanceId: string;
  readonly leadId: string;
  readonly state: MessageState;
  readonly action: PublishAction;
  readonly reason: string;
}

export interface PublishImpactPreview {
  readonly total: number;
  readonly sentUntouched: number;
  readonly lockedUntouched: number;
  readonly dynamicInvalidated: number;
  readonly items: readonly PublishImpactItem[];
}

/**
 * spec `sequence_engine.publish_behavior`:
 *   "Show impact preview before publishing sequence changes."
 *   sent stays immutable; locked stays unchanged; eligible dynamic unsent
 *   instances are invalidated/marked needs-regeneration.
 */
export function computePublishImpact(
  instances: readonly MessageInstance[],
): PublishImpactPreview {
  const items: PublishImpactItem[] = instances.map((i) => {
    if (i.state === 'SENT') {
      return {
        instanceId: i.id,
        leadId: i.leadId,
        state: i.state,
        action: 'unchanged',
        reason: 'Sent messages remain immutable',
      };
    }
    if (i.state === 'LOCKED') {
      return {
        instanceId: i.id,
        leadId: i.leadId,
        state: i.state,
        action: 'unchanged',
        reason: 'LOCKED unsent messages remain unchanged',
      };
    }
    return {
      instanceId: i.id,
      leadId: i.leadId,
      state: i.state,
      action: 'invalidate',
      reason: 'Eligible DYNAMIC unsent message marked needs-regeneration',
    };
  });

  return {
    total: items.length,
    sentUntouched: items.filter((i) => i.state === 'SENT').length,
    lockedUntouched: items.filter((i) => i.state === 'LOCKED').length,
    dynamicInvalidated: items.filter((i) => i.action === 'invalidate').length,
    items,
  };
}

/** True when the instance may be invalidated by a sequence publish. */
export function isEligibleForRegeneration(instance: MessageInstance): boolean {
  if (instance.state !== 'DYNAMIC') return false;
  if (instance.sentAt !== null) return false;
  return true;
}

/* -------------------------------------------------- due-step projection - */

export interface DueStepResult {
  readonly step: SequenceStepDefinition;
  readonly dueAt: Date;
  readonly isOverdue: boolean;
}

/**
 * The single "what is the exact current action" projection used by My Day, the
 * Companion focus views and the lead detail page. spec `tasks_and_my_day`:
 * "Opening an item should land on the exact actionable step, not a long generic
 * conversation page."
 */
export function currentDueStep(
  enrollment: SequenceEnrollment,
  config: SequenceConfig,
  at: Date,
): DueStepResult | null {
  if (enrollment.state === 'completed' || enrollment.state === 'cancelled') return null;

  if (enrollment.state === 'dormant') {
    if (enrollment.reactivationDueAt === null) return null;
    const dueAt = new Date(enrollment.reactivationDueAt);
    if (dueAt.getTime() > at.getTime()) return null;
    const step: SequenceStepDefinition = {
      stepOrder: 0,
      kind: 'reactivation',
      name: 'Reactivation',
      delayDays: 0,
      delayBasis: 'immediate',
      purpose: 'fresh-evidence reactivation with a new angle',
    };
    return { step, dueAt, isOverdue: isOverdue(dueAt, at) };
  }

  if (enrollment.state !== 'active' && enrollment.state !== 'reactivation_due') return null;

  const step = stepAt(config, enrollment.currentStepOrder);
  if (!step) return null;

  const dueAt = dueDateForStep(enrollment, step, at);
  if (dueAt === null) return null;
  return { step, dueAt, isOverdue: isOverdue(dueAt, at) };
}

function dueDateForStep(
  enrollment: SequenceEnrollment,
  step: SequenceStepDefinition,
  at: Date,
): Date | null {
  switch (step.delayBasis) {
    case 'immediate':
      // Eligible as soon as the previous event happened; there is nothing to
      // wait for, and the caller's `at` is that moment.
      return addDays(baseForBasis('immediate', enrollment, at), step.delayDays);
    case 'after_connection':
      // Cannot be scheduled at all until the connection is known to be accepted.
      if (enrollment.connectionAcceptedAt === null) return null;
      return addDays(new Date(enrollment.connectionAcceptedAt), step.delayDays);
    case 'after_enrollment':
      return addDays(new Date(enrollment.startedAt), step.delayDays);
    case 'after_previous': {
      // Counts from the previous step's send. Before the first send there is no
      // previous step, so the enrolment start stands in — otherwise a freshly
      // enrolled lead would never surface in the queue.
      const base = enrollment.lastStepSentAt ?? enrollment.startedAt;
      return addDays(new Date(base), step.delayDays);
    }
  }
}

function isOverdue(dueAt: Date, at: Date): boolean {
  // Overdue means a full day has elapsed past the due moment.
  return at.getTime() - dueAt.getTime() > 86_400_000;
}

/* ------------------------------------------------------------ snooze ---- */

/** spec `screen_inventory` U19: "Tomorrow/2 days/next week/custom date". */
export const SNOOZE_PRESETS = [
  { key: 'tomorrow', label: 'Tomorrow', days: 1 },
  { key: 'two_days', label: '2 days', days: 2 },
  { key: 'next_week', label: 'Next week', days: 7 },
  { key: 'custom', label: 'Custom date', days: 0 },
] as const;

export type SnoozePresetKey = (typeof SNOOZE_PRESETS)[number]['key'];

export function resolveSnoozeUntil(
  preset: SnoozePresetKey,
  at: Date,
  customDate?: Date,
): Date | null {
  const found = SNOOZE_PRESETS.find((p) => p.key === preset);
  if (!found) return null;
  if (preset === 'custom') {
    if (!customDate) return null;
    return customDate.getTime() > at.getTime() ? customDate : null;
  }
  return addDays(at, found.days);
}

/* --------------------------------------------------- deterministic ids -- */

/**
 * The connection request is not a `message_instance` (there is no AI-generated
 * body when sent without a note), so the id of the notional step-0 instance is
 * derived so callers cannot create two.
 */
export function connectionStepInstanceKey(leadId: string): string {
  return `${leadId}:step0`;
}
