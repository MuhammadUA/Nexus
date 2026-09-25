'use client';

import { useActionState, type ReactElement } from 'react';

import {
  DELAY_BASES,
  SEQUENCE_STEP_KINDS,
  ZEMNAS_MESSAGE_DEFAULTS,
  type DelayBasis,
} from '@nexus/core';
import { Alert, Button, Field, Select, Stack, TextArea, TextInput } from '@nexus/ui';

import {
  archiveSequenceAction,
  createSequenceAction,
  createVersionAction,
  publishVersionAction,
  updateSequenceAction,
  updateStepAction,
  type ActionResult,
} from '@/app/b/[slug]/setup/sequences/actions';
import { ActionShell } from '@/components/lead-forms';
// Types come from the client-safe view module: `lib/repo/*` is server-only.
import type { SequenceStep, SequenceSummary } from '@/lib/sequence-view';

const INITIAL: ActionResult = { ok: false, error: null };

const YES_NO = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

/** Mirrors `sequences_status_check` in `0007_sequences.sql`. */
const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'archived', label: 'Archived' },
];

const KIND_OPTIONS = SEQUENCE_STEP_KINDS.map((kind) => ({
  value: kind,
  label: kind.charAt(0).toUpperCase() + kind.slice(1),
}));

/** Mirrors `sequence_steps_generation_mode_check`: ai | manual | hybrid. */
const GENERATION_MODE_OPTIONS = [
  { value: 'ai', label: 'AI generated (dynamic)' },
  { value: 'manual', label: 'Manual only' },
  { value: 'hybrid', label: 'Hybrid — AI draft, human edit' },
];

const PROOF_POLICY_OPTIONS = [
  { value: '', label: 'Not set' },
  { value: 'approved_only', label: 'Approved assets only' },
  { value: 'required', label: 'Proof required' },
  { value: 'none_required', label: 'No proof required' },
];

const DELAY_BASIS_LABELS: Readonly<Record<DelayBasis, string>> = {
  immediate: 'Immediately when eligible',
  after_previous: 'After the previous step was sent',
  after_connection: 'After the connection was accepted',
  after_enrollment: 'After the lead was enrolled',
};

const DELAY_BASIS_OPTIONS = DELAY_BASES.map((basis) => ({
  value: basis,
  label: DELAY_BASIS_LABELS[basis],
}));

function listValue(values: readonly string[]): string {
  return values.join('\n');
}

export function SequenceForm({
  mode,
  businessSlug,
  businessId,
  sequence,
}: {
  readonly mode: 'create' | 'edit';
  readonly businessSlug: string;
  readonly businessId: string;
  readonly sequence?: SequenceSummary;
}): ReactElement {
  const isEdit = mode === 'edit' && sequence !== undefined;
  const suffix = isEdit ? sequence.id.slice(0, 8) : 'new';
  const action = isEdit ? updateSequenceAction : createSequenceAction;

  return (
    <ActionShell
      action={action}
      submitLabel={isEdit ? 'Save sequence' : 'Create sequence'}
      hidden={{
        businessSlug,
        businessId,
        ...(isEdit ? { sequenceId: sequence.id } : {}),
      }}
    >
      <Field label="Name" htmlFor={`sequence-name-${suffix}`} required>
        <TextInput
          id={`sequence-name-${suffix}`}
          name="name"
          defaultValue={isEdit ? sequence.name : ''}
          required
        />
      </Field>
      <Field label="Description" htmlFor={`sequence-description-${suffix}`}>
        <TextArea
          id={`sequence-description-${suffix}`}
          name="description"
          defaultValue={isEdit ? (sequence.description ?? '') : ''}
          rows={2}
        />
      </Field>
      <div className="nx-grid nx-grid--2">
        <Field label="Business default sequence" htmlFor={`sequence-default-${suffix}`}>
          <Select
            id={`sequence-default-${suffix}`}
            name="isDefault"
            defaultValue={isEdit && sequence.isDefault ? 'true' : 'false'}
            options={YES_NO}
          />
        </Field>
        {isEdit && (
          <Field
            label="Lifecycle status"
            htmlFor={`sequence-status-${suffix}`}
            hint="Archiving a sequence stops new enrollment; live enrollments keep their version."
          >
            <Select
              id={`sequence-status-${suffix}`}
              name="status"
              defaultValue={sequence.status}
              options={STATUS_OPTIONS}
            />
          </Field>
        )}
      </div>
    </ActionShell>
  );
}

