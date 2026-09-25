'use client';

import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Stack } from '@nexus/ui';

import { restoreLeadAction } from '@/app/(app)/trash/actions';

/** Mirrored result shape: a client component may only import functions from `'use server'`. */
interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly message?: string;
}

const INITIAL: ActionResult = { ok: false, error: null };

/**
 * U21 — the only write on this screen.
 *
 * Contract: "Restore deleted leads; no permanent deletion for normal user."
 * spec `roles_and_permissions.user.cannot`: "Permanently delete records".
 *
 * There is deliberately no permanent-delete control in this file or anywhere else on the
 * user surface; the admin path for that lives behind `lead.permanent_delete`, which is in
 * `ADMIN_ONLY_PERMISSIONS` and can never be granted to a normal user.
 *
 * `public.restore_lead` re-checks the invariant that a person may have only one active
 * lead per business, so a restore that would collide reports the real reason.
 */
export function RestoreLeadButton({
  leadId,
  disabled = false,
}: {
  readonly leadId: string;
  readonly disabled?: boolean;
}): ReactElement {
  const [state, formAction, pending] = useActionState(restoreLeadAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
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
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          busy={pending}
          disabled={disabled}
          title={disabled ? 'You can restore a lead you own or created.' : 'Restore this lead'}
        >
          Restore
        </Button>
      </Stack>
    </form>
  );
}
