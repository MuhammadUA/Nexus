'use client';

import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Chip, Field, Row, Select, Stack, TextInput } from '@nexus/ui';

import { API_SCOPES } from '@nexus/core';

import {
  createApiClientAction,
  revokeApiClientAction,
  type IntegrationActionResult,
} from '@/app/(app)/integrations/actions';

const INITIAL: IntegrationActionResult = { ok: false, error: null };

/**
 * Issues a service token.
 *
 * The scopes and business allow-list are checkboxes because both are mandatory: a
 * token with no scope can do nothing, and a token scoped to no business can reach
 * nothing. Both facts are stated in the form rather than discovered at call time.
 */
export function ApiClientForm({
  businesses,
}: {
  readonly businesses: readonly { readonly value: string; readonly label: string }[];
}): ReactElement {
  const [state, formAction, pending] = useActionState(createApiClientAction, INITIAL);

  return (
    <form action={formAction}>
      <Stack>
        <Field label="Name" htmlFor="client-name" required>
          <TextInput id="client-name" name="name" defaultValue="" required />
        </Field>

        <Field label="Kind" htmlFor="client-kind">
          <Select
            id="client-kind"
            name="kind"
            defaultValue="mcp"
            options={[
              { value: 'mcp', label: 'MCP (agent tools)' },
              { value: 'rest_ingest', label: 'REST ingest' },
              { value: 'webhook', label: 'Webhook' },
              { value: 'internal_worker', label: 'Internal worker' },
            ]}
          />
        </Field>

        <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="nx-label">Scopes</legend>
          <Stack size="sm">
            {API_SCOPES.map((scope) => (
              <label key={scope} className="nx-hint" htmlFor={`scope-${scope}`}>
                <input id={`scope-${scope}`} type="checkbox" name="scopes" value={scope} /> {scope}
              </label>
            ))}
          </Stack>
        </fieldset>

        <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="nx-label">Businesses this token may touch</legend>
          <Stack size="sm">
            {businesses.map((business) => (
              <label key={business.value} className="nx-hint" htmlFor={`biz-${business.value}`}>
                <input id={`biz-${business.value}`} type="checkbox" name="businessIds" value={business.value} />{' '}
                {business.label}
              </label>
            ))}
          </Stack>
        </fieldset>

        <Field label="Expires in days" htmlFor="client-expiry" hint="Leave blank for no expiry.">
          <TextInput id="client-expiry" name="expiresInDays" defaultValue="" type="number" />
        </Field>

        {state.error !== null && (
          <Alert accent="red" role="alert">
            {state.error}
          </Alert>
        )}

        {state.token !== undefined && (
          <Alert accent="green" title="Copy this token now" role="status">
            <Row wrap>
              <span className="nx-input nx-input--readonly" style={{ flex: 1 }}>
                {state.token}
              </span>
              <Chip accent="amber">shown once</Chip>
            </Row>
            <span className="nx-hint">
              Only a hash is stored, so this value cannot be retrieved again. Revoke and reissue if it is lost.
            </span>
          </Alert>
        )}

        <Button type="submit" variant="primary" busy={pending}>
          Issue token
        </Button>
      </Stack>
    </form>
  );
}

export function RevokeTokenButton({ clientId }: { readonly clientId: string }): ReactElement {
  const [state, formAction, pending] = useActionState(revokeApiClientAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="clientId" value={clientId} />
      <Button
        type="submit"
        variant="danger"
        size="sm"
        busy={pending}
        title={state.error ?? 'Revoke this token'}
      >
        Revoke
      </Button>
    </form>
  );
}
