'use client';

import { useActionState, type ReactElement, type ReactNode } from 'react';

import { Alert, Button, Field, Select, Stack, TextArea, TextInput } from '@nexus/ui';

import {
  createOfferAction,
  createPersonaAction,
  createServiceAction,
  createValuePropositionAction,
  setApprovalAction,
  snapshotContextAction,
  type ActionResult,
} from '@/app/b/[slug]/setup/brain/actions';

const INITIAL: ActionResult = { ok: false, error: null };

interface BrainContext {
  readonly businessId: string;
  readonly businessSlug: string;
}

/** Repeated shell: one form whose result is reported inline in the design language. */
function BrainShell({
  action,
  hidden,
  submitLabel,
  children,
  variant = 'secondary',
}: {
  readonly action: (previous: ActionResult, formData: FormData) => Promise<ActionResult>;
  readonly hidden: Record<string, string>;
  readonly submitLabel: string;
  readonly children: ReactNode;
  readonly variant?: 'primary' | 'secondary';
}): ReactElement {
  const [state, formAction, pending] = useActionState(action, INITIAL);

  return (
    <form action={formAction}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Stack size="sm">
        {children}
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
        <Button type="submit" variant={variant} busy={pending}>
          {submitLabel}
        </Button>
      </Stack>
    </form>
  );
}

/**
 * Offer (A11). `cta_style` and `positioning` are the fields spec
 * `messaging_rules` reads when a draft is generated, so they are collected here
 * rather than left to free text in a prompt.
 */
export function BrainOfferForm({ businessId, businessSlug }: BrainContext): ReactElement {
  return (
    <BrainShell
      action={createOfferAction}
      hidden={{ businessId, businessSlug }}
      submitLabel="Add offer"
    >
      <Field label="Offer name" htmlFor="brain-offer-name" required>
        <TextInput id="brain-offer-name" name="name" defaultValue="" required />
      </Field>
      <Field label="Description" htmlFor="brain-offer-desc">
        <TextArea id="brain-offer-desc" name="description" defaultValue="" />
      </Field>
      <Field
        label="Positioning"
        htmlFor="brain-offer-positioning"
        hint="How this offer is framed against the alternatives."
      >
        <TextArea id="brain-offer-positioning" name="positioning" defaultValue="" />
      </Field>
      <Field label="CTA style" htmlFor="brain-offer-cta" hint="e.g. soft question, direct booking ask.">
        <TextInput id="brain-offer-cta" name="ctaStyle" defaultValue="" />
      </Field>
    </BrainShell>
  );
}

export function BrainServiceForm({ businessId, businessSlug }: BrainContext): ReactElement {
  return (
    <BrainShell
      action={createServiceAction}
      hidden={{ businessId, businessSlug }}
      submitLabel="Add service"
    >
      <div className="nx-grid nx-grid--2">
        <Field label="Service name" htmlFor="brain-service-name" required>
          <TextInput id="brain-service-name" name="name" defaultValue="" required />
        </Field>
        <Field label="Category" htmlFor="brain-service-category">
          <TextInput id="brain-service-category" name="category" defaultValue="" />
        </Field>
      </div>
      <Field label="Description" htmlFor="brain-service-desc">
        <TextArea id="brain-service-desc" name="description" defaultValue="" />
      </Field>
    </BrainShell>
  );
}

export function BrainPersonaForm({ businessId, businessSlug }: BrainContext): ReactElement {
  return (
    <BrainShell
      action={createPersonaAction}
      hidden={{ businessId, businessSlug }}
      submitLabel="Add persona"
    >
      <Field label="Persona name" htmlFor="brain-persona-name" required>
        <TextInput id="brain-persona-name" name="name" defaultValue="" required />
      </Field>
      <Field label="Description" htmlFor="brain-persona-desc">
        <TextArea id="brain-persona-desc" name="description" defaultValue="" />
      </Field>
      <Field
        label="Pain points"
        htmlFor="brain-persona-pains"
        hint="One per line, or comma-separated."
      >
        <TextArea id="brain-persona-pains" name="painPoints" defaultValue="" />
      </Field>
      <Field label="Goals" htmlFor="brain-persona-goals" hint="One per line, or comma-separated.">
        <TextArea id="brain-persona-goals" name="goals" defaultValue="" />
      </Field>
    </BrainShell>
  );
}

/**
 * Value proposition (A11).
 *
 * "Proof required" mirrors `value_propositions.proof_required`: the claim may only
 * be used once an approved knowledge asset backs it, which is why the flag is asked
 * for explicitly instead of being inferred.
 */
export function BrainValuePropositionForm({
  businessId,
  businessSlug,
  personas,
}: BrainContext & {
  readonly personas: readonly { readonly value: string; readonly label: string }[];
}): ReactElement {
  return (
    <BrainShell
      action={createValuePropositionAction}
      hidden={{ businessId, businessSlug }}
      submitLabel="Add value proposition"
    >
      <Field label="Statement" htmlFor="brain-vp-statement" required>
        <TextArea id="brain-vp-statement" name="statement" defaultValue="" required />
      </Field>
      <Field label="Persona" htmlFor="brain-vp-persona" hint="Optional. Links the claim to a persona.">
        <Select
          id="brain-vp-persona"
          name="personaId"
          defaultValue=""
          placeholder="No specific persona"
          options={personas}
        />
      </Field>
      <label className="nx-row" htmlFor="brain-vp-proof">
        <input id="brain-vp-proof" type="checkbox" name="proofRequired" defaultChecked />
        <span>Requires approved proof before it may be used</span>
      </label>
    </BrainShell>
  );
}

/**
 * Approve / unapprove one asset.
 *
 * spec `business_brain_and_knowledge.claim_policy`: "Outbound may use only approved
 * factual claims. Never invent metrics/results." The label always says which
 * direction the click goes, so approval state is never implied by colour alone.
 */
export function BrainApprovalButton({
  businessId,
  businessSlug,
  kind,
  id,
  approved,
}: BrainContext & {
  readonly kind: 'offer' | 'service' | 'persona' | 'value_proposition';
  readonly id: string;
  readonly approved: boolean;
}): ReactElement {
  const [state, formAction, pending] = useActionState(setApprovalAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="approved" value={approved ? 'false' : 'true'} />
      <Button
        type="submit"
        variant={approved ? 'ghost' : 'secondary'}
        size="sm"
        busy={pending}
        title={state.error ?? (approved ? 'Remove approval' : 'Approve for AI use')}
      >
        {approved ? 'Unapprove' : 'Approve'}
      </Button>
    </form>
  );
}

export function BrainSnapshotForm({
  businessId,
  businessSlug,
}: BrainContext): ReactElement {
  return (
    <BrainShell
      action={snapshotContextAction}
      hidden={{ businessId, businessSlug }}
      submitLabel="Freeze context version"
      variant="primary"
    >
      <Field
        label="Reason"
        htmlFor="brain-version-reason"
        hint="Optional. Recorded against the version so a sent message can be explained later."
      >
        <TextInput id="brain-version-reason" name="reason" defaultValue="" />
      </Field>
    </BrainShell>
  );
}
