'use client';

import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Field, Select, Stack, TextArea, TextInput } from '@nexus/ui';

import {
  createDomainAction,
  deleteDomainAction,
  type ActionResult,
} from '@/app/(app)/business-domains/actions';

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
 * Register a domain for a business.
 *
 * The default checkbox only means something for a primary domain — the database's
 * partial unique index is `where is_default and domain_type = 'primary'` — and the
 * server refuses the combination rather than storing a default that would never apply.
 */
export function DomainCreateForm({
  businesses,
  typeOptions,
}: {
  readonly businesses: readonly { readonly id: string; readonly name: string }[];
  readonly typeOptions: readonly { readonly value: string; readonly label: string }[];
}): ReactElement {
  const [state, formAction, pending] = useActionState(createDomainAction, INITIAL);

  return (
    <form action={formAction}>
      <Stack size="sm">
        <div className="nx-grid nx-grid--2">
          <Field
            label="Domain"
            htmlFor="domain-value"
            required
            hint="example.com, lavishfoods.de, or a full URL — it is normalized before the uniqueness check."
          >
            <TextInput id="domain-value" name="domain" defaultValue="" required placeholder="example.com" />
          </Field>

          <Field label="Business" htmlFor="domain-business" required>
            <Select
              id="domain-business"
              name="businessId"
              defaultValue=""
              required
              placeholder="Choose a business"
              options={businesses.map((business) => ({ value: business.id, label: business.name }))}
            />
          </Field>
        </div>

        <div className="nx-grid nx-grid--2">
          <Field
            label="Domain type"
            htmlFor="domain-type"
            required
            hint="A domain belongs to exactly one business; aliases are explicit, never inferred."
          >
            <Select
              id="domain-type"
              name="domainType"
              defaultValue="alias"
              options={typeOptions.map((option) => ({ value: option.value, label: option.label }))}
            />
          </Field>

          <Field
            label="Default primary domain"
            htmlFor="domain-default"
            hint="At most one default primary per business — the database enforces it."
          >
            <label className="nx-row" htmlFor="domain-default">
              <input id="domain-default" type="checkbox" name="isDefault" />
              <span className="nx-hint">Make this the business&apos;s default primary domain</span>
            </label>
          </Field>
        </div>

        <Field label="Notes" htmlFor="domain-notes" hint="Why this domain belongs to this business.">
          <TextArea id="domain-notes" name="notes" defaultValue="" />
        </Field>

        <StateAlerts state={state} />

        <div className="nx-row">
          <Button type="submit" variant="primary" busy={pending}>
            Register domain
          </Button>
        </div>
      </Stack>
    </form>
  );
}

/**
 * Remove a domain.
 *
 * Domains only drive scoping and matching, so removing one cannot orphan a lead: the
 * spec forbids merging leads across businesses on the strength of a related domain in
 * the first place.
 */
export function DomainDeleteButton({
  id,
  domain,
}: {
  readonly id: string;
  readonly domain: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(deleteDomainAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        variant="danger"
        size="sm"
        busy={pending}
        title={state.error ?? `Remove ${domain}`}
        ariaLabel={`Remove ${domain}`}
      >
        Remove
      </Button>
    </form>
  );
}
