'use client';

import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Field, Stack, TextArea, TextInput } from '@nexus/ui';

import { snoozeLeadAction } from '@/app/(app)/snooze/actions';

/** Mirrored result shape: a client component may only import functions from `'use server'`. */
interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly message?: string;
}

const INITIAL: ActionResult = { ok: false, error: null };

/** spec `screen_inventory` U19 — the four choices, in the spec's order. */
export const SNOOZE_PRESETS = ['tomorrow', 'two_days', 'next_week', 'custom'] as const;

export const SNOOZE_PRESET_LABELS: Readonly<Record<string, string>> = {
  tomorrow: 'Tomorrow',
  two_days: 'In 2 days',
  next_week: 'Next week',
  custom: 'Custom date',
};

/**
 * U19 — Snooze & Reschedule.
 *
 * Contract: "Tomorrow/2 days/next week/custom date; optional reason."
 *
 * The presets are radio buttons (not a select) because they are the primary decision on
 * this screen and the spec lists them as a short fixed set; the custom datetime field is
 * read by the server only when `custom` is the chosen preset. Every input is
 * uncontrolled, so the browser owns what is submitted.
 */
export function SnoozeForm({ leadId }: { readonly leadId: string }): ReactElement {
  const [state, formAction, pending] = useActionState(snoozeLeadAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <Stack>
        <fieldset className="nx-field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="nx-label">Come back</legend>
          <Stack size="sm">
            {SNOOZE_PRESETS.map((preset, index) => (
              <label key={preset} className="nx-row" style={{ gap: 'var(--nx-space-xs)' }}>
                <input type="radio" name="preset" value={preset} defaultChecked={index === 0} />
                <span>{SNOOZE_PRESET_LABELS[preset] ?? preset}</span>
              </label>
            ))}
          </Stack>
        </fieldset>

        <Field
          label="Custom date and time"
          htmlFor="snooze-custom"
          hint="Only used when Custom date is selected. Must be in the future."
        >
          <TextInput id="snooze-custom" name="customUntil" defaultValue="" type="datetime-local" />
        </Field>

        <Field
          label="Reason"
          htmlFor="snooze-reason"
          hint="Optional, and recorded on the lead timeline so the next operator knows why."
        >
          <TextArea id="snooze-reason" name="reason" defaultValue="" rows={2} />
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
          Snooze
        </Button>
      </Stack>
    </form>
  );
}
