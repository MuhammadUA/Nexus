'use server';

/**
 * Bulk lead operations for A03 (Leads).
 *
 * The frame specifies `Assign owner · Change Primary ICP · Change sender · Archive ·
 * Delete` as the bulk-actions bar under the table. Until now the control existed only
 * in the contract comment on the page, so the bar could not be built: there was no
 * server entry point at all.
 *
 * Four rules shape this file.
 *
 *   1. **A Server Action is a public endpoint.** Once its module has been rendered
 *      anywhere, a client can post to it without ever loading the page, so each entry
 *      point re-checks the same route requirement the Leads page declares and then the
 *      *fine-grained* permission for the specific operation. Hiding a button is not
 *      authorization, and neither is the route check on its own.
 *
 *   2. **The database is asked per row, and the answer is counted.** Every mutation goes
 *      through the existing repository function, which runs inside `withActor` and is
 *      therefore filtered by row-level security. One lead the operator may not touch does
 *      not silently take the other twenty-four with it, and the outcome reports the real
 *      split rather than "Done".
 *
 *   3. **No new SQL where an equivalent exists.** Owner, Primary ICP (through the audited
 *      `set_primary_icp` RPC), sender identity, status, soft delete and permanent delete
 *      all already have repository mutations carrying their invariants and audit events.
 *      This file composes them; it does not re-implement them.
 *
 *   4. **Bounded.** `MAX_BULK_LEADS` caps one request, so a hand-crafted post cannot turn
 *      a single click into an unbounded loop.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { effectivePermissions, hasPermission, type Permission } from '@nexus/core';

import { formString, formStrings } from '@/lib/form-data';
import { authorizeAction } from '@/lib/route-guard';
import { loadViewerContext, type ViewerContext } from '@/lib/viewer-context';
import {
  permanentDeleteLead,
  softDeleteLead,
  updateLead,
  type MutationResult,
} from '@/lib/repo/leads';

/**
 * The operation list, the permanent-delete sentinel and the result interfaces live in
 * `bulk-action-contract.ts`.
 *
 * A `'use server'` module may export only async functions, so exporting them from here failed the
 * production build ("Only async functions are allowed to be exported in a 'use server' file"). The
 * contract is imported below and re-exported as **types only**, which is erased at compile time and
 * therefore permitted.
 */
export type {
  BulkLeadAction,
  BulkLeadActionResult,
  BulkLeadOperation,
  BulkLeadOutcome,
} from './bulk-action-contract';

import {
  BULK_LEAD_OPERATIONS,
  BULK_LEAD_PERMANENT_DELETE,
  type BulkLeadAction,
  type BulkLeadActionResult,
  type BulkLeadOutcome,
} from './bulk-action-contract';

/** One request touches at most this many leads. */
const MAX_BULK_LEADS = 100;

const uuid = z.string().uuid();

const requestSchema = z.object({
  businessSlug: z.string().trim().min(1).max(120),
  operation: z.enum([...BULK_LEAD_OPERATIONS, BULK_LEAD_PERMANENT_DELETE]),
  leadIds: z.array(uuid).min(1).max(MAX_BULK_LEADS),
  ownerUserId: z.string().trim().max(60),
  primaryIcpId: z.string().trim().max(60),
  outreachIdentityId: z.string().trim().max(60),
  confirmation: z.string().trim().max(200),
});

/**
 * The fine-grained permission each operation requires.
 *
 * `lead.archive` is declared in `packages/core/src/permissions.ts` but no repository
 * operation consumed it before A03's Archive, so the check lives here rather than being
 * implied by the route.
 */
const REQUIRED_PERMISSION: Readonly<Record<BulkLeadAction, Permission>> = {
  assign_owner: 'lead.assign_owner',
  change_primary_icp: 'lead.change_primary_icp',
  change_sender: 'lead.change_sender_identity',
  archive: 'lead.archive',
  delete: 'lead.soft_delete',
  permanent_delete: 'lead.permanent_delete',
};

/**
 * The literal string permanent deletion requires.
 *
 * The same value is required by `public.permanent_delete_lead`, so a caller that
 * bypassed this check still could not delete anything.
 */
const PERMANENT_DELETE_CONFIRMATION = 'DELETE';

/** Past-tense label per operation, for the outcome sentence. */
const OPERATION_LABEL: Readonly<Record<BulkLeadAction, string>> = {
  assign_owner: 'Assigned owner on',
  change_primary_icp: 'Changed Primary ICP on',
  change_sender: 'Changed sender on',
  archive: 'Archived',
  delete: 'Moved to Trash',
  permanent_delete: 'Permanently deleted',
};

