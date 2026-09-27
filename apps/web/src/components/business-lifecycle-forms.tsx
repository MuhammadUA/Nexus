'use client';

/**
 * Row-level lifecycle controls for the Businesses hub (A10).
 *
 * `archiveBusinessAction`, `restoreBusinessAction` and `deleteBusinessAction` already exist and are
 * typed (`LifecycleActionResult`). This file is the only thing that reaches them, and every control is
 * a real `<form>` posting to the action: there is no placeholder handler here.
 *
 * The trigger is the same row affordance the Leads table uses (`apps/web/src/app/b/[slug]/leads/
 * lead-row-menu.tsx`): a `⋯` summary inside `<details>`, carrying its own `aria-label="Lifecycle
 * actions for <business>"` so a column of identical glyphs is still usable with a screen reader. The
 * forms themselves open in a dialog rather than inside the dropdown: the panel holds a reason field, a
 * typed-key confirmation and, on a refused delete, an itemised census, and a floating panel inside a
 * scrolling table would clip all three.
 *
 * One branch carries the meaning. A permanent delete of a business that owns history is refused by
 * `deleteBusinessPermanently` *and* by a `BEFORE DELETE` trigger, and the refusal comes back as
 * `errorCode: 'business_has_protected_history'` with the census. The UI branches on that code — never
 * on the sentence, which is written for the operator and may be reworded — renders what would be
 * destroyed, and offers Archive, the supported way to close a business.
 */
import { useActionState, useRef, useState, type ReactElement } from 'react';

import { Alert, Button, Field, Modal, Row, Stack, TextInput } from '@nexus/ui';

import {
  archiveBusinessAction,
  deleteBusinessAction,
  restoreBusinessAction,
  type LifecycleActionResult,
} from '@/app/(app)/businesses/[id]/actions';

const INITIAL: LifecycleActionResult = { ok: false, error: null };

/** Which lifecycle form is open. `null` is "the menu is closed". */
type LifecyclePanel = 'archive' | 'restore' | 'delete';

/**
 * Labels for the `BusinessProtectedHistory` census.
 *
 * The count keys come from `packages/db/migrations/0023_business_lifecycle.sql` via
 * `getBusinessProtectedHistory`. An unknown key is humanised rather than dropped, so a census field
 * added later still appears instead of silently vanishing from the refusal.
 */
const HISTORY_LABELS: Readonly<Record<string, string>> = {
  leads: 'Leads',
  peopleLinked: 'People linked',
  companiesLinked: 'Companies linked',
  messageInstances: 'Message instances',
  sentMessages: 'Sent messages',
  messageEvents: 'Message events',
  conversations: 'Conversations',
  replies: 'Replies',
  interactions: 'Interactions',
  notes: 'Notes',
  tasks: 'Tasks',
  sourceEvidence: 'Source evidence',
  importBatches: 'Import batches',
  auditEvents: 'Audit events',
  agentRuns: 'Agent runs',
  researchSnapshots: 'Research snapshots',
};

function historyLabel(key: string): string {
  return HISTORY_LABELS[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/** Errors are announced; successes are polite. Never both. */
function Result({ state }: { readonly state: LifecycleActionResult }): ReactElement | null {
  if (typeof state.error === 'string' && state.error.length > 0) {
    return (
      <Alert accent="red" role="alert">
        {state.error}
      </Alert>
    );
  }
  if (state.message !== undefined) {
    return (
      <Alert accent="green" role="status">
        {state.message}
      </Alert>
    );
  }
  return null;
}

/** The census a refused delete returns, itemised, so "protected history" is a number and not a phrase. */
function ProtectedHistory({
  counts,
}: {
  readonly counts: Readonly<Record<string, number>> | undefined;
}): ReactElement | null {
  if (counts === undefined) return null;

  const entries = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1]);
  if (entries.length === 0) return null;

  const total = entries.reduce((sum, [, value]) => sum + value, 0);

  return (
    <Stack size="sm">
      <span className="nx-hint">
        A permanent delete would destroy {String(total)} record{total === 1 ? '' : 's'}, and none of it can be
        reconstructed:
      </span>
      <Stack size="sm">
        {entries.map(([key, value]) => (
          <Row key={key} between>
            <span className="nx-hint">{historyLabel(key)}</span>
            <span className="nx-table__mono">{value}</span>
          </Row>
        ))}
      </Stack>
    </Stack>
  );
}

/**
 * The row-level lifecycle menu on the Businesses hub.
 *
 * Restore is offered only for an archived business, because that is the only state where
 * `restoreBusinessAction` changes anything. The hub deliberately lists archived businesses
 * (`listBusinessSummaries(..., { includeArchived: true })`): they are out of the sidebar, the switcher
 * and the Companion selector, and this is the one screen that can bring one back.
 */
