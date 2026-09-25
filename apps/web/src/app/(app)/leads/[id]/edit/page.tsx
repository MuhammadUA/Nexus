import type { ReactNode } from 'react';

import { Alert, Card, Chip, Grid, LeadStatusChip, PageHead, Row, Stack, Stat } from '@nexus/ui';
import { LEAD_STATES } from '@nexus/core';
import { notFound } from 'next/navigation';

import { loadViewerContext } from '@/lib/viewer-context';
import { listIcpOptions, listIdentityOptions, listOwnerOptions } from '@/lib/repo/leads';
import { getLeadEditContext } from '@/lib/repo/user-sources';
import { LeadEditForm } from '@/components/lead-edit-form';

export const dynamic = 'force-dynamic';

/**
 * U20 — Edit Lead.
 *
 * Contract: "Editable lead fields within user permissions."
 *
 * spec `screen_inventory` U06 and `identity_model.outreach_identity.rule`: the CRM lead
 * *owner* and the LinkedIn *sender identity* are two separate dimensions, so they are
 * shown as two separate fields with an explanation, never collapsed into one "assigned
 * to". A lead outside the viewer's scope does not resolve through RLS, so this screen
 * 404s rather than confirming that somebody else's lead exists.
 */
export default async function EditLeadPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;
  const context = await loadViewerContext();

  const canEdit = context.permissions.has('lead.update');
  const canAssignOwner = context.permissions.has('lead.assign_owner');
  const canChangeIdentity = context.permissions.has('lead.change_sender_identity');

  const lead = await getLeadEditContext(context.viewer.actor, id);
  if (lead === null) notFound();

  const [icps, identities, owners] = await Promise.all([
    listIcpOptions(context.viewer.actor, lead.businessId),
    canChangeIdentity
      ? listIdentityOptions(context.viewer.actor, lead.businessId)
      : Promise.resolve([] as readonly { readonly value: string; readonly label: string }[]),
    canAssignOwner
      ? listOwnerOptions(context.viewer.actor, lead.businessId)
      : Promise.resolve([] as readonly { readonly value: string; readonly label: string }[]),
  ]);

  return (
    <>
      <PageHead
        subtitle={
          <Row wrap>
            <span>{lead.companyName ?? 'No company'}</span>
            {lead.jobTitle !== null && <span>· {lead.jobTitle}</span>}
            <span>· {lead.businessName}</span>
          </Row>
        }
        actions={
          <Row wrap>
            <LeadStatusChip state={lead.status} />
            {lead.needsProfile && <Chip accent="cyan">needs profile</Chip>}
            <a className="nx-btn nx-btn--secondary" href={`/leads/${lead.leadId}`}>
              Back to lead
            </a>
          </Row>
        }
      >
        Edit {lead.fullName}
      </PageHead>

      {!canEdit && (
        <Alert accent="amber" title="Read-only" role="alert">
          Your access does not include editing leads, so this form will be refused. Ask an administrator for the
          lead-update permission.
        </Alert>
      )}

      <Grid split>
        <Stack size="lg">
          <Card
            title="Lead details"
            actions={<Chip accent="indigo">one canonical person</Chip>}
          >
            <LeadEditForm
              leadId={lead.leadId}
              icps={icps}
              identities={identities}
              owners={owners}
              statuses={LEAD_STATES}
              canAssignOwner={canAssignOwner}
              canChangeIdentity={canChangeIdentity}
              current={{
                fullName: lead.fullName,
                jobTitle: lead.jobTitle ?? '',
                headline: lead.headline ?? '',
                location: lead.location ?? '',
                companyName: lead.companyName ?? '',
                linkedinUrl: lead.linkedinUrl ?? '',
                primaryIcpId: lead.primaryIcpId ?? '',
                ownerUserId: lead.ownerUserId ?? '',
                outreachIdentityId: lead.outreachIdentityId ?? '',
                status: lead.status,
                ownerLabel: lead.ownerName ?? 'Unassigned',
                identityLabel: lead.identityName ?? 'Not bound',
              }}
            />
          </Card>
        </Stack>

        <Stack size="lg">
          <Card title="Owner vs sender identity">
            <Stack size="sm">
              <Row between>
                <span className="nx-hint">Owner</span>
                <span>{lead.ownerName ?? 'Unassigned'}</span>
              </Row>
              <Row between>
                <span className="nx-hint">Sender identity</span>
                <span>{lead.identityName ?? 'Not bound'}</span>
              </Row>
              <span className="nx-hint">
                The owner is the team member responsible for the lead. The sender identity is the LinkedIn account
                outreach goes out from. They are intentionally separate: reassigning the lead does not move the
                conversation to another account, and changing the sender warns about duplicate outreach.
              </span>
            </Stack>
          </Card>

          <Card title="Primary ICP" actions={<Chip accent="indigo">{lead.primaryIcpName ?? 'unmatched'}</Chip>}>
            <Stack size="sm">
              <span className="nx-hint">
                Changing the Primary ICP is audited: the previous ICP, the new ICP and the number of secondary
                matches are recorded. Secondary matches are preserved and never create a second lead.
              </span>
              {lead.needsProfile && (
                <span className="nx-hint">
                  This lead is marked Needs profile. Capture the full LinkedIn profile from the Profile Queue before
                  outreach.
                </span>
              )}
            </Stack>
          </Card>

          <Grid cols={2}>
            <Stat value={LEAD_STATES.length} label="Lifecycle states" meta="spec lead_lifecycle" />
            <Stat
              value={canAssignOwner || canChangeIdentity ? 'partial' : 'no'}
              label="Assignment rights"
              meta="what your grant allows"
            />
          </Grid>
        </Stack>
      </Grid>
    </>
  );
}