const NOTHING_SELECTED = 'Select at least one lead first.';
const TOO_MANY = `A single bulk action is limited to ${String(MAX_BULK_LEADS)} leads.`;

/**
 * Bridging the two actor types.
 *
 * `@/lib/actor` models the *request* actor — who is signed in — and deliberately does not
 * carry the role, because RLS decides what that actor may read. `@nexus/core` models the
 * *permission* actor, whose `UserActor` requires a role so that `hasPermission` can reason
 * about the role default. They are different types on purpose, and the bridge is an
 * explicit construction rather than a cast: a cast here would let a permission check run
 * against an actor whose role was never established, which is the one thing this function
 * exists to prevent.
 */
type CoreActor = Parameters<typeof hasPermission>[0];

function toCoreActor(viewer: ViewerContext['viewer']): CoreActor | null {
  /**
   * An API-client actor is deliberately NOT bridged.
   *
   * `@nexus/core`'s `ApiClientActor` requires `name`, `scopes` and `businessIds`, and
   * `hasPermission` reasons about those scopes. The request actor carries only `apiClientId`, so
   * there is nothing to reconstruct a permission actor from. Fabricating one with empty scopes or
   * empty `businessIds` would be worse than refusing: empty scopes silently deny everything (making a
   * bug look like a permissions problem), and fields guessed from elsewhere could grant a write the
   * token never held.
   *
   * Returning null denies. That is the correct direction — the bulk bar is a browser surface driven
   * by a signed-in operator, so a service token calling it is out of contract. The database still
   * enforces every rule on the write itself, so a refusal here can only ever be too strict, never too
   * permissive.
   */
  if (viewer.actor.kind === 'api_client') return null;
  if (viewer.userId === null || viewer.role === null) return null;
  return { kind: 'user', userId: viewer.userId, role: viewer.role };
}

/**
 * Whether the viewer holds `permission` for this specific business.
 *
 * The union of permissions across every business is deliberately not consulted: a grant
 * in one business must not authorise a bulk write in another. `effectivePermissions` is
 * the same function the viewer context uses, so the button and the action agree.
 */
function permits(context: ViewerContext, permission: Permission, businessId: string): boolean {
  // A service actor (bootstrap/seed) bypasses RLS and holds every permission. The app
  // actor spells that `service`; the core actor spells it `system`.
  if (context.viewer.actor.kind === 'service') return true;

  const actor = toCoreActor(context.viewer);
  if (actor === null) return false;

  const grant = context.grants.find((candidate) => candidate.businessId === businessId);
  if (grant === undefined) return false;

  const role = context.viewer.role;
  if (role === null) return false;

  return hasPermission(actor, effectivePermissions(role, grant, businessId), permission);
}

/** The refusal shape shared by every early return. */
function refuse(error: string): BulkLeadActionResult {
  return { ok: false, error, outcome: null };
}

interface Tally {
  succeeded: number;
  failed: number;
  firstError: string | null;
}

/** Runs one repository mutation per lead and counts what the database accepted. */
async function runAll(
  leadIds: readonly string[],
  mutate: (leadId: string) => Promise<MutationResult>,
): Promise<Tally> {
  let succeeded = 0;
  let failed = 0;
  let firstError: string | null = null;

  for (const leadId of leadIds) {
    try {
      const result = await mutate(leadId);
      if (result.ok) {
        succeeded += 1;
      } else {
        failed += 1;
        firstError ??= result.error ?? 'The database refused one of the selected leads.';
      }
    } catch (error) {
      failed += 1;
      firstError ??= error instanceof Error ? error.message : String(error);
    }
  }

  return { succeeded, failed, firstError };
}

/**
 * Applies one bulk operation to the selected leads.
 *
 * Returns `outcome` with real counts in every case that reached the database, so the bar
 * can render "18 of 20 archived · 2 refused" instead of a bare success.
 *
 * The first parameter exists only to satisfy `useActionState`, whose action type is
 * `(state, payload) => state`. The bar is a one-shot command with no accumulation, so the previous
 * state is genuinely unused — it is typed `FormData | void` to stay assignable to what the hook
 * passes, rather than being declared `unknown` and then narrowed for no reason. The real payload is
 * always the `FormData`.
 */
