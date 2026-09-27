'use client';

/**
 * The bulk-actions bar for A03 (Leads).
 *
 * The frame places a highlighted band under the table reading
 * `Assign owner · Change Primary ICP · Change sender · Archive · Delete`. This is the
 * control for it: one form over the table's row checkboxes, one operation at a time.
 *
 * Three things are deliberate.
 *
 *   1. **The buttons are never disabled.** `lead.assign_owner`, `lead.change_primary_icp`
 *      and the rest are checked on the server, per operation. With nothing selected the
 *      server answers "Select at least one lead first" — the click is answered rather
 *      than doing nothing.
 *
 *   2. **The pickers are always in the DOM.** Owner, ICP and sender are each submitted
 *      with every operation; the server ignores the ones that do not apply and refuses
 *      when the one that does is empty. That keeps a single form instead of five, and
 *      keeps the no-JavaScript path working.
 *
 *   3. **The outcome is counted, not asserted.** "Archived 18 of 20; 2 refused" is what
 *      the server returns and what is rendered. A green banner over a partial failure is
 *      the specific dishonesty a bulk control invites.
 *
 * The five buttons are native `<button>` elements carrying `nx-btn` classes rather than
 * the `Button` primitive, because each one must submit its own `name="operation"` value
 * and the primitive's props do not include `name`/`value`.
 */
import { Alert } from '@nexus/ui';
import { useActionState, useEffect, useState, type ReactElement } from 'react';

import { bulkLeadAction } from '@/app/b/[slug]/leads/bulk-actions';
import type { BulkLeadActionResult } from '@/app/b/[slug]/leads/bulk-action-contract';

const IDLE: BulkLeadActionResult = { ok: false, error: null, outcome: null };

export interface BulkChoice {
  readonly value: string;
  readonly label: string;
}

interface BulkButton {
  readonly operation: string;
  readonly label: string;
  readonly variant: 'secondary' | 'danger';
  /** The picker this operation needs; the others are ignored by the server. */
  readonly hint: string;
}

/** The frame's list, in the frame's order. */
const BULK_BUTTONS: readonly BulkButton[] = [
  { operation: 'assign_owner', label: 'Assign owner', variant: 'secondary', hint: 'Owner' },
  {
    operation: 'change_primary_icp',
    label: 'Change Primary ICP',
    variant: 'secondary',
    hint: 'Primary ICP',
  },
  { operation: 'change_sender', label: 'Change sender', variant: 'secondary', hint: 'Sender identity' },
  { operation: 'archive', label: 'Archive', variant: 'secondary', hint: 'no picker needed' },
  { operation: 'delete', label: 'Delete', variant: 'danger', hint: 'moves the leads to Trash' },
];

export interface LeadBulkBarProps {
  readonly businessSlug: string;
  /** The `id` of the form that carries the row checkboxes. */
  readonly formId: string;
  readonly owners: readonly BulkChoice[];
  readonly icps: readonly BulkChoice[];
  readonly identities: readonly BulkChoice[];
  readonly canAssignOwner: boolean;
  readonly canChangeIcp: boolean;
  readonly canChangeSender: boolean;
  readonly canArchive: boolean;
  readonly canDelete: boolean;
}

export function LeadBulkBar({
  businessSlug,
  formId,
  owners,
  icps,
  identities,
  canAssignOwner,
  canChangeIcp,
  canChangeSender,
  canArchive,
  canDelete,
}: LeadBulkBarProps): ReactElement {
  const [state, formAction, pending] = useActionState(bulkLeadAction, IDLE);
  const [selected, setSelected] = useState(0);

  const allowed: Readonly<Record<string, boolean>> = {
    assign_owner: canAssignOwner,
    change_primary_icp: canChangeIcp,
    change_sender: canChangeSender,
    archive: canArchive,
    delete: canDelete,
  };

  // Only the operations this viewer may actually perform. A viewer with none of them sees the
  // band render nothing rather than five buttons that all refuse.
  const availableButtons = BULK_BUTTONS.filter((button) => allowed[button.operation] === true);

  // The row checkboxes belong to this form through the `form` attribute, so the count is
  // read from the form itself rather than lifted into React state: the form owns the
  // submitted values, and two sources of truth for "what is selected" would drift.
  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;

    const recount = (): void => {
      setSelected(new FormData(form).getAll('leadIds').length);
    };

    recount();
    form.addEventListener('change', recount);
    return () => {
      form.removeEventListener('change', recount);
    };
  }, [formId]);

  return (
    <section className="nx-bulk-bar" aria-label="Bulk actions">
      <form id={formId} action={formAction} className="nx-bulk-bar__form">
        <input type="hidden" name="businessSlug" value={businessSlug} />

        <div className="nx-bulk-bar__title">
          <span className="nx-overline">Bulk actions</span>
          <span className="nx-bulk-bar__count">
            {selected === 0
              ? 'No leads selected'
              : `${String(selected)} lead${selected === 1 ? '' : 's'} selected`}
          </span>
        </div>

        {/* The operation is carried by the button that was pressed, so there is no
            `operation` field here: a hidden one would be submitted *before* the button's
            own entry and would win in `formString`, which reads the last value. */}

        <div className="nx-bulk-bar__field">
          <label className="nx-label" htmlFor="bulk-owner">
            Owner
          </label>
          <select id="bulk-owner" className="nx-select" name="ownerUserId" defaultValue="">
            <option value="">Choose an owner</option>
            {owners.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="nx-bulk-bar__field">
          <label className="nx-label" htmlFor="bulk-icp">
            Primary ICP
          </label>
          <select id="bulk-icp" className="nx-select" name="primaryIcpId" defaultValue="">
            <option value="">Choose an ICP</option>
            {icps.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="nx-bulk-bar__field">
          <label className="nx-label" htmlFor="bulk-identity">
            Sender identity
          </label>
          <select id="bulk-identity" className="nx-select" name="outreachIdentityId" defaultValue="">
            <option value="">Choose a sender</option>
            {identities.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="nx-bulk-bar__actions">
          {availableButtons.map((button) => (
            <button
              key={button.operation}
              type="submit"
              className={`nx-btn nx-btn--${button.variant} nx-btn--sm`}
              name="operation"
              value={button.operation}
              disabled={pending}
              title={`${button.label} — uses: ${button.hint}`}
            >
              {button.label}
            </button>
          ))}
        </div>

        <div className="nx-bulk-bar__result" aria-live="polite">
          {pending && <span className="nx-hint">Applying to the selected leads…</span>}
          {!pending && state.outcome !== null && (
            <Alert accent={state.ok ? 'green' : 'amber'} role="status" title="Bulk result">
              {state.outcome.summary}
            </Alert>
          )}
          {!pending && state.outcome === null && state.error !== null && (
            <Alert accent="red" role="alert" title="Bulk action refused">
              {state.error}
            </Alert>
          )}
        </div>
      </form>
    </section>
  );
}
