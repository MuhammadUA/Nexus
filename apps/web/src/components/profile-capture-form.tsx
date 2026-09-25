'use client';

/**
 * Profile capture form (A06).
 *
 * spec `lead_sources.profile_queue_flow`: "Open search/profile, capture LinkedIn
 * URL + full copied profile data, update the existing partial lead rather than
 * creating a new lead."
 *
 * The form is deliberately shaped to that contract:
 *   - the lead is fixed and shown, so there is no way to capture against a
 *     different record;
 *   - the LinkedIn URL is pre-filled from the lead when it already has one;
 *   - the pasted page content is displayed back as plain text only;
 *   - the submit button says "Update this lead" because that is what happens.
 */
import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Field, Stack, TextArea, TextInput } from '@nexus/ui';

import {
  captureProfileAction,
  markInProgressAction,
  retryQueueItemAction,
  skipQueueItemAction,
  type ActionResult,
} from '@/app/b/[slug]/profile-queue/actions';

const INITIAL: ActionResult = { ok: false, error: null };

export function ProfileCaptureForm({
  businessSlug,
  leadId,
  queueId,
  personName,
  defaultLinkedinUrl,
  queueState,
}: {
  readonly businessSlug: string;
  readonly leadId: string;
  readonly queueId: string;
  readonly personName: string;
  readonly defaultLinkedinUrl: string;
  readonly queueState: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(captureProfileAction, INITIAL);
  const [openState, openAction, openPending] = useActionState(markInProgressAction, INITIAL);
  const [skipState, skipAction, skipPending] = useActionState(skipQueueItemAction, INITIAL);
  const [retryState, retryAction, retryPending] = useActionState(retryQueueItemAction, INITIAL);

  const contentId = `pc-content-${queueId}`;
  const urlId = `pc-url-${queueId}`;
  const confidenceId = `pc-confidence-${queueId}`;
  const skipId = `pc-skip-${queueId}`;

  return (
    <Stack size="md">
      <form action={formAction}>
        <input type="hidden" name="businessSlug" value={businessSlug} />
        <input type="hidden" name="leadId" value={leadId} />

        <Stack size="md">
          <Field
            label="LinkedIn profile URL"
            htmlFor={urlId}
            required
            hint="The member profile URL for this person. It becomes the strongest dedupe key on the existing person."
          >
            <TextInput
              id={urlId}
              name="linkedinUrl"
              type="url"
              defaultValue={defaultLinkedinUrl}
              placeholder="https://www.linkedin.com/in/…"
              required
            />
          </Field>

          <Field
            label="Full copied profile content"
            htmlFor={contentId}
            required
            hint="Select the whole profile page and paste it here. It is stored verbatim as source evidence and never executed."
          >
            <TextArea
              id={contentId}
              name="pageContent"
              tall
              mono
              rows={14}
              required
              placeholder="Paste the entire copied profile: name, headline, about, experience, education, activity…"
            />
          </Field>

          <Field
            label="Extractor confidence"
            htmlFor={confidenceId}
            hint="Optional, 0 to 1. Leave blank when the capture is a verbatim manual paste."
          >
            <TextInput
              id={confidenceId}
              name="extractorConfidence"
              type="number"
              defaultValue=""
              placeholder="1"
            />
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

          <span className="nx-hint">
            Saving updates {personName}&apos;s existing lead: the person record, the source evidence, and Needs
            Profile is cleared. It never creates a second lead.
          </span>

          <Button type="submit" variant="primary" busy={pending}>
            Update this lead
          </Button>
        </Stack>
      </form>

      {queueState === 'pending' && (
        <form action={openAction}>
          <input type="hidden" name="businessSlug" value={businessSlug} />
          <input type="hidden" name="queueId" value={queueId} />
          <Stack size="sm">
            {openState.error !== null && (
              <Alert accent="red" role="alert">
                {openState.error}
              </Alert>
            )}
            {openState.error === null && openState.message !== undefined && (
              <Alert accent="green" role="status">
                {openState.message}
              </Alert>
            )}
            <Button type="submit" variant="secondary" size="sm" busy={openPending}>
              Mark in progress
            </Button>
          </Stack>
        </form>
      )}

      {queueState === 'failed' && (
        <form action={retryAction}>
          <input type="hidden" name="businessSlug" value={businessSlug} />
          <input type="hidden" name="queueId" value={queueId} />
          <Stack size="sm">
            {retryState.error !== null && (
              <Alert accent="red" role="alert">
                {retryState.error}
              </Alert>
            )}
            {retryState.error === null && retryState.message !== undefined && (
              <Alert accent="green" role="status">
                {retryState.message}
              </Alert>
            )}
            <Button type="submit" variant="secondary" size="sm" busy={retryPending}>
              Queue another attempt
            </Button>
          </Stack>
        </form>
      )}

      <form action={skipAction}>
        <input type="hidden" name="businessSlug" value={businessSlug} />
        <input type="hidden" name="queueId" value={queueId} />
        <Stack size="sm">
          <Field
            label="Skip this lead"
            htmlFor={skipId}
            hint="Use only when no profile can be captured — the reason is recorded on the queue item."
          >
            <TextInput id={skipId} name="reason" defaultValue="" placeholder="Why is this lead being skipped?" />
          </Field>
          {skipState.error !== null && (
            <Alert accent="red" role="alert">
              {skipState.error}
            </Alert>
          )}
          {skipState.error === null && skipState.message !== undefined && (
            <Alert accent="green" role="status">
              {skipState.message}
            </Alert>
          )}
          <Button type="submit" variant="ghost" size="sm" busy={skipPending}>
            Skip
          </Button>
        </Stack>
      </form>
    </Stack>
  );
}
