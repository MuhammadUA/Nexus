'use client';

import { useActionState, type ReactElement, type ReactNode } from 'react';

import { Alert, Button, Field, Stack, TextArea, TextInput, Select } from '@nexus/ui';

import {
  addNoteAction,
  captureReplyAction,
  completeTaskAction,
  connectionSentAction,
  createTaskAction,
  messageSentAction,
  permanentDeleteAction,
  restoreLeadAction,
  snoozeAction,
  softDeleteAction,
  updateLeadAction,
  type ActionResult,
} from '@/app/b/[slug]/leads/[id]/actions';

const INITIAL: ActionResult = { ok: false, error: null };

/** Repeated shell: a form whose result is reported inline in the Nexus design language. */
function ActionShell({
  action,
  children,
  submitLabel,
  variant = 'primary',
  hidden,
}: {
  readonly action: (previous: ActionResult, formData: FormData) => Promise<ActionResult>;
  readonly children: ReactNode;
  readonly submitLabel: string;
  readonly variant?: 'primary' | 'secondary';
  readonly hidden: Record<string, string>;
}): ReactElement {
  const [state, formAction, pending] = useActionState(action, INITIAL);

  return (
    <form action={formAction}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Stack>
        {children}
        {state.error !== null && <Alert accent="red" role="alert">{state.error}</Alert>}
        {state.error === null && state.message !== undefined && (
          <Alert accent="green" role="status">{state.message}</Alert>
        )}
        <Button type="submit" variant={variant} busy={pending}>
          {submitLabel}
        </Button>
      </Stack>
    </form>
  );
}