export async function bulkLeadAction(
  _previousState: BulkLeadActionResult | void,
  formData: FormData,
): Promise<BulkLeadActionResult> {
  const parsed = requestSchema.safeParse({
    businessSlug: formString(formData, 'businessSlug', ''),
    operation: formString(formData, 'operation', 'archive'),
    leadIds: formStrings(formData, 'leadIds'),
    ownerUserId: formString(formData, 'ownerUserId', ''),
    primaryIcpId: formString(formData, 'primaryIcpId', ''),
    outreachIdentityId: formString(formData, 'outreachIdentityId', ''),
    confirmation: formString(formData, 'confirmation', ''),
  });

  if (!parsed.success) {
    return refuse(formStrings(formData, 'leadIds').length > MAX_BULK_LEADS ? TOO_MANY : NOTHING_SELECTED);
  }

  const request = parsed.data;
  const { operation, businessSlug, leadIds } = request;

  // `loadViewerContext` 404s the business for a viewer who cannot see it, which is the
  // same treatment the page gives. Held here so the route and permission checks share
  // one resolution of the business rather than two.
  const context = await loadViewerContext();
  const business = context.businesses.find((candidate) => candidate.key === businessSlug);
  if (business === undefined) return refuse('That business could not be found.');

  // Independently authorized: a Server Action is reachable without its page.
  const routeRefusal = await authorizeAction(context, {
    route: '/b/:businessSlug/leads',
    businessId: business.id,
  });
  if (routeRefusal !== null) return refuse(routeRefusal.error);

  if (!permits(context, REQUIRED_PERMISSION[operation], business.id)) {
    return refuse(`You do not have permission to ${operation.replace(/_/g, ' ')} on this business.`);
  }

  const viewer = context.viewer;
  let tally: Tally;

  switch (operation) {
    case 'assign_owner': {
      if (!uuid.safeParse(request.ownerUserId).success) {
        return refuse('Choose the owner to assign.');
      }
      const ownerUserId = request.ownerUserId;
      tally = await runAll(leadIds, (leadId) => updateLead(viewer, leadId, { ownerUserId }));
      break;
    }

    case 'change_primary_icp': {
      if (!uuid.safeParse(request.primaryIcpId).success) {
        return refuse('Choose the Primary ICP to apply.');
      }
      const primaryIcpId = request.primaryIcpId;
      tally = await runAll(leadIds, (leadId) => updateLead(viewer, leadId, { primaryIcpId }));
      break;
    }

    case 'change_sender': {
      if (!uuid.safeParse(request.outreachIdentityId).success) {
        return refuse('Choose the sender identity to apply.');
      }
      const outreachIdentityId = request.outreachIdentityId;
      tally = await runAll(leadIds, (leadId) => updateLead(viewer, leadId, { outreachIdentityId }));
      break;
    }

    case 'archive': {
      // Archive keeps the row and parks outreach. `archived` is the stored lifecycle
      // state, and `OUTREACH_BLOCKING_LEAD_STATES` reads it as "do not contact", so the
      // lead genuinely stops rather than merely being labelled.
      tally = await runAll(leadIds, (leadId) => updateLead(viewer, leadId, { status: 'archived' }));
      break;
    }

    case 'delete': {
      tally = await runAll(leadIds, (leadId) => softDeleteLead(viewer, leadId));
      break;
    }

    case 'permanent_delete': {
      if (request.confirmation !== PERMANENT_DELETE_CONFIRMATION) {
        return refuse(`Permanent deletion needs the confirmation word "${PERMANENT_DELETE_CONFIRMATION}".`);
      }
      const confirmation = request.confirmation;
      tally = await runAll(leadIds, (leadId) => permanentDeleteLead(viewer, leadId, confirmation));
      break;
    }

    default: {
      // Exhaustive: `operation` is a union of the cases above. This keeps a future
      // added operation from silently doing nothing.
      const exhaustive: never = operation;
      return refuse(`Unsupported bulk operation: ${String(exhaustive)}`);
    }
  }

  const outcome: BulkLeadOutcome = {
    operation,
    succeeded: tally.succeeded,
    failed: tally.failed,
    summary: describeOutcome(operation, leadIds.length, tally),
  };

  if (tally.succeeded > 0) {
    revalidatePath(`/b/${businessSlug}/leads`);
    revalidatePath('/my-day');
  }

  return {
    // `ok` means "every selected lead was changed". A partial result is reported as a
    // failure carrying its counts, so the UI cannot show a green banner over a refusal.
    ok: tally.failed === 0 && tally.succeeded > 0,
    error: tally.failed === 0 ? null : (tally.firstError ?? 'Some of the selected leads were refused.'),
    outcome,
  };
}

/** The honest one-liner: how many of how many, and why the rest were refused. */
function describeOutcome(operation: BulkLeadAction, selected: number, tally: Tally): string {
  const label = OPERATION_LABEL[operation];
  if (tally.failed === 0) {
    return `${label} ${String(tally.succeeded)} of ${String(selected)} selected leads.`;
  }
  if (tally.succeeded === 0) {
    return `No leads changed: all ${String(selected)} were refused.`;
  }
  return `${label} ${String(tally.succeeded)} of ${String(selected)}; ${String(tally.failed)} refused.`;
}
