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

import { Alert, Button, Field, Overline, Select, Stack, TextArea, TextInput } from '@nexus/ui';

import {
  archiveIdentityAction,
  assignIdentityManagerAction,
  createIdentityAction,
  deleteIdentityAction,
  grantBusinessAction,
  revokeBusinessAction,
  unassignIdentityAction,
  updateIdentityAction,
  type ActionResult,
  type LifecycleActionResult,
} from '@/app/(app)/identities/[id]/actions';

const INITIAL: ActionResult = { ok: false, error: null };
const LIFECYCLE_INITIAL: LifecycleActionResult = { ok: false, error: null };

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
 * Hands the identity to another user.
 *
 * This form names a recipient and only a recipient. The select has no "unassigned" option and
 * `toUserId` is a uuid on the server, because releasing an identity is not a transfer — it is
 * `UnassignIdentityForm` below, which calls the dedicated `unassignIdentityAction`. That action audits
 * `identity_unassign` and writes no `identity_transfers` row, since every row in that table names who
 * took the identity over.
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
      <Field
        label="Managed by"
        htmlFor="identity-manager"
        required
        hint="A recipient is required. To release the identity without handing it to anyone, use Unassign in the lifecycle panel."
      >
        <Select
          id="identity-manager"
          name="toUserId"
          /*
           * With no manager yet, `defaultValue` must be the empty string so the disabled placeholder is
           * the preselected option. This is not the old `toUserId: ''` sentinel: that option is
           * `disabled` because the field is `required`, and the server now rejects anything that is not
           * a uuid, so an empty recipient cannot be posted from here.
           */
          defaultValue={currentManagerId ?? ''}
          placeholder="Choose a user"
          required
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

/* ------------------------------------------------------------- lifecycle -- */

/**
 * The rest of the identity lifecycle: unassign, retire, and the guarded permanent delete.
 *
 * Three properties of the server contract drive the shape of everything below.
 *
 *   1. **Retirement is terminal.** `assert_identity_status_transition` (migration 0025) refuses any move
 *      away from `status = 'retired'`. There is therefore no "restore" or "reactivate" control anywhere
 *      on this screen — offering one would be a control whose only outcome is a database exception.
 *   2. **"This has history" is a screen state, not an error.** A refused delete returns
 *      `errorCode: 'identity_has_attribution'` with the census. The UI branches on that code — never on
 *      the sentence — renders what would be lost, and offers Retire, which is the supported way to close
 *      an identity.
 *   3. **Unassign is not a transfer.** It calls the dedicated action, so it records `identity_unassign`
 *      and writes no `identity_transfers` row; that table's rows name a recipient.
 */

/**
 * Labels for the `IdentityAttribution` census.
 *
 * The keys come from `packages/db/migrations/0025_identity_lifecycle.sql` via
 * `getIdentityAttribution`. An unknown key is humanised rather than dropped, so a census field added
 * later still appears in the refusal instead of silently vanishing from it.
 */
const ATTRIBUTION_LABELS: Readonly<Record<string, string>> = {
  sentMessages: 'Sent messages',
  messageEvents: 'Message events',
  conversations: 'Conversations',
  leads: 'Leads',
  interactions: 'Interactions',
  browserSessions: 'Browser sessions',
  transfers: 'Transfers',
};