export function NoteForm({
  leadId,
  businessSlug,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(addNoteAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <Stack>
        <Field label="Internal note" htmlFor="note-body" hint="Kept separate from the prospect's reply.">
          <TextArea id="note-body" name="body" defaultValue="" placeholder="What should you remember about this lead?" />
        </Field>
        {state.error !== null && <Alert accent="red" role="alert">{state.error}</Alert>}
        {state.error === null && state.message !== undefined && (
          <Alert accent="green" role="status">{state.message}</Alert>
        )}
        <Button type="submit" variant="secondary" busy={pending}>
          Add note
        </Button>
      </Stack>
    </form>
  );
}

/**
 * spec `reply_and_notes`: exact inbound text, outcome, and a separate internal note.
 */
export function ReplyForm({
  leadId,
  businessSlug,
  outcomes,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
  readonly outcomes: readonly string[];
}): ReactElement {
  const [state, formAction, pending] = useActionState(captureReplyAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <Stack>
        <Field
          label="Exact reply"
          htmlFor="reply-text"
          required
          hint="Paste the prospect's reply word for word. It is stored verbatim."
        >
          <TextArea id="reply-text" name="exactText" defaultValue="" tall required />
        </Field>

        <Field label="Outcome" htmlFor="reply-outcome" required>
          <Select
            id="reply-outcome"
            name="outcome"
            defaultValue=""
            required
            placeholder="Choose an outcome"
            options={outcomes.map((outcome) => ({ value: outcome, label: outcome }))}
          />
        </Field>

        <Field label="Internal note" htmlFor="reply-note" hint="Optional, and never sent to the prospect.">
          <TextArea id="reply-note" name="note" defaultValue="" />
        </Field>

        {state.error !== null && <Alert accent="red" role="alert">{state.error}</Alert>}
        {state.error === null && state.message !== undefined && (
          <Alert accent="green" role="status">{state.message}</Alert>
        )}
        <Button type="submit" variant="primary" busy={pending}>
          Save reply and pause sequence
        </Button>
      </Stack>
    </form>
  );
}

export function TaskForm({
  leadId,
  businessSlug,
  taskTypes,
  priorities,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
  readonly taskTypes: readonly string[];
  readonly priorities: readonly string[];
}): ReactElement {
  const [state, formAction, pending] = useActionState(createTaskAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <Stack size="sm">
        <Field label="Task" htmlFor="task-title" required>
          <TextInput id="task-title" name="title" defaultValue="" required />
        </Field>
        <div className="nx-grid nx-grid--2">
          <Field label="Type" htmlFor="task-type">
            <Select
              id="task-type"
              name="type"
              defaultValue="follow_up"
              options={taskTypes.map((type) => ({ value: type, label: type.replace(/_/g, ' ') }))}
            />
          </Field>
          <Field label="Priority" htmlFor="task-priority">
            <Select
              id="task-priority"
              name="priority"
              defaultValue="normal"
              options={priorities.map((priority) => ({ value: priority, label: priority }))}
            />
          </Field>
        </div>
        <Field label="Due" htmlFor="task-due">
          <TextInput id="task-due" name="dueAt" defaultValue="" type="datetime-local" />
        </Field>
        {state.error !== null && <Alert accent="red" role="alert">{state.error}</Alert>}
        {state.error === null && state.message !== undefined && (
          <Alert accent="green" role="status">{state.message}</Alert>
        )}
        <Button type="submit" variant="secondary" busy={pending}>
          Create task
        </Button>
      </Stack>
    </form>
  );
}

export function CompleteTaskButton({
  leadId,
  taskId,
  businessSlug,
}: {
  readonly leadId: string;
  readonly taskId: string;
  readonly businessSlug: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(completeTaskAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <Button type="submit" variant="ghost" size="sm" busy={pending} title={state.error ?? 'Mark this task done'}>
        Mark done
      </Button>
    </form>
  );
}

/**
 * Soft delete (A04 / U06 / U21).
 *
 * spec `security_and_reliability.rules`: "Soft delete by default." The button
 * therefore says what it does — move to Trash — and permanent deletion is a
 * separate, admin-only, confirmation-gated action on the Trash screen.
 */
export function SoftDeleteAction({
  leadId,
  businessSlug,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(softDeleteAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <Stack size="sm">
        {state.error !== null && <Alert accent="red" role="alert">{state.error}</Alert>}
        <Button type="submit" variant="danger" busy={pending}>
          Move to Trash
        </Button>
      </Stack>
    </form>
  );
}

export function RestoreLeadAction({
  leadId,
  businessSlug,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(restoreLeadAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <Button type="submit" variant="secondary" size="sm" busy={pending} title={state.error ?? 'Restore this lead'}>
        Restore
      </Button>
    </form>
  );
}

/**
 * Permanent deletion (A08, admin only).
 *
 * The database function requires the literal confirmation string, so this cannot be
 * bypassed even if the UI check were removed.
 */
export function PermanentDeleteAction({
  leadId,
  businessSlug,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(permanentDeleteAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <Stack size="sm">
        <Field
          label="Type DELETE PERMANENTLY to confirm"
          htmlFor={`perm-${leadId}`}
          required
          hint="This cannot be undone and is written to the audit log."
        >
          <TextInput id={`perm-${leadId}`} name="confirmation" defaultValue="" required />
        </Field>
        {state.error !== null && <Alert accent="red" role="alert">{state.error}</Alert>}
        {state.error === null && state.message !== undefined && (
          <Alert accent="green" role="status">{state.message}</Alert>
        )}
        <Button type="submit" variant="danger" size="sm" busy={pending}>
          Delete permanently
        </Button>
      </Stack>
    </form>
  );
}

/**
 * Connection action: with or without a note, then "Mark connection sent"
 * (spec `companion_extension.connection_action`).
 */
export function ConnectionAction({
  leadId,
  businessSlug,
  identities,
  defaultIdentityId,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
  readonly identities: readonly { readonly value: string; readonly label: string }[];
  readonly defaultIdentityId: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(connectionSentAction, INITIAL);
  const [noteState, noteAction, notePending] = useActionState(connectionSentAction, INITIAL);

  return (
    <Stack size="sm">
      <form action={formAction}>
        <input type="hidden" name="leadId" value={leadId} />
        <input type="hidden" name="businessSlug" value={businessSlug} />
        <input type="hidden" name="withNote" value="true" />
        <Stack size="sm">
          <Field label="Sender identity" htmlFor="conn-identity-note" required>
            <Select
              id="conn-identity-note"
              name="identityId"
              defaultValue={defaultIdentityId}
              options={identities.map((identity) => ({ value: identity.value, label: identity.label }))}
            />
          </Field>
          {state.error !== null && <Alert accent="red" role="alert">{state.error}</Alert>}
          {state.error === null && state.message !== undefined && (
            <Alert accent="green" role="status">{state.message}</Alert>
          )}
          <Button type="submit" variant="primary" busy={pending}>
            Mark sent with note
          </Button>
        </Stack>
      </form>

      <form action={noteAction}>
        <input type="hidden" name="leadId" value={leadId} />
        <input type="hidden" name="businessSlug" value={businessSlug} />
        <input type="hidden" name="withNote" value="false" />
        <input type="hidden" name="identityId" value={defaultIdentityId} />
        {noteState.error !== null && <Alert accent="red" role="alert">{noteState.error}</Alert>}
        {noteState.error === null && noteState.message !== undefined && (
          <Alert accent="green" role="status">{noteState.message}</Alert>
        )}
        <Button type="submit" variant="secondary" busy={notePending}>
          Mark sent without note
        </Button>
      </form>
    </Stack>
  );
}

export function MessageSentAction({
  leadId,
  businessSlug,
  messageInstanceId,
  defaultIdentityId,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
  readonly messageInstanceId: string;
  readonly defaultIdentityId: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(messageSentAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="messageInstanceId" value={messageInstanceId} />
      <input type="hidden" name="identityId" value={defaultIdentityId} />
      <Stack size="sm">
        {state.error !== null && <Alert accent="red" role="alert">{state.error}</Alert>}
        {state.error === null && state.message !== undefined && (
          <Alert accent="green" role="status">{state.message}</Alert>
        )}
        <Button type="submit" variant="primary" busy={pending}>
          Mark sent
        </Button>
      </Stack>
    </form>
  );
}

export function SnoozeForm({
  leadId,
  businessSlug,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(snoozeAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <Stack size="sm">
        <Field label="Snooze until" htmlFor="snooze-until" required>
          <TextInput id="snooze-until" name="until" defaultValue="" type="datetime-local" required />
        </Field>
        <Field label="Reason" htmlFor="snooze-reason">
          <TextInput id="snooze-reason" name="reason" defaultValue="" />
        </Field>
        {state.error !== null && <Alert accent="red" role="alert">{state.error}</Alert>}
        {state.error === null && state.message !== undefined && (
          <Alert accent="green" role="status">{state.message}</Alert>
        )}
        <Button type="submit" variant="secondary" busy={pending}>
          Snooze
        </Button>
      </Stack>
    </form>
  );
}

/** Edit lead (U20): owner, sender identity, Primary ICP and status. */
export function LeadEditForm({
  leadId,
  businessSlug,
  icps,
  identities,
  owners,
  statuses,
  current,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
  readonly icps: readonly { readonly value: string; readonly label: string }[];
  readonly identities: readonly { readonly value: string; readonly label: string }[];
  readonly owners: readonly { readonly value: string; readonly label: string }[];
  readonly statuses: readonly string[];
  readonly current: {
    readonly icpId: string;
    readonly ownerId: string;
    readonly identityId: string;
    readonly status: string;
  };
}): ReactElement {
  const [state, formAction, pending] = useActionState(updateLeadAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <Stack size="sm">
        <Field
          label="Primary ICP"
          htmlFor="edit-icp"
          hint="Changing the Primary ICP is audited; secondary matches are preserved."
        >
          <Select
            id="edit-icp"
            name="primaryIcpId"
            defaultValue={current.icpId}
            options={icps.map((icp) => ({ value: icp.value, label: icp.label }))}
          />
        </Field>
        <Field label="Owner" htmlFor="edit-owner" hint="Owner and sender identity are separate.">
          <Select
            id="edit-owner"
            name="ownerUserId"
            defaultValue={current.ownerId}
            options={owners.map((owner) => ({ value: owner.value, label: owner.label }))}
          />
        </Field>
        <Field label="Sender identity" htmlFor="edit-identity">
          <Select
            id="edit-identity"
            name="outreachIdentityId"
            defaultValue={current.identityId}
            options={identities.map((identity) => ({ value: identity.value, label: identity.label }))}
          />
        </Field>
        <Field label="Status" htmlFor="edit-status">
          <Select
            id="edit-status"
            name="status"
            defaultValue={current.status}
            options={statuses.map((status) => ({ value: status, label: status.replace(/_/g, ' ') }))}
          />
        </Field>
        {state.error !== null && <Alert accent="red" role="alert">{state.error}</Alert>}
        {state.error === null && state.message !== undefined && (
          <Alert accent="green" role="status">{state.message}</Alert>
        )}
        <Button type="submit" variant="primary" busy={pending}>
          Save changes
        </Button>
      </Stack>
    </form>
  );
}

export { ActionShell };
