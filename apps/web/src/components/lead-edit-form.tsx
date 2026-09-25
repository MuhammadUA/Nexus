'use client';

import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Field, Grid, Row, Select, Stack, TextInput } from '@nexus/ui';

import { updateLeadAction } from '@/app/(app)/leads/[id]/edit/actions';

/** Mirrored result shape: a client component may only import functions from `'use server'`. */
interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly message?: string;
}

const INITIAL: ActionResult = { ok: false, error: null };

export interface EditOption {
  readonly value: string;
  readonly label: string;
}

/**
 * U20 — Edit Lead.
 *
 * Contract: "Editable lead fields within user permissions."
 *
 * The owner and sender-identity selects are rendered only when the viewer holds the
 * matching permission, which is what "within user permissions" means on this screen.
 * Everything here is uncontrolled so the browser owns what is submitted, and the server
 * action re-validates every field.
 */
export function LeadEditForm({
  leadId,
  icps,
  identities,
  owners,
  statuses,
  canAssignOwner,
  canChangeIdentity,
  current,
}: {
  readonly leadId: string;
  readonly icps: readonly EditOption[];
  readonly identities: readonly EditOption[];
  readonly owners: readonly EditOption[];
  readonly statuses: readonly string[];
  readonly canAssignOwner: boolean;
  readonly canChangeIdentity: boolean;
  readonly current: {
    readonly fullName: string;
    readonly jobTitle: string;
    readonly headline: string;
    readonly location: string;
    readonly companyName: string;
    readonly linkedinUrl: string;
    readonly primaryIcpId: string;
    readonly ownerUserId: string;
    readonly outreachIdentityId: string;
    readonly status: string;
    /** Human labels for the read-only presentation of owner and sender identity. */
    readonly ownerLabel: string;
    readonly identityLabel: string;
  };
}): ReactElement {
  const [state, formAction, pending] = useActionState(updateLeadAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <Stack>
        <Grid cols={2}>
          <Field label="Full name" htmlFor="edit-name" required hint="The canonical person record.">
            <TextInput id="edit-name" name="fullName" defaultValue={current.fullName} required />
          </Field>
          <Field label="Job title" htmlFor="edit-title">
            <TextInput id="edit-title" name="jobTitle" defaultValue={current.jobTitle} />
          </Field>
        </Grid>

        <Field label="Headline" htmlFor="edit-headline" hint="The line under the name on the profile.">
          <TextInput id="edit-headline" name="headline" defaultValue={current.headline} />
        </Field>

        <Grid cols={2}>
          <Field label="Location" htmlFor="edit-location">
            <TextInput id="edit-location" name="location" defaultValue={current.location} />
          </Field>
          <Field label="Company" htmlFor="edit-company" hint="Matched on the normalized company name.">
            <TextInput id="edit-company" name="companyName" defaultValue={current.companyName} />
          </Field>
        </Grid>

        <Field
          label="LinkedIn profile URL"
          htmlFor="edit-linkedin"
          hint="Used as the strongest person dedupe key. A URL that already belongs to another person is refused here — resolve it in Duplicate Review."
        >
          <TextInput id="edit-linkedin" name="linkedinUrl" defaultValue={current.linkedinUrl} type="url" />
        </Field>

        <Grid cols={2}>
          <Field
            label="Primary ICP"
            htmlFor="edit-icp"
            hint="Audited: changing it records who changed it and what it was before. Secondary matches are preserved."
          >
            <Select
              id="edit-icp"
              name="primaryIcpId"
              defaultValue={current.primaryIcpId}
              placeholder="Leave unchanged"
              options={icps.map((icp) => ({ value: icp.value, label: icp.label }))}
            />
          </Field>
          <Field label="Status" htmlFor="edit-status">
            <Select
              id="edit-status"
              name="status"
              defaultValue={current.status}
              options={statuses.map((status) => ({ value: status, label: status.replace(/_/g, ' ') }))}
            />
          </Field>
        </Grid>

        <Grid cols={2}>
          {/* spec `identity_model.outreach_identity.rule`: owner and sender are separate
              dimensions; both are shown, and each is editable only with its permission. */}
          <Field
            label="Owner"
            htmlFor="edit-owner"
            hint={
              canAssignOwner
                ? 'The team member responsible for this lead. Separate from the sender identity below.'
                : 'Only operators with lead-assignment rights can change the owner.'
            }
          >
            {canAssignOwner ? (
              <Select
                id="edit-owner"
                name="ownerUserId"
                defaultValue=""
                placeholder="Leave unchanged"
                options={owners.map((owner) => ({ value: owner.value, label: owner.label }))}
              />
            ) : (
              <TextInput id="edit-owner" defaultValue={current.ownerLabel} readOnly />
            )}
          </Field>

          <Field
            label="Sender identity"
            htmlFor="edit-identity"
            hint={
              canChangeIdentity
                ? 'The LinkedIn account that will send to this person.'
                : 'Only operators with sender-identity rights can change this.'
            }
          >
            {canChangeIdentity ? (
              <Select
                id="edit-identity"
                name="outreachIdentityId"
                defaultValue=""
                placeholder="Leave unchanged"
                options={identities.map((identity) => ({ value: identity.value, label: identity.label }))}
              />
            ) : (
              <TextInput id="edit-identity" defaultValue={current.identityLabel} readOnly />
            )}
          </Field>
        </Grid>

        <Row wrap>
          <span className="nx-hint">Owner = who is responsible. Sender identity = which LinkedIn account sends.</span>
        </Row>

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

        <Button type="submit" variant="primary" busy={pending}>
          Save changes
        </Button>
      </Stack>
    </form>
  );
}
