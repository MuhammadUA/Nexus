'use client';

/**
 * Reactivation control (A09).
 *
 * Opening the review is the only mutation this screen performs: it moves the
 * enrollment to `reactivation_due` and makes the lead's next action a
 * reactivation. The message itself is written by a human, because
 * spec `lead_lifecycle.reactivation` requires a new angle rather than a repeat of
 * the old sequence — a generated repeat is exactly what the rule forbids.
 */
import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Stack } from '@nexus/ui';

import { openReactivationAction, type ActionResult } from '@/app/b/[slug]/reactivation/actions';

const INITIAL: ActionResult = { ok: false, error: null };

export function OpenReactivationAction({
  leadId,
  businessSlug,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(openReactivationAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <Stack size="sm">
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
          Open reactivation on this lead
        </Button>
        <span className="nx-hint">
          This flags the lead for a reactivation review and schedules the next action. It sends nothing and generates
          nothing — write the new angle yourself, from the signal above.
        </span>
      </Stack>
    </form>
  );
}
