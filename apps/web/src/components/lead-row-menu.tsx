'use client';

/**
 * The per-row `⋯` action menu for the Leads table (A03).
 *
 * Accessibility is the reason this is a component rather than a bare glyph in a cell.
 * The trigger is a real `<summary>` inside `<details>`, so it is keyboard reachable and
 * its expanded state is exposed to assistive technology — but an ellipsis on its own
 * reads as nothing, so every instance carries its own name:
 * `aria-label="Actions for <person>"`. A screen with twenty-five identical unlabelled
 * ellipses is unusable with a screen reader, which is the defect this avoids.
 *
 * The actions are real. The entries above the divider are links to surfaces that exist.
 * Archive and Move to Trash post to the bulk server action for a single id, so the row
 * menu and the bulk bar cannot diverge in what they enforce — the same permission checks
 * and the same repository mutations run for both. The outcome is announced inline, so a
 * refusal is visible rather than a silent no-op.
 */
import { useActionState, useEffect, useId, useRef, type ReactElement } from 'react';

import { bulkLeadAction } from '@/app/b/[slug]/leads/bulk-actions';
import type { BulkLeadActionResult } from '@/app/b/[slug]/leads/bulk-action-contract';

const IDLE: BulkLeadActionResult = { ok: false, error: null, outcome: null };

/**
 * `useActionState` passes the previous result as the first argument, so the shared bulk
 * action is adapted here rather than carrying a state-shaped signature for one caller.
 */
async function runRowAction(
  previous: BulkLeadActionResult,
  formData: FormData,
): Promise<BulkLeadActionResult> {
  return bulkLeadAction(previous, formData);
}

export interface LeadRowMenuProps {
  readonly businessSlug: string;
  readonly leadId: string;
  readonly personName: string;
  readonly canArchive: boolean;
  readonly canDelete: boolean;
}

export function LeadRowMenu({
  businessSlug,
  leadId,
  personName,
  canArchive,
  canDelete,
}: LeadRowMenuProps): ReactElement {
  const [state, formAction, pending] = useActionState(runRowAction, IDLE);
  const details = useRef<HTMLDetailsElement>(null);
  const statusId = useId();

  const label = `Actions for ${personName}`;

  // A completed action closes the menu, so the next click does not land on a stale panel.
  useEffect(() => {
    if (state.outcome !== null && details.current !== null) details.current.open = false;
  }, [state]);

  return (
    <details className="nx-row-menu" ref={details}>
      <summary aria-label={label} title={label}>
        <span aria-hidden="true">⋯</span>
      </summary>

      <div className="nx-row-menu__panel">
        <ul className="nx-row-menu__list">
          <li>
            <a className="nx-row-menu__item" href={`/b/${businessSlug}/leads/${leadId}`}>
              Open lead
            </a>
          </li>
          <li>
            <a className="nx-row-menu__item" href={`/leads/${leadId}/edit`}>
              Edit lead
            </a>
          </li>
          <li>
            <a className="nx-row-menu__item" href={`/tasks/new?lead=${leadId}`}>
              Add task
            </a>
          </li>
          {canArchive && (
            <li>
              <form className="nx-row-menu__form" action={formAction}>
                <input type="hidden" name="businessSlug" value={businessSlug} />
                <input type="hidden" name="leadIds" value={leadId} />
                <input type="hidden" name="operation" value="archive" />
                <button className="nx-row-menu__item" type="submit" disabled={pending}>
                  Archive
                </button>
              </form>
            </li>
          )}
          {canDelete && (
            <li>
              <form className="nx-row-menu__form" action={formAction}>
                <input type="hidden" name="businessSlug" value={businessSlug} />
                <input type="hidden" name="leadIds" value={leadId} />
                <input type="hidden" name="operation" value="delete" />
                <button
                  className="nx-row-menu__item nx-row-menu__item--danger"
                  type="submit"
                  disabled={pending}
                >
                  Move to Trash
                </button>
              </form>
            </li>
          )}
        </ul>

        {pending && <p className="nx-row-menu__result">Working…</p>}
        {!pending && state.error !== null && (
          <p className="nx-row-menu__result nx-row-menu__result--error" role="alert" id={statusId}>
            {state.error}
          </p>
        )}
        {!pending && state.error === null && state.outcome !== null && (
          <p className="nx-row-menu__result" role="status">
            {state.outcome.summary}
          </p>
        )}
      </div>
    </details>
  );
}