export function BusinessLifecycleMenu({
  businessId,
  businessKey,
  businessName,
  status,
}: {
  readonly businessId: string;
  readonly businessKey: string;
  readonly businessName: string;
  readonly status: string;
}): ReactElement {
  const [panel, setPanel] = useState<LifecyclePanel | null>(null);
  const details = useRef<HTMLDetailsElement>(null);

  const [archiveState, archiveAction, archivePending] = useActionState(archiveBusinessAction, INITIAL);
  const [restoreState, restoreAction, restorePending] = useActionState(restoreBusinessAction, INITIAL);
  const [deleteState, deleteAction, deletePending] = useActionState(deleteBusinessAction, INITIAL);

  const archived = status === 'archived';
  const blockedByHistory = deleteState.errorCode === 'business_has_protected_history';
  const label = `Lifecycle actions for ${businessName}`;
  const close = (): void => setPanel(null);

  /** Opening a form closes the disclosure, so the menu is not left open behind the dialog. */
  function open(next: LifecyclePanel): void {
    if (details.current !== null) details.current.open = false;
    setPanel(next);
  }

  return (
    <>
      <details className="nx-row-menu" ref={details}>
        <summary aria-label={label} title={label}>
          <span aria-hidden="true">⋯</span>
        </summary>

        <div className="nx-row-menu__panel">
          <ul className="nx-row-menu__list">
            <li>
              <button
                type="button"
                className="nx-row-menu__item"
                onClick={() => open(archived ? 'restore' : 'archive')}
              >
                {archived ? 'Restore…' : 'Archive…'}
              </button>
            </li>
            <li>
              <button
                type="button"
                className="nx-row-menu__item nx-row-menu__item--danger"
                onClick={() => open('delete')}
              >
                Delete permanently…
              </button>
            </li>
          </ul>
        </div>
      </details>

      {panel === 'archive' && (
        <Modal title={`Archive ${businessName}`} onClose={close}>
          <form action={archiveAction}>
            <input type="hidden" name="businessId" value={businessId} />
            <Stack size="sm">
              <span className="nx-hint">
                Archiving stops new leads, enrolments and messages in this business and takes it out of the active
                selectors. Nothing is deleted, and it can be restored.
              </span>
              <Field
                label="Archive reason"
                htmlFor={`archive-reason-${businessId}`}
                hint="Optional, and recorded on the archive_business audit row."
              >
                <TextInput id={`archive-reason-${businessId}`} name="reason" defaultValue="" />
              </Field>
              <Result state={archiveState} />
              <Row between>
                <Button type="button" variant="ghost" size="sm" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" variant="secondary" size="sm" busy={archivePending}>
                  Archive business
                </Button>
              </Row>
            </Stack>
          </form>
        </Modal>
      )}

      {panel === 'restore' && (
        <Modal title={`Restore ${businessName}`} onClose={close}>
          <form action={restoreAction}>
            <input type="hidden" name="businessId" value={businessId} />
            <Stack size="sm">
              <span className="nx-hint">
                Restoring returns this business to the sidebar, the switcher and the Companion selector, and it
                accepts new work again. Drafts invalidated by the archive are not resurrected; they are regenerated.
              </span>
              <Result state={restoreState} />
              <Row between>
                <Button type="button" variant="ghost" size="sm" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" variant="secondary" size="sm" busy={restorePending}>
                  Restore business
                </Button>
              </Row>
            </Stack>
          </form>
        </Modal>
      )}

      {panel === 'delete' && (
        <Modal title={`Delete ${businessName} permanently`} onClose={close}>
          <Stack size="sm">
            <form action={deleteAction}>
              <input type="hidden" name="businessId" value={businessId} />
              <Stack size="sm">
                <Field
                  label={`Type "${businessKey}" to confirm`}
                  htmlFor={`delete-business-${businessId}`}
                  required
                  hint="Permanent and irreversible. A business that owns any history cannot be deleted — archive it instead."
                >
                  <TextInput
                    id={`delete-business-${businessId}`}
                    name="confirmation"
                    defaultValue=""
                    required
                    autoComplete="off"
                  />
                </Field>
                {/*
                  The typed refusal is a screen state, not a validation error, so it is rendered below as
                  the blocked-history panel plus an Archive control rather than as a form error.
                */}
                {blockedByHistory ? null : <Result state={deleteState} />}
                <Row between>
                  <Button type="button" variant="ghost" size="sm" onClick={close}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="danger" size="sm" busy={deletePending}>
                    Delete permanently
                  </Button>
                </Row>
              </Stack>
            </form>

            {blockedByHistory && (
              <Stack size="sm">
                <Alert accent="amber" role="alert" title="Deletion is blocked: this business has protected history">
                  {deleteState.error ?? 'This business has protected history and cannot be permanently deleted.'}
                </Alert>
                <ProtectedHistory counts={deleteState.protectedHistory} />
                <span className="nx-hint">
                  Archive is the safe alternative: the business leaves the active selectors and stops accepting new
                  work, while every record above stays readable. That is the difference between closing a business and
                  destroying it.
                </span>
                {/*
                  A refused delete on an already-archived business must not offer Archive again: that action is
                  idempotent and would only answer "already archived". The safe state it points at is where the
                  business already is.
                */}
                {archived ? (
                  <span className="nx-hint">
                    This business is already archived, which is the state deletion cannot reach. Restore it from the
                    row menu if it should be an active context again — its history was never at risk.
                  </span>
                ) : (
                  <form action={archiveAction}>
                    <input type="hidden" name="businessId" value={businessId} />
                    <input
                      type="hidden"
                      name="reason"
                      value="Archived instead of permanently deleting: this business has protected history."
                    />
                    <Stack size="sm">
                      <Result state={archiveState} />
                      <Button type="submit" variant="primary" size="sm" busy={archivePending}>
                        Archive this business instead
                      </Button>
                    </Stack>
                  </form>
                )}
              </Stack>
            )}
          </Stack>
        </Modal>
      )}
    </>
  );
}
