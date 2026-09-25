'use client';

/**
 * Trash controls (A08).
 *
 * Three separate forms, one per recoverable action, so a mis-click cannot chain
 * a restore into a delete. Permanent deletion additionally requires the operator
 * to type the literal string `DELETE PERMANENTLY`; the database requires the same
 * string and an admin actor, so the field is a usability guard, not the boundary.
 */
import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Field, Stack, TextInput } from '@nexus/ui';

import {
  permanentDeleteAction,
  restoreFromTrashAction,
  undoImportAction,
  type ActionResult,
} from '@/app/b/[slug]/trash/actions';
import { undoImportAction as undoImportFromHubAction } from '@/app/b/[slug]/lead-sources/actions';

const INITIAL: ActionResult = { ok: false, error: null };

export function RestoreFromTrashAction({
  leadId,
  businessSlug,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(restoreFromTrashAction, INITIAL);

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
        <Button type="submit" variant="secondary" size="sm" busy={pending}>
          Restore
        </Button>
      </Stack>
    </form>
  );
}

export function PermanentDeleteAction({
  leadId,
  businessSlug,
  personName,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
  readonly personName: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(permanentDeleteAction, INITIAL);
  const fieldId = `confirm-${leadId}`;

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <Stack size="sm">
        <Field
          label={`Type DELETE PERMANENTLY to erase ${personName}`}
          htmlFor={fieldId}
          required
          hint="Audited and irreversible. Prefer Restore or DNC."
        >
          <TextInput id={fieldId} name="confirmation" defaultValue="" autoComplete="off" required />
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
        <Button type="submit" variant="danger" size="sm" busy={pending}>
          Delete permanently
        </Button>
      </Stack>
    </form>
  );
}

export function UndoImportAction({
  batchId,
  businessSlug,
}: {
  readonly batchId: string;
  readonly businessSlug: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(undoImportAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="batchId" value={batchId} />
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
        <Button type="submit" variant="secondary" size="sm" busy={pending}>
          Undo import
        </Button>
      </Stack>
    </form>
  );
}

/**
 * The same undo, reachable from the Lead Sources hub.
 *
 * It posts to the hub's own action so the hub revalidates its batch table,
 * while the form itself is shared with Trash — the two screens cannot drift.
 */
export function UndoImportLink({
  batchId,
  businessSlug,
}: {
  readonly batchId: string;
  readonly businessSlug: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(undoImportFromHubAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="batchId" value={batchId} />
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
        <Button type="submit" variant="secondary" size="sm" busy={pending}>
          Undo
        </Button>
      </Stack>
    </form>
  );
}
