'use client';

import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Field, Grid, Select, Stack, TextArea, TextInput } from '@nexus/ui';

import { createTaskAction } from '@/app/(app)/tasks/new/actions';

/**
 * Local result shape.
 *
 * Deliberately declared here rather than imported from the `'use server'` module:
 * a client component may only import *functions* from a `'use server'` file, so the
 * type is mirrored instead of re-exported.
 */
interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly message?: string;
}

const INITIAL: ActionResult = { ok: false, error: null };

/**
 * U18 — Create Task.
 *
 * Contract: "Task title, due date, priority, reminder, note."
 *
 * Inputs are uncontrolled (`defaultValue` + `name`, no `value`/`onChange`) so the
 * browser owns what is submitted; the server action validates every field again with
 * Zod, because a form is not a validation boundary.
 */
export function TaskForm({
  leadId,
  leadLabel,
  businessName,
  taskTypes,
  priorities,
}: {
  readonly leadId: string;
  readonly leadLabel: string;
  readonly businessName: string;
  readonly taskTypes: readonly string[];
  readonly priorities: readonly string[];
}): ReactElement {
  const [state, formAction, pending] = useActionState(createTaskAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <Stack>
        <Field label="Task" htmlFor="task-title" required hint={`For ${leadLabel} in ${businessName}.`}>
          <TextInput id="task-title" name="title" defaultValue="" required />
        </Field>

        <Grid cols={2}>
          <Field label="Type" htmlFor="task-type">
            <Select
              id="task-type"
              name="type"
              defaultValue="follow_up"
              options={taskTypes.map((type) => ({ value: type, label: type.replace(/_/g, ' ') }))}
            />
          </Field>
          <Field
            label="Priority"
            htmlFor="task-priority"
            hint="Urgent work is surfaced first in My Day."
          >
            <Select
              id="task-priority"
              name="priority"
              defaultValue="normal"
              options={priorities.map((priority) => ({ value: priority, label: priority }))}
            />
          </Field>
        </Grid>

        <Grid cols={2}>
          <Field label="Due" htmlFor="task-due" hint="Leave empty for a task with no deadline.">
            <TextInput id="task-due" name="dueAt" defaultValue="" type="datetime-local" />
          </Field>
          <Field
            label="Reminder"
            htmlFor="task-reminder"
            hint="Optional. A reminder must not be later than the due date."
          >
            <TextInput id="task-reminder" name="reminderAt" defaultValue="" type="datetime-local" />
          </Field>
        </Grid>

        <Field label="Note" htmlFor="task-note" hint="Internal only. Never sent to the prospect.">
          <TextArea id="task-note" name="note" defaultValue="" rows={3} />
        </Field>

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

        <Button type="submit" variant="primary" busy={pending}>
          Create task
        </Button>
      </Stack>
    </form>
  );
}
