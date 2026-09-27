/**
 * The bulk-action contract, shared by the server action and the client controls that drive it.
 *
 * This lives outside `bulk-actions.ts` on purpose. That file starts with `'use server'`, and a
 * `'use server'` module may export **only async functions** — exporting the operation list or the
 * result interfaces from it fails the production build with "Only async functions are allowed to be
 * exported in a 'use server' file". The client component and the row menu both need these types and
 * the operation constant, so the contract has its own dependency-free module and the action
 * re-exports the types for server-side callers.
 *
 * Nothing here may import server-only code: it is pulled into the browser bundle.
 */

/** The operations the bulk bar offers, in the live Figma frame's order. */
export const BULK_LEAD_OPERATIONS = [
  'assign_owner',
  'change_primary_icp',
  'change_sender',
  'archive',
  'delete',
] as const;

export type BulkLeadOperation = (typeof BULK_LEAD_OPERATIONS)[number];

/**
 * Permanent deletion is a distinct, destructive path.
 *
 * It is admin-only and the database additionally requires the literal confirmation string, so it
 * cannot be reached by choosing a value in the bulk picker.
 */
export const BULK_LEAD_PERMANENT_DELETE = 'permanent_delete';

export type BulkLeadAction = BulkLeadOperation | typeof BULK_LEAD_PERMANENT_DELETE;

export interface BulkLeadOutcome {
  readonly operation: BulkLeadAction;
  /** Rows the database accepted. */
  readonly succeeded: number;
  /** Rows it refused, with the first refusal's reason as `error`. */
  readonly failed: number;
  /** One line an operator can read. Never a silent no-op. */
  readonly summary: string;
}

/**
 * The typed result every bulk action returns.
 *
 * `outcome` is present even on a partial failure, because "3 of 25 changed" is the real answer and
 * truncating it to `ok: false` would hide which three.
 */
export interface BulkLeadActionResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly outcome: BulkLeadOutcome | null;
}