function attributionLabel(key: string): string {
  return ATTRIBUTION_LABELS[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/** Errors are announced; successes are polite. Never both. */
function LifecycleResult({ state }: { readonly state: LifecycleActionResult }): ReactElement | null {
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

/** The census a refused delete returns, itemised, so "referenced by history" is a number. */
function Attribution({
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
    <div className="nx-stack nx-stack--sm">
      <span className="nx-hint">
        Deleting this identity would blank the sender on {String(total)} historical record
        {total === 1 ? '' : 's'}, and none of it can be reconstructed:
      </span>
      <div className="nx-stack nx-stack--sm">
        {entries.map(([key, value]) => (
          <div className="nx-row nx-row--between" key={key}>
            <span className="nx-hint">{attributionLabel(key)}</span>
            <span className="nx-table__mono">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Releases the identity without handing it to anyone.
 *
 * `unassignIdentityAction` is the dedicated action: `managed_by_user_id` becomes null, an
 * `identity_unassign` audit row is written, and no `identity_transfers` row is created — that table
 * records who took an identity over, and "nobody has it now" answers a different question.
 */
function UnassignIdentityForm({
  identityId,
  assigned,
  currentManagerName,
}: {
  readonly identityId: string;
  readonly assigned: boolean;
  readonly currentManagerName: string | null;
}): ReactElement {
  const [state, formAction, pending] = useActionState(unassignIdentityAction, LIFECYCLE_INITIAL);

  if (!assigned) {
    return (
      <div className="nx-stack nx-stack--sm">
        <Overline>Unassign</Overline>
        <span className="nx-hint">
          Not offered: this identity is not assigned to anyone. An unassigned identity appears in no
          operator&rsquo;s sender list until it is assigned again.
        </span>
      </div>
    );
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="identityId" value={identityId} />
      <div className="nx-stack nx-stack--sm">
        <Overline>Unassign</Overline>
        <span className="nx-hint">
          Releases this identity from {currentManagerName ?? 'its current manager'} without handing it to anyone
          else. Reversible: assign it again at any time.
        </span>
        <Field
          label="Unassign note"
          htmlFor={`unassign-note-${identityId}`}
          hint="Optional, and recorded on the identity_unassign audit row."
        >
          <TextInput id={`unassign-note-${identityId}`} name="note" defaultValue="" />
        </Field>
        <LifecycleResult state={state} />
        <Button type="submit" variant="secondary" size="sm" busy={pending}>
          Unassign
        </Button>
      </div>
    </form>
  );
}

/**
 * Retires (archives) the identity: `status = 'retired'`, live browser sessions revoked, gone from every
 * sender and binding selector, history preserved. Terminal, hence the confirmation.
 *
 * `alternative` renders the same control as the offered alternative to a refused delete.
 */
function ArchiveIdentityForm({
  identityId,
  alternative = false,
}: {
  readonly identityId: string;
  readonly alternative?: boolean;
}): ReactElement {
  const [state, formAction, pending] = useActionState(archiveIdentityAction, LIFECYCLE_INITIAL);
  const suffix = alternative ? 'alternative' : 'panel';

  return (
    <form action={formAction}>
      <input type="hidden" name="identityId" value={identityId} />
      <div className="nx-stack nx-stack--sm">
        {!alternative && <Overline>Retire</Overline>}
        {!alternative && (
          <span className="nx-hint">
            Archiving sets the status to <code>retired</code>, revokes every live browser session and removes the
            identity from every sender and binding selector. Business bindings stay, because they are configuration
            and part of its history.
          </span>
        )}
        <Field
          label="Retirement note"
          htmlFor={`retire-note-${identityId}-${suffix}`}
          hint="Optional, and recorded on the identity_archive audit row."
        >
          <TextInput id={`retire-note-${identityId}-${suffix}`} name="note" defaultValue="" />
        </Field>
        <div className="nx-row">
          <input
            id={`retire-confirm-${identityId}-${suffix}`}
            name="retire-confirmed"
            type="checkbox"
            value="true"
            required
          />
          <label className="nx-label" htmlFor={`retire-confirm-${identityId}-${suffix}`}>
            I understand retirement is permanent: a retired identity cannot be restored
          </label>
        </div>
        <LifecycleResult state={state} />
        <Button type="submit" variant={alternative ? 'primary' : 'secondary'} size="sm" busy={pending}>
          {alternative ? 'Retire this identity instead' : 'Retire identity'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Permanently deletes an identity — only one that never sent anything.
 *
 * The refusal is rendered as its own screen state: the typed code is what is branched on, the census is
 * itemised, and the alternative (Retire) is the same real action the panel offers.
 */
function DeleteIdentityForm({
  identityId,
  displayName,
  retired,
}: {
  readonly identityId: string;
  readonly displayName: string;
  readonly retired: boolean;
}): ReactElement {
  const [state, formAction, pending] = useActionState(deleteIdentityAction, LIFECYCLE_INITIAL);
  const blockedByAttribution = state.errorCode === 'identity_has_attribution';

  return (
    <div className="nx-stack nx-stack--sm">
      <form action={formAction}>
        <input type="hidden" name="identityId" value={identityId} />
        <div className="nx-stack nx-stack--sm">
          <Overline>Delete</Overline>
          <Field
            label={`Type "${displayName}" to delete permanently`}
            htmlFor={`delete-identity-${identityId}`}
            required
            hint="Permanent. Only an identity that never sent anything and carries no attribution can be deleted."
          >
            <TextInput
              id={`delete-identity-${identityId}`}
              name="confirmation"
              defaultValue=""
              required
              autoComplete="off"
            />
          </Field>
          {/*
            The blocked case is not a form error and must not be rendered as one, so the plain result
            is suppressed and the itemised refusal below replaces it.
          */}
          {blockedByAttribution ? null : <LifecycleResult state={state} />}
          <Button type="submit" variant="danger" size="sm" busy={pending}>
            Delete permanently
          </Button>
        </div>
      </form>

      {blockedByAttribution && (
        <div className="nx-stack nx-stack--sm">
          <Alert accent="amber" role="alert" title="Deletion is blocked: this identity is referenced by history">
            {state.error ?? 'This identity sent messages, so it cannot be deleted.'}
          </Alert>
          <Attribution counts={state.attribution} />
          <span className="nx-hint">
            Every foreign key that points at an identity is <code>on delete set null</code>, so deleting this one
            would succeed and quietly blank the sender on the records above rather than fail. Retire it instead:
            retirement removes it from every sender and binding selector, revokes its live browser sessions, and
            keeps all of that attribution intact.
          </span>
          {/*
            A refused delete on an already-retired identity must not offer Retire again: archiving is terminal and
            that action would answer "already archived". The alternative it points at is where it already is.
          */}
          {retired ? (
            <span className="nx-hint">
              This identity is already retired, which is the state a delete cannot reach — its attribution is
              preserved and stays unambiguous. Create a new identity if another sender is needed.
            </span>
          ) : (
            <ArchiveIdentityForm identityId={identityId} alternative />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The lifecycle panel for A17.
 *
 * Rendered only for a viewer holding `identity.manage`; each action re-checks that requirement on the
 * server, so the hiding is convenience rather than the control. There is deliberately no restore
 * control: `retired` is terminal, and a reactivate button would be a control whose only outcome is a
 * refusal from `assert_identity_status_transition`.
 */
export function IdentityLifecyclePanel({
  identityId,
  displayName,
  status,
  assigned,
  currentManagerName,
}: {
  readonly identityId: string;
  readonly displayName: string;
  readonly status: string;
  readonly assigned: boolean;
  readonly currentManagerName: string | null;
}): ReactElement {
  return (
    <Stack size="lg">
      <UnassignIdentityForm
        identityId={identityId}
        assigned={assigned}
        currentManagerName={currentManagerName}
      />

      {status === 'retired' ? (
        <div className="nx-stack nx-stack--sm">
          <Overline>Retire</Overline>
          <span className="nx-hint">
            This identity is archived. Retirement is terminal — the database refuses any move away from{' '}
            <code>retired</code>, because un-retiring it would make the historical attribution of everything it sent
            ambiguous. Create a new identity instead of restoring this one.
          </span>
        </div>
      ) : (
        <ArchiveIdentityForm identityId={identityId} />
      )}

      <DeleteIdentityForm identityId={identityId} displayName={displayName} retired={status === 'retired'} />
    </Stack>
  );
}
