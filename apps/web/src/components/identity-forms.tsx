'use client';

/**
 * Client forms for A17 (Outreach Identity Detail) and the identities index.
 *
 * Inputs are uncontrolled (`defaultValue` + `name`) so the browser owns the payload.
 * The one thing with behaviour beyond plain submission is the transfer
 * confirmation: an identity that already belongs to another user can only change
 * hands when that box is ticked, and ticking it is what makes the repository write
 * the `identity_transfers` row and its audit event.
 */
import { useActionState, type ReactElement, type ReactNode } from 'react';

import { Alert, Button, Field, Select, Stack, TextArea, TextInput } from '@nexus/ui';

import {
  assignIdentityManagerAction,
  createIdentityAction,
  grantBusinessAction,
  revokeBusinessAction,
  updateIdentityAction,
  type ActionResult,
} from '@/app/(app)/identities/[id]/actions';

const INITIAL: ActionResult = { ok: false, error: null };

export interface SelectChoice {
  readonly value: string;
  readonly label: string;
}

function Result({ state }: { readonly state: ActionResult }): ReactElement | null {
  if (state.error !== null) {
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

function ActionShell({
  action,
  children,
  submitLabel,
  variant = 'primary',
  hidden,
}: {
  readonly action: (previous: ActionResult, formData: FormData) => Promise<ActionResult>;
  readonly children: ReactNode;
  readonly submitLabel: string;
  readonly variant?: 'primary' | 'secondary' | 'danger';
  readonly hidden: Readonly<Record<string, string>>;
}): ReactElement {
  const [state, formAction, pending] = useActionState(action, INITIAL);

  return (
    <form action={formAction}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Stack>
        {children}
        <Result state={state} />
        <Button type="submit" variant={variant} busy={pending}>
          {submitLabel}
        </Button>
      </Stack>
    </form>
  );
}

/* -------------------------------------------------------- identities index -- */

/**
 * Creates a sender identity.
 *
 * spec `identity_model.outreach_identity.fields`: platform, display name, profile
 * URL, manager, status and daily target. RLS permits the insert to an admin only
 * (`outreach_identities_insert`).
 */
export function CreateIdentityForm({
  users,
  platforms,
  statuses,
}: {
  readonly users: readonly SelectChoice[];
  readonly platforms: readonly string[];
  readonly statuses: readonly string[];
}): ReactElement {
  return (
    <ActionShell action={createIdentityAction} submitLabel="Add identity" hidden={{}}>
      <div className="nx-grid nx-grid--2">
        <Field
          label="Display name"
          htmlFor="new-identity-name"
          required
          hint="The account as it appears on the network, for example a person's name plus the platform."
        >
          <TextInput id="new-identity-name" name="displayName" defaultValue="" required />
        </Field>
        <Field label="Platform" htmlFor="new-identity-platform" required>
          <Select
            id="new-identity-platform"
            name="platform"
            defaultValue="linkedin"
            options={platforms.map((platform) => ({ value: platform, label: platform }))}
          />
        </Field>
        <Field label="Status" htmlFor="new-identity-status" required>
          <Select
            id="new-identity-status"
            name="status"
            defaultValue="active"
            options={statuses.map((status) => ({ value: status, label: status }))}
          />
        </Field>
        <Field label="Daily target" htmlFor="new-identity-target" required>
          <TextInput
            id="new-identity-target"
            name="dailyTarget"
            type="number"
            defaultValue="0"
            required
          />
        </Field>
      </div>
      <Field label="Profile URL" htmlFor="new-identity-url" hint="Optional.">
        <TextInput id="new-identity-url" name="profileUrl" type="url" defaultValue="" />
      </Field>
      <Field
        label="Managed by"
        htmlFor="new-identity-manager"
        hint="Optional. An identity with no manager is unassigned and may be self-assigned later."
      >
        <Select
          id="new-identity-manager"
          name="managedByUserId"
          defaultValue=""
          placeholder="Unassigned"
          options={users.map((user) => ({ value: user.value, label: user.label }))}
        />
      </Field>
      <p className="nx-hint">
        Business access is granted on the identity&rsquo;s own screen. Companion visibility is the intersection of the
        operator&rsquo;s grants and the identity&rsquo;s grants — never their union.
      </p>
    </ActionShell>
  );
}

/* ---------------------------------------------------------- identity edit -- */

export function IdentityEditForm({
  identityId,
  platforms,
  statuses,
  current,
}: {
  readonly identityId: string;
  readonly platforms: readonly string[];
  readonly statuses: readonly string[];
  readonly current: {
    readonly displayName: string;
    readonly platform: string;
    readonly status: string;
    readonly dailyTarget: number;
    readonly profileUrl: string;
    readonly notes: string;
  };
}): ReactElement {
  return (
    <ActionShell action={updateIdentityAction} submitLabel="Save identity" hidden={{ identityId }}>
      <Field label="Display name" htmlFor="identity-name" required>
        <TextInput id="identity-name" name="displayName" defaultValue={current.displayName} required />
      </Field>
      <div className="nx-grid nx-grid--2">
        <Field label="Platform" htmlFor="identity-platform" required>
          <Select
            id="identity-platform"
            name="platform"
            defaultValue={current.platform}
            options={platforms.map((platform) => ({ value: platform, label: platform }))}
          />
        </Field>
        <Field
          label="Status"
          htmlFor="identity-status"
          required
          hint="Only an active identity may be bound by a browser session."
        >
          <Select
            id="identity-status"
            name="status"
            defaultValue={current.status}
            options={statuses.map((status) => ({ value: status, label: status }))}
          />
        </Field>
      </div>
      <Field label="Daily target" htmlFor="identity-target" required>
        <TextInput
          id="identity-target"
          name="dailyTarget"
          type="number"
          defaultValue={String(current.dailyTarget)}
          required
        />
      </Field>
      <Field label="Profile URL" htmlFor="identity-url" hint="Leave empty to clear it.">
        <TextInput id="identity-url" name="profileUrl" type="url" defaultValue={current.profileUrl} />
      </Field>
      <Field label="Notes" htmlFor="identity-notes" hint="Leave empty to clear it.">
        <TextArea id="identity-notes" name="notes" defaultValue={current.notes} />
      </Field>
    </ActionShell>
  );
}

/* ------------------------------------------------------- business access -- */

export function GrantBusinessForm({
  identityId,
  businesses,
}: {
  readonly identityId: string;
  readonly businesses: readonly SelectChoice[];
}): ReactElement {
  if (businesses.length === 0) {
    return (
      <span className="nx-hint">
        This identity already has access to every business you can see. Grant access from another business&rsquo;s
        screen if one is missing.
      </span>
    );
  }

  return (
    <ActionShell
      action={grantBusinessAction}
      submitLabel="Grant business access"
      variant="secondary"
      hidden={{ identityId }}
    >
      <Field label="Business" htmlFor="identity-business" required>
        <Select
          id="identity-business"
          name="businessId"
          defaultValue=""
          placeholder="Choose a business"
          required
          options={businesses.map((business) => ({ value: business.value, label: business.label }))}
        />
      </Field>
    </ActionShell>
  );
}

export function RevokeBusinessButton({
  identityId,
  businessId,
  businessName,
}: {
  readonly identityId: string;
  readonly businessId: string;
  readonly businessName: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(revokeBusinessAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="identityId" value={identityId} />
      <input type="hidden" name="businessId" value={businessId} />
      <Button
        type="submit"
        variant="danger"
        size="sm"
        busy={pending}
        title={state.error ?? `Revoke access to ${businessName}`}
      >
        Revoke
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------- transfers -- */

/**
 * Hands the identity to a user, or back to the unassigned pool.
 *
 * The confirmation checkbox is only rendered when the identity already belongs to
 * someone else — the condition `decideSelfAssignIdentity` identifies as
 * `require_confirmation`. Unticking it is not a way around the rule: the repository
 * refuses the change and says why.
 */
export function IdentityTransferForm({
  identityId,
  users,
  currentManagerId,
  currentManagerName,
}: {
  readonly identityId: string;
  readonly users: readonly SelectChoice[];
  readonly currentManagerId: string | null;
  readonly currentManagerName: string | null;
}): ReactElement {
  return (
    <ActionShell action={assignIdentityManagerAction} submitLabel="Save manager" variant="secondary" hidden={{ identityId }}>
      <Field label="Managed by" htmlFor="identity-manager" required>
        <Select
          id="identity-manager"
          name="toUserId"
          defaultValue={currentManagerId ?? ''}
          placeholder="Unassigned"
          options={users.map((user) => ({ value: user.value, label: user.label }))}
        />
      </Field>

      {currentManagerId !== null && (
        <div className="nx-stack nx-stack--sm">
          <div className="nx-row">
            <input id="identity-transfer-confirm" name="confirmed" type="checkbox" value="true" />
            <label className="nx-label" htmlFor="identity-transfer-confirm">
              I am transferring this identity away from {currentManagerName ?? 'its current manager'}
            </label>
          </div>
          <span className="nx-hint">
            This identity is already assigned. Changing the manager without this confirmation is refused; with it, the
            transfer is recorded in the history below and in the audit log.
          </span>
        </div>
      )}

      <Field label="Transfer note" htmlFor="identity-transfer-note" hint="Optional, and kept with the transfer record.">
        <TextInput id="identity-transfer-note" name="note" defaultValue="" />
      </Field>
    </ActionShell>
  );
}
