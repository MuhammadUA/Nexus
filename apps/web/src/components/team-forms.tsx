'use client';

/**
 * Client forms for A15 (Team & Accounts) and A16 (User Permissions).
 *
 * Every input inside a `<form action={…}>` is uncontrolled — `defaultValue` plus
 * `name`, never `value`/`onChange` — so the browser owns what is submitted and the
 * server action is the only thing that interprets it. No password field is ever
 * echoed back: the inputs start empty, the actions return `{ ok, error, message }`,
 * and the success messages deliberately say what happened rather than what was set.
 */
import { useActionState, type ReactElement, type ReactNode } from 'react';

import { Alert, Button, Field, Select, Stack, TextInput } from '@nexus/ui';

import {
  createUserAction,
  revokeGrantAction,
  saveGrantAction,
  type ActionResult,
} from '@/app/(app)/team/actions';
import {
  setUserPasswordAction,
  updateUserProfileAction,
} from '@/app/(app)/team/[id]/actions';

const INITIAL: ActionResult = { ok: false, error: null };

export interface SelectChoice {
  readonly value: string;
  readonly label: string;
}

/** Repeated shell: a form whose result is reported inline in the Nexus language. */
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

/** Errors are announced; successes are polite. Never both. */
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

function Checkbox({
  id,
  name,
  label,
  hint,
  defaultChecked,
}: {
  readonly id: string;
  readonly name: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly defaultChecked?: boolean;
}): ReactElement {
  return (
    <div className="nx-stack nx-stack--sm">
      <div className="nx-row">
        <input id={id} name={name} type="checkbox" value="true" defaultChecked={defaultChecked === true} />
        <label className="nx-label" htmlFor={id}>
          {label}
        </label>
      </div>
      {hint !== undefined && <span className="nx-hint">{hint}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------- A15 -- */

/**
 * spec `roles_and_permissions.admin.can`: "Create users and assign business
 * visibility."
 *
 * The optional password block is the local credential path
 * (`0015_local_credentials.sql`); leaving it blank creates the profile without a
 * local password, which is the correct default when Supabase Auth is the provider.
 */
export function CreateUserForm({
  businesses,
  accessLevels,
  statuses,
}: {
  readonly businesses: readonly SelectChoice[];
  readonly accessLevels: readonly string[];
  readonly statuses: readonly string[];
}): ReactElement {
  return (
    <ActionShell action={createUserAction} submitLabel="Create user" hidden={{}}>
      <div className="nx-grid nx-grid--2">
        <Field label="Email" htmlFor="new-user-email" required>
          <TextInput id="new-user-email" name="email" type="email" defaultValue="" required autoComplete="off" />
        </Field>
        <Field label="Full name" htmlFor="new-user-name" required>
          <TextInput id="new-user-name" name="fullName" defaultValue="" required autoComplete="off" />
        </Field>
        <Field label="Role" htmlFor="new-user-role" required hint="The role default below is refined per business on the user's screen.">
          <Select
            id="new-user-role"
            name="role"
            defaultValue="user"
            options={[
              { value: 'admin', label: 'admin' },
              { value: 'manager', label: 'manager' },
              { value: 'user', label: 'user' },
            ]}
          />
        </Field>
        <Field label="Status" htmlFor="new-user-status" required>
          <Select
            id="new-user-status"
            name="status"
            defaultValue="active"
            options={statuses.map((status) => ({ value: status, label: status }))}
          />
        </Field>
      </div>

      <Field
        label="Initial business grant"
        htmlFor="new-user-business"
        hint="Optional. Visibility is never implied — a user with no grant sees no business."
      >
        <Select
          id="new-user-business"
          name="businessId"
          defaultValue=""
          placeholder="No business access yet"
          options={businesses.map((business) => ({ value: business.value, label: business.label }))}
        />
      </Field>

      <div className="nx-grid nx-grid--2">
        <Field label="Access level" htmlFor="new-user-level">
          <Select
            id="new-user-level"
            name="accessLevel"
            defaultValue="user"
            options={accessLevels.map((level) => ({ value: level, label: level }))}
          />
        </Field>
      </div>

      <Stack size="sm">
        <span className="nx-hint">Granted actions inside that business:</span>
        <Checkbox id="new-user-manage" name="canManageLeads" label="Manage leads" defaultChecked />
        <Checkbox id="new-user-sources" name="canUseLeadSources" label="Use lead sources" />
        <Checkbox id="new-user-queue" name="canUseProfileQueue" label="Use the profile queue" />
        <Checkbox id="new-user-delete" name="canDeleteLeads" label="Delete leads" />
      </Stack>

      <div className="nx-grid nx-grid--2">
        <Field
          label="Local password"
          htmlFor="new-user-password"
          hint="Optional. At least 12 characters; it is hashed before it reaches the database and is never shown again."
        >
          <TextInput
            id="new-user-password"
            name="password"
            type="password"
            defaultValue=""
            autoComplete="new-password"
          />
        </Field>
      </div>
    </ActionShell>
  );
}

/* ------------------------------------------------------------------- A16 -- */

export function ProfileEditForm({
  userId,
  current,
  roles,
  statuses,
}: {
  readonly userId: string;
  readonly current: {
    readonly fullName: string;
    readonly role: string;
    readonly status: string;
    readonly timezone: string;
  };
  readonly roles: readonly string[];
  readonly statuses: readonly string[];
}): ReactElement {
  return (
    <ActionShell action={updateUserProfileAction} submitLabel="Save profile" hidden={{ userId }}>
      <Field label="Full name" htmlFor="edit-user-name" required>
        <TextInput id="edit-user-name" name="fullName" defaultValue={current.fullName} required />
      </Field>
      <div className="nx-grid nx-grid--2">
        <Field
          label="Role"
          htmlFor="edit-user-role"
          hint="The role decides the default permission set. Per-business grants are overrides on top of it."
        >
          <Select
            id="edit-user-role"
            name="role"
            defaultValue={current.role}
            options={roles.map((role) => ({ value: role, label: role }))}
          />
        </Field>
        <Field label="Status" htmlFor="edit-user-status" hint="A disabled user can no longer sign in.">
          <Select
            id="edit-user-status"
            name="status"
            defaultValue={current.status}
            options={statuses.map((status) => ({ value: status, label: status }))}
          />
        </Field>
      </div>
      <Field label="Timezone" htmlFor="edit-user-timezone">
        <TextInput id="edit-user-timezone" name="timezone" defaultValue={current.timezone} />
      </Field>
    </ActionShell>
  );
}

export function UserPasswordForm({ userId }: { readonly userId: string }): ReactElement {
  return (
    <ActionShell
      action={setUserPasswordAction}
      submitLabel="Set local password"
      variant="secondary"
      hidden={{ userId }}
    >
      <Field
        label="New local password"
        htmlFor="set-user-password"
        required
        hint="At least 12 characters. Setting it invalidates the previous one and is written to the audit log — the value itself never is."
      >
        <TextInput
          id="set-user-password"
          name="password"
          type="password"
          defaultValue=""
          required
          autoComplete="new-password"
        />
      </Field>
    </ActionShell>
  );
}

export interface GrantFormValues {
  readonly accessLevel: string;
  readonly leadScopeMode: string;
  readonly canManageLeads: boolean;
  readonly canUseLeadSources: boolean;
  readonly canUseProfileQueue: boolean;
  readonly canDeleteLeads: boolean;
  readonly icpIds: readonly string[];
}

/**
 * One business grant: the business, its access level, the fine-grained actions
 * `user_business_access` carries, and the `user_lead_scope` mode plus ICP
 * restriction that refine which leads are visible.
 */
export function GrantForm({
  userId,
  businesses,
  accessLevels,
  scopes,
  icps,
  current,
}: {
  readonly userId: string;
  readonly businesses: readonly SelectChoice[];
  readonly accessLevels: readonly string[];
  readonly scopes: readonly { readonly value: string; readonly label: string }[];
  readonly icps: readonly SelectChoice[];
  /** `null` = a new grant for this business. */
  readonly current: GrantFormValues | null;
}): ReactElement {
  const values: GrantFormValues = current ?? {
    accessLevel: 'user',
    leadScopeMode: 'assigned',
    canManageLeads: true,
    canUseLeadSources: false,
    canUseProfileQueue: false,
    canDeleteLeads: false,
    icpIds: [],
  };
  const selectedBusinessId = businesses[0]?.value ?? '';

  return (
    <ActionShell action={saveGrantAction} submitLabel="Save access" hidden={{ userId }}>
      {/*
        A16 is reached from a user, and the grant editor is opened for one business
        at a time, so the business is carried as a value rather than re-chosen.
      */}
      <input type="hidden" name="businessId" value={selectedBusinessId} />

      <Field label="Access level" htmlFor="grant-level" required>
        <Select
          id="grant-level"
          name="accessLevel"
          defaultValue={values.accessLevel}
          options={accessLevels.map((level) => ({ value: level, label: level }))}
        />
      </Field>

      <Field label="Lead scope" htmlFor="grant-scope" hint="Which leads inside this business the user may see.">
        <Select
          id="grant-scope"
          name="leadScopeMode"
          defaultValue={values.leadScopeMode}
          options={scopes.map((scope) => ({ value: scope.value, label: scope.label }))}
        />
      </Field>

      <Stack size="sm">
        <span className="nx-hint">Permitted actions inside this business:</span>
        <Checkbox id="grant-manage" name="canManageLeads" label="Manage leads" defaultChecked={values.canManageLeads} />
        <Checkbox
          id="grant-sources"
          name="canUseLeadSources"
          label="Use lead sources"
          defaultChecked={values.canUseLeadSources}
        />
        <Checkbox
          id="grant-queue"
          name="canUseProfileQueue"
          label="Use the profile queue"
          defaultChecked={values.canUseProfileQueue}
        />
        <Checkbox
          id="grant-delete"
          name="canDeleteLeads"
          label="Delete leads"
          defaultChecked={values.canDeleteLeads}
        />
      </Stack>

      <Stack size="sm">
        <span className="nx-hint">
          Restrict to specific ICPs (optional). None selected means every ICP in this business.
        </span>
        {icps.length === 0 ? (
          <span className="nx-hint">This business has no ICPs configured yet.</span>
        ) : (
          icps.map((icp) => (
            <Checkbox
              key={icp.value}
              id={`grant-icp-${icp.value}`}
              name="icpIds"
              label={icp.label}
              defaultChecked={values.icpIds.includes(icp.value)}
            />
          ))
        )}
      </Stack>
    </ActionShell>
  );
}

/** Revoking a grant also drops its lead scope; the repository does both. */
export function RevokeGrantButton({
  userId,
  businessId,
  businessName,
}: {
  readonly userId: string;
  readonly businessId: string;
  readonly businessName: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(revokeGrantAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="userId" value={userId} />
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