export function ArchiveSequenceAction({
  sequenceId,
  sequenceName,
  businessSlug,
}: {
  readonly sequenceId: string;
  readonly sequenceName: string;
  readonly businessSlug: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(archiveSequenceAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="sequenceId" value={sequenceId} />
      <Stack size="sm">
        <p className="nx-hint">
          Archiving {sequenceName} keeps every published version, enrollment and message
          instance for audit; it only stops the sequence from being used again.
        </p>
        {state.error !== null && (
          <Alert accent="red" role="alert">
            {state.error}
          </Alert>
        )}
        {state.error === null && state.message !== undefined && (
          <Alert accent="green" role="status">
            {state.message}
          </Alert>
        )}
        <Button type="submit" variant="danger" busy={pending}>
          Archive sequence
        </Button>
      </Stack>
    </form>
  );
}

/**
 * Opens the next draft version.
 *
 * spec `sequence_engine.publish_behavior` treats a version as the unit of change, so
 * editing a live sequence starts here rather than by mutating published steps.
 */
export function CreateVersionForm({
  businessSlug,
  businessId,
  sequenceId,
  sourceVersionId,
  sourceLabel,
}: {
  readonly businessSlug: string;
  readonly businessId: string;
  readonly sequenceId: string;
  readonly sourceVersionId: string | null;
  readonly sourceLabel: string;
}): ReactElement {
  return (
    <ActionShell
      action={createVersionAction}
      submitLabel={sourceVersionId === null ? 'Create version 1 draft' : 'Create next draft version'}
      variant="secondary"
      hidden={{
        businessSlug,
        businessId,
        sequenceId,
        sourceVersionId: sourceVersionId ?? '',
      }}
    >
      <p className="nx-hint">
        {sourceVersionId === null
          ? 'Starts from the default lifecycle — Connection, Message 1, FU1, FU2, FU3 — with this business’s configured delays.'
          : `Copies every step of ${sourceLabel} into a new draft. Published versions are never edited in place.`}
      </p>
      <Field label="Change summary" htmlFor={`version-summary-${sequenceId.slice(0, 8)}`}>
        <TextInput
          id={`version-summary-${sequenceId.slice(0, 8)}`}
          name="changeSummary"
          defaultValue=""
          placeholder="What is changing in this version?"
        />
      </Field>
    </ActionShell>
  );
}

/**
 * The step editor (spec `sequence_engine.sequence_step_instruction_fields` plus the
 * delay), with the Zemnas message defaults shown as guidance.
 */
export function StepEditForm({
  businessSlug,
  step,
  editable,
}: {
  readonly businessSlug: string;
  readonly step: SequenceStep;
  readonly editable: boolean;
}): ReactElement {
  const suffix = step.id.slice(0, 8);
  const banned = ZEMNAS_MESSAGE_DEFAULTS.prohibitedPhrases;

  return (
    <ActionShell
      action={updateStepAction}
      submitLabel="Save step"
      variant="secondary"
      hidden={{ businessSlug, stepId: step.id }}
    >
      {!editable && (
        <Alert accent="amber">
          This version is published, so its steps are read-only. Create a new draft version to change
          them.
        </Alert>
      )}

      <div className="nx-grid nx-grid--2">
        <Field label="Step name" htmlFor={`step-name-${suffix}`} required>
          <TextInput
            id={`step-name-${suffix}`}
            name="name"
            defaultValue={step.name}
            required
            disabled={!editable}
          />
        </Field>
        <Field label="Kind" htmlFor={`step-kind-${suffix}`}>
          <Select
            id={`step-kind-${suffix}`}
            name="kind"
            defaultValue={step.kind}
            options={KIND_OPTIONS}
            disabled={!editable}
          />
        </Field>
        <Field
          label="Delay in days"
          htmlFor={`step-delay-${suffix}`}
          hint="Message 1 has no delay of its own: it becomes due when the connection is accepted."
        >
          <TextInput
            id={`step-delay-${suffix}`}
            name="delayDays"
            type="number"
            defaultValue={String(step.delayDays)}
            disabled={!editable}
          />
        </Field>
        <Field label="Delay counted from" htmlFor={`step-basis-${suffix}`}>
          <Select
            id={`step-basis-${suffix}`}
            name="delayBasis"
            defaultValue={step.delayBasis}
            options={DELAY_BASIS_OPTIONS}
            disabled={!editable}
          />
        </Field>
      </div>

      <Field label="Goal" htmlFor={`step-goal-${suffix}`}>
        <TextArea
          id={`step-goal-${suffix}`}
          name="goal"
          defaultValue={step.goal ?? ''}
          rows={2}
          disabled={!editable}
        />
      </Field>

      <Field
        label="Allowed context"
        htmlFor={`step-allowed-context-${suffix}`}
        hint="One per line. Anything not listed is not assertable by the draft."
      >
        <TextArea
          id={`step-allowed-context-${suffix}`}
          name="allowedContext"
          defaultValue={listValue(step.allowedContext)}
          rows={2}
          disabled={!editable}
        />
      </Field>

      <div className="nx-grid nx-grid--2">
        <Field
          label="Word max"
          htmlFor={`step-word-max-${suffix}`}
          hint={`Zemnas default: about ${String(ZEMNAS_MESSAGE_DEFAULTS.minWords)}–${String(ZEMNAS_MESSAGE_DEFAULTS.maxWords)} words`}
        >
          <TextInput
            id={`step-word-max-${suffix}`}
            name="wordMax"
            type="number"
            defaultValue={step.wordMax === null ? '' : String(step.wordMax)}
            disabled={!editable}
          />
        </Field>
        <Field label="CTA style" htmlFor={`step-cta-${suffix}`} hint="Keep the call to action low pressure.">
          <TextInput
            id={`step-cta-${suffix}`}
            name="ctaStyle"
            defaultValue={step.ctaStyle ?? ''}
            disabled={!editable}
          />
        </Field>
        <Field label="Tone" htmlFor={`step-tone-${suffix}`}>
          <TextInput
            id={`step-tone-${suffix}`}
            name="tone"
            defaultValue={step.tone ?? ''}
            disabled={!editable}
          />
        </Field>
        <Field label="Generation mode" htmlFor={`step-generation-${suffix}`}>
          <Select
            id={`step-generation-${suffix}`}
            name="generationMode"
            defaultValue={step.generationMode}
            options={GENERATION_MODE_OPTIONS}
            disabled={!editable}
          />
        </Field>
        <Field label="Proof policy" htmlFor={`step-proof-${suffix}`}>
          <Select
            id={`step-proof-${suffix}`}
            name="proofPolicy"
            defaultValue={step.proofPolicy ?? ''}
            options={PROOF_POLICY_OPTIONS}
            disabled={!editable}
          />
        </Field>
        <Field label="Step active" htmlFor={`step-active-${suffix}`}>
          <Select
            id={`step-active-${suffix}`}
            name="isActive"
            defaultValue={step.isActive ? 'true' : 'false'}
            options={YES_NO}
            disabled={!editable}
          />
        </Field>
      </div>

      <Field
        label="Prohibited phrases"
        htmlFor={`step-prohibited-${suffix}`}
        hint={`One per line. Zemnas bans: ${banned.slice(0, 5).join(', ')} … and generic praise.`}
      >
        <TextArea
          id={`step-prohibited-${suffix}`}
          name="prohibitedPhrases"
          defaultValue={listValue(step.prohibitedPhrases)}
          rows={3}
          disabled={!editable}
        />
      </Field>
    </ActionShell>
  );
}

/**
 * Publishes a draft version through `public.publish_sequence_version`.
 *
 * The impact preview above this button is computed from the real `message_instances`
 * rows with `computePublishImpact`; the RPC then applies the same policy and stores
 * what it actually did on `sequence_versions.impact_preview`.
 */
export function PublishVersionForm({
  businessSlug,
  versionId,
  version,
  canPublish,
}: {
  readonly businessSlug: string;
  readonly versionId: string;
  readonly version: number;
  readonly canPublish: boolean;
}): ReactElement {
  if (!canPublish) {
    return (
      <span className="nx-hint">
        Publishing a sequence version requires the admin role; the database refuses it otherwise.
      </span>
    );
  }

  return (
    <ActionShell
      action={publishVersionAction}
      submitLabel={`Publish version ${String(version)}`}
      variant="primary"
      hidden={{ businessSlug, versionId }}
    >
      <p className="nx-hint">
        Publishing archives the previously published version, moves live enrollments onto this one,
        leaves SENT and LOCKED messages untouched, and marks eligible unsent DYNAMIC messages as
        needing regeneration. Every message keeps its `sequence_version_id` and
        `message_version_id` for audit.
      </p>
    </ActionShell>
  );
}
