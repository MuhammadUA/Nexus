'use server';

/**
 * U18 — Create Task.
 *
 * Contract: "Task title, due date, priority, reminder, note."
 *
 * spec `tasks_and_my_day.task_fields` lists id, lead_id, business_id, owner_user_id,
 * type, title, due_at, priority, reminder_at, status, note, source — every field this
 * action writes comes from that list, and `status`/`source` are set by the repository
 * (`open`, `user`) exactly as the admin path sets them.
 *
 * The actor is taken from `currentViewer()`, never from the form, and the insert runs
 * in `withActor` inside `createTask`, so a task can only be created on a lead the
 * viewer's scope already covers.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { TASK_PRIORITIES, TASK_TYPES } from '@nexus/core';
import { createTask } from '@/lib/repo/leads';
import { formString, formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

/**
 * `datetime-local` submits either an empty string or `YYYY-MM-DDTHH:mm` with no zone.
 * An empty value means "no due date" — never "now", which would silently push the task
 * into today's queue.
 */
const optionalDateTime = z
  .string()
  .trim()
  .max(40)
  .nullish()
  .transform((value) => (value == null || value.length === 0 ? null : value))
  .refine((value) => value === null || !Number.isNaN(new Date(value).getTime()), {
    message: 'That date could not be read.',
  });

const taskSchema = z.object({
  leadId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  type: z.enum(TASK_TYPES),
  dueAt: optionalDateTime,
  priority: z.enum(TASK_PRIORITIES),
  reminderAt: optionalDateTime,
  note: z.string().trim().max(2000).nullish(),
});

export async function createTaskAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = taskSchema.safeParse({
    leadId: formStringOrNull(formData, 'leadId'),
    title: formStringOrNull(formData, 'title'),
    type: formString(formData, 'type', 'follow_up'),
    dueAt: formStringOrNull(formData, 'dueAt'),
    priority: formString(formData, 'priority', 'normal'),
    reminderAt: formStringOrNull(formData, 'reminderAt'),
    note: formStringOrNull(formData, 'note'),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message;
    return {
      ok: false,
      error:
        issue !== undefined && issue.length > 0 && issue !== 'Invalid input'
          ? issue
          : 'Give the task a title and check the dates.',
    };
  }

  const viewer = await currentViewer();
  if (viewer === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  const reminderAt = parsed.data.reminderAt;
  const dueAt = parsed.data.dueAt;
  if (reminderAt !== null && dueAt !== null && new Date(reminderAt) > new Date(dueAt)) {
    return { ok: false, error: 'The reminder should not be after the due date.' };
  }

  const result = await createTask(viewer, {
    leadId: parsed.data.leadId ?? undefined,
    title: parsed.data.title ?? undefined,
    type: parsed.data.type ?? undefined,
    dueAt: dueAt === null ? null : new Date(dueAt).toISOString(),
    priority: parsed.data.priority ?? undefined,
    reminderAt: reminderAt === null ? null : new Date(reminderAt).toISOString(),
    note: parsed.data.note == null || parsed.data.note.length === 0 ? null : parsed.data.note,
  });

  if (result.ok) {
    // A new task can land in My Day immediately (custom task), so both lists are stale.
    revalidatePath('/my-day');
    revalidatePath('/my-day/upcoming');
    revalidatePath(`/leads/${parsed.data.leadId}`);
    revalidatePath('/my-leads');
  }

  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Task created. It appears in My Day when it is due.' : undefined,
  };
}
