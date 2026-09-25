'use server';

/**
 * U19 — Snooze & Reschedule.
 *
 * Contract: "Tomorrow/2 days/next week/custom date; optional reason."
 *
 * The presets are resolved to an absolute instant **on the server**, from the submitted
 * preset name rather than from a client-supplied timestamp: a browser clock or a
 * tampered form must not be able to snooze a lead into the past.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { snoozeLead } from '@/lib/repo/leads';
import { formStringOrNull } from '@/lib/form-data';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
}

/**
 * spec `screen_inventory` U19 — the four choices, in the spec's order.
 *
 * Kept local (not exported) because a `'use server'` module may only export async
 * functions; the screen and its form own the labels.
 */
const SNOOZE_PRESETS = ['tomorrow', 'two_days', 'next_week', 'custom'] as const;
type SnoozePreset = (typeof SNOOZE_PRESETS)[number];

const PRESET_DAYS: Readonly<Record<Exclude<SnoozePreset, 'custom'>, number>> = {
  tomorrow: 1,
  two_days: 2,
  next_week: 7,
};

/** 09:00 local on the target day: a snooze lands at the start of a working day. */
function presetInstant(preset: Exclude<SnoozePreset, 'custom'>, from: Date): Date {
  const target = new Date(from.getTime());
  target.setDate(target.getDate() + PRESET_DAYS[preset]);
  target.setHours(9, 0, 0, 0);
  return target;
}

const snoozeSchema = z.object({
  leadId: z.string().uuid(),
  preset: z.enum(SNOOZE_PRESETS),
  customUntil: z.string().trim().max(40).nullish(),
  reason: z.string().trim().max(500).nullish(),
});

export async function snoozeLeadAction(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = snoozeSchema.safeParse({
    leadId: formStringOrNull(formData, 'leadId'),
    preset: formStringOrNull(formData, 'preset'),
    customUntil: formStringOrNull(formData, 'customUntil'),
    reason: formStringOrNull(formData, 'reason'),
  });
  if (!parsed.success) {
    return { ok: false, error: 'Choose when this lead should come back.' };
  }

  const viewer = await currentViewer();
  if (viewer === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  const now = new Date();
  let until: Date;
  if (parsed.data.preset === 'custom') {
    const raw = parsed.data.customUntil ?? '';
    if (raw.length === 0) return { ok: false, error: 'Pick the date and time to be reminded.' };
    const parsedDate = new Date(raw);
    if (Number.isNaN(parsedDate.getTime())) {
      return { ok: false, error: 'That date could not be read.' };
    }
    if (parsedDate.getTime() <= now.getTime()) {
      return { ok: false, error: 'A snooze has to be in the future.' };
    }
    until = parsedDate;
  } else {
    until = presetInstant(parsed.data.preset, now);
  }

  const reason = parsed.data.reason ?? '';
  const result = await snoozeLead(viewer, {
    leadId: parsed.data.leadId ?? undefined,
    until: until.toISOString(),
    reason: reason.length === 0 ? null : reason,
  });

  if (result.ok) {
    // spec `tasks_and_my_day.today_engine_inputs`: snooze/reschedule is an input to
    // the Today engine, so the queue is stale the moment this succeeds.
    revalidatePath('/my-day');
    revalidatePath('/my-day/upcoming');
    revalidatePath('/my-leads');
    revalidatePath(`/leads/${parsed.data.leadId}`);
  }

  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok
      ? `Snoozed until ${until.toISOString().slice(0, 16).replace('T', ' ')}.`
      : undefined,
  };
}
