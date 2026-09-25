'use client';

import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Field, Select, Stack, TextArea, TextInput } from '@nexus/ui';

import { saveAutomationAction, type AutomationActionResult } from '@/app/b/[slug]/automations/actions';

const INITIAL: AutomationActionResult = { ok: false, error: null };

export function AutomationForm({
  businessId,
  icps,
}: {
  readonly businessId: string;
  readonly icps: readonly { readonly value: string; readonly label: string }[];
}): ReactElement {
  const [state, formAction, pending] = useActionState(saveAutomationAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="businessId" value={businessId} />
      <Stack size="sm">
        <Field label="Name" htmlFor="auto-name" required>
          <TextInput id="auto-name" name="name" defaultValue="" required />
        </Field>

        <Field label="Runner" htmlFor="auto-runner" required>
          <Select
            id="auto-runner"
            name="runner"
            defaultValue="browseros"
            options={[
              { value: 'browseros', label: 'BrowserOS / BrowserOS Neo' },
              { value: 'opencode', label: 'OpenCode' },
              { value: 'n8n', label: 'n8n worker' },
              { value: 'other', label: 'Other' },
            ]}
          />
        </Field>

        <Field label="Source type" htmlFor="auto-source" hint="e.g. google_search, apollo, linkedin_research">
          <TextInput id="auto-source" name="sourceType" defaultValue="" />
        </Field>

        <Field label="Primary ICP for its submissions" htmlFor="auto-icp">
          <Select
            id="auto-icp"
            name="icpId"
            defaultValue=""
            placeholder="Auto-match"
            options={icps.map((icp) => ({ value: icp.value, label: icp.label }))}
          />
        </Field>

        <Field label="Schedule" htmlFor="auto-schedule" hint="Cron or a human description; the runner interprets it.">
          <TextInput id="auto-schedule" name="schedule" defaultValue="" />
        </Field>

        <Field label="Run mode" htmlFor="auto-mode" hint="e.g. continuous, batch, on_demand">
          <TextInput id="auto-mode" name="runMode" defaultValue="" />
        </Field>

        <Field label="Purpose" htmlFor="auto-purpose">
          <TextArea id="auto-purpose" name="purpose" defaultValue="" />
        </Field>

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
          Save mapping
        </Button>
      </Stack>
    </form>
  );
}
