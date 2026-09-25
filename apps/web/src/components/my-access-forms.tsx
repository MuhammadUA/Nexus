'use client';

import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Field, Select, Stack, TextInput } from '@nexus/ui';

import {
  bindIdentityBusinessAction,
  grantSelfAccessAction,
  selfAssignIdentityAction,
  type ActionResult,
} from '@/app/(app)/my-access/actions';

const INITIAL: ActionResult = { ok: false, error: null };

function StateAlerts({ state }: { readonly state: ActionResult }): ReactElement {
  return (
    <>
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
    </>
  );
}

/**
 * spec `admin_self_assignment_and_domains.admin_self_assignment`:
 * "Admin may grant themselves business access."
 *
 * `access_level` is the database's own vocabulary — `admin | manager | user` — so what
 * the screen offers and what the CHECK constraint accepts cannot drift apart.
 */
export function SelfGrantForm({
  businesses,
}: {
  readonly businesses: readonly {
    readonly id: string;
    readonly name: string;
    readonly granted: boolean;
  }[];
}): ReactElement {
  const [state, formAction, pending] = useActionState(grantSelfAccessAction, INITIAL);

  return (
    <form action={formAction}>
      <Stack size="sm">
        <Field
          label="Business"
          htmlFor="self-grant-business"
          required
          hint="Businesses you already hold a grant for are marked; saving again updates that grant."
        >
          <Select
            id="self-grant-business"
            name="businessId"
            defaultValue=""
            required
            placeholder="Choose a business"
            options={businesses.map((business) => ({
              value: business.id,
              label: business.granted ? `${business.name} (already granted)` : business.name,
            }))}
          />
        </Field>

        <Field
          label="Access level"
          htmlFor="self-grant-level"
          required
          hint="admin manages this business, manager manages its team's leads, user works assigned leads."
        >
          <Select
            id="self-grant-level"
            name="accessLevel"
            defaultValue="admin"
            options={[
              { value: 'admin', label: 'admin' },
              { value: 'manager', label: 'manager' },
              { value: 'user', label: 'user' },
            ]}
          />
        </Field>

        <fieldset className="nx-stack nx-stack--sm">
          <legend className="nx-label">Capabilities inside this business</legend>
          <label className="nx-row" htmlFor="self-grant-manage">
            <input id="self-grant-manage" type="checkbox" name="canManageLeads" defaultChecked />
            <span>Manage leads (edit, assign, change primary ICP and sender identity)</span>
          </label>
          <label className="nx-row" htmlFor="self-grant-sources">
            <input id="self-grant-sources" type="checkbox" name="canUseLeadSources" />
            <span>Use lead sources (import and discovery)</span>
          </label>
          <label className="nx-row" htmlFor="self-grant-queue">
            <input id="self-grant-queue" type="checkbox" name="canUseProfileQueue" />
            <span>Use the profile queue</span>
          </label>
          <label className="nx-row" htmlFor="self-grant-delete">
            <input id="self-grant-delete" type="checkbox" name="canDeleteLeads" />
            <span>Soft-delete leads</span>
          </label>
        </fieldset>

        <StateAlerts state={state} />

        <div className="nx-row">
          <Button type="submit" variant="primary" busy={pending}>
            Grant myself access
          </Button>
        </div>
      </Stack>
    </form>
  );
}

/**
 * Self-assign an outreach identity.
 *
 * spec: "Admin may self-assign an unassigned outreach identity. If identity is
 * assigned to someone else, require explicit transfer confirmation and audit event."
 *
 * The takeover path renders a real confirmation checkbox plus an optional note, so
 * neither the browser nor the server can treat the transfer as an ordinary click. The
 * repository then writes `identity_transfers` and `audit_events`; the DB CHECK
 * constraint `confirmed = true or from_user_id is null` refuses an unconfirmed
 * transfer even if this control were removed.
 */
export function IdentityAssignForm({
  identityId,
  displayName,
  currentManagerLabel,
}: {
  readonly identityId: string;
  readonly displayName: string;
  /** null when the identity is unassigned. */
  readonly currentManagerLabel: string | null;
}): ReactElement {
  const [state, formAction, pending] = useActionState(selfAssignIdentityAction, INITIAL);
  const requiresTransfer = currentManagerLabel !== null;

  return (
    <form action={formAction}>
      <input type="hidden" name="identityId" value={identityId} />
      <Stack size="sm">
        {requiresTransfer && (
          <>
            <Alert accent="amber" title="This identity belongs to someone else">
              It is currently managed by {currentManagerLabel}. Taking it over is recorded as a transfer with your
              account as the actor, and is written to the audit log.
            </Alert>
            <label className="nx-row" htmlFor={`confirm-${identityId}`}>
              <input id={`confirm-${identityId}`} type="checkbox" name="confirmed" />
              <span>
                I confirm I want to transfer <strong>{displayName}</strong> to myself
              </span>
            </label>
            <Field label="Transfer note" htmlFor={`note-${identityId}`} hint="Optional, stored on the transfer row.">
              <TextInput id={`note-${identityId}`} name="note" defaultValue="" />
            </Field>
          </>
        )}

        <StateAlerts state={state} />

        <div className="nx-row">
          <Button type="submit" variant={requiresTransfer ? 'danger' : 'secondary'} busy={pending}>
            {requiresTransfer ? 'Transfer to me' : 'Assign to me'}
          </Button>
        </div>
      </Stack>
    </form>
  );
}

/**
 * Bind a business to one of my identities.
 *
 * spec `extension_visibility_rule`: visible businesses in the Companion are the
 * intersection of my business access and the selected identity's business access, so
 * an identity with nothing bound is unusable no matter what I can see.
 */
export function BindIdentityBusinessForm({
  identityId,
  businesses,
}: {
  readonly identityId: string;
  readonly businesses: readonly { readonly id: string; readonly name: string }[];
}): ReactElement {
  const [state, formAction, pending] = useActionState(bindIdentityBusinessAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="identityId" value={identityId} />
      <Stack size="sm">
        <Field label="Add a business to this identity" htmlFor={`bind-${identityId}`} required>
          <Select
            id={`bind-${identityId}`}
            name="businessId"
            defaultValue=""
            required
            placeholder="Choose a business"
            options={businesses.map((business) => ({ value: business.id, label: business.name }))}
          />
        </Field>

        <StateAlerts state={state} />

        <div className="nx-row">
          <Button type="submit" variant="secondary" busy={pending}>
            Bind business
          </Button>
        </div>
      </Stack>
    </form>
  );
}
