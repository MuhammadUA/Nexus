'use client';

import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Chip, Field, Row, Stack, TextArea, TextInput } from '@nexus/ui';

import {
  captureProfileAction,
  claimQueueItemAction,
  skipQueueItemAction,
} from '@/app/(app)/my-profile-queue/actions';

/** Mirrored result shape: a client component may only import functions from `'use server'`. */
interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly message?: string;
}

const INITIAL: ActionResult = { ok: false, error: null };

/**
 * U16 — Profile capture.
 *
 * Contract: "Work partial leads by opening LinkedIn, capturing URL + full profile content,
 * updating existing lead."
 *
 * The screen is deliberately one row per partial lead with three actions: open LinkedIn,
 * capture, skip. There is no "create lead" here, because
 * spec `lead_sources.profile_queue_flow` requires the capture to update the *existing*
 * partial lead — the server action passes the lead id the queue item already points at.
 *
 * What is pasted is untrusted: it is submitted as text, stored as text in
 * `source_evidence.raw_text_or_json`, and never interpreted in any way.
 */
export function ProfileCapturePanel({
  queueId,
  leadId,
  personName,
  linkedinUrl,
  state,
}: {
  readonly queueId: string;
  readonly leadId: string;
  readonly personName: string;
  readonly linkedinUrl: string | null;
  readonly state: string;
}): ReactElement {
  const [capture, captureAction, capturing] = useActionState(captureProfileAction, INITIAL);
  const [skip, skipAction, skipping] = useActionState(skipQueueItemAction, INITIAL);
  const [claim, claimAction, claiming] = useActionState(claimQueueItemAction, INITIAL);

  const captured = state === 'captured';
  const skipped = state === 'skipped';

  return (
    <Stack size="sm">
      <Row wrap>
        <Chip
          accent={state === 'failed' ? 'red' : state === 'captured' ? 'green' : state === 'skipped' ? 'neutral' : 'cyan'}
          dataState={state}
        >
          {state.replace(/_/g, ' ')}
        </Chip>
        {linkedinUrl !== null && (
          <a
            className="nx-btn nx-btn--secondary nx-btn--sm"
            href={linkedinUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open LinkedIn
          </a>
        )}
        {linkedinUrl === null && <span className="nx-hint">No profile URL yet — search by name and company.</span>}
        {state === 'pending' && (
          <form action={claimAction}>
            <input type="hidden" name="queueId" value={queueId} />
            <Button type="submit" variant="ghost" size="sm" busy={claiming}>
              Start working
            </Button>
          </form>
        )}
      </Row>

      {claim.error !== null && (
        <Alert accent="red" role="alert">
          {claim.error}
        </Alert>
      )}
      {claim.error === null && claim.message !== undefined && (
        <Alert accent="green" role="status">
          {claim.message}
        </Alert>
      )}

      {captured || skipped ? (
        <span className="nx-hint">
          {captured
            ? 'This profile has been captured onto the existing lead.'
            : 'This queue item was skipped; the lead keeps Needs profile and the reason is recorded.'}
        </span>
      ) : (
        <>
          <form action={captureAction}>
            <input type="hidden" name="queueId" value={queueId} />
            <input type="hidden" name="leadId" value={leadId} />
            <Stack size="sm">
              <Field
                label="LinkedIn profile URL"
                htmlFor={`capture-url-${queueId}`}
                required
                hint="The strongest person dedupe key. A URL that already belongs to another person is refused and sent to Duplicate Review."
              >
                <TextInput
                  id={`capture-url-${queueId}`}
                  name="linkedinUrl"
                  defaultValue={linkedinUrl ?? ''}
                  type="url"
                  placeholder={`https://www.linkedin.com/in/…`}
                  required
                />
              </Field>

              <Field
                label="Full copied profile content"
                htmlFor={`capture-content-${queueId}`}
                required
                hint={`Paste everything you copied from ${personName}'s profile. It is stored verbatim as provenance and never re-worded.`}
              >
                <TextArea
                  id={`capture-content-${queueId}`}
                  name="pageContent"
                  defaultValue=""
                  rows={8}
                  tall
                  mono
                  placeholder="Headline, location, experience, about…"
                />
              </Field>

              {capture.error !== null && (
                <Alert accent="red" role="alert">
                  {capture.error}
                </Alert>
              )}
              {capture.error === null && capture.message !== undefined && (
                <Alert accent="green" role="status">
                  {capture.message}
                </Alert>
              )}

              <Button type="submit" variant="primary" busy={capturing}>
                Capture onto this lead
              </Button>
            </Stack>
          </form>

          <form action={skipAction}>
            <input type="hidden" name="queueId" value={queueId} />
            <Stack size="sm">
              <Field
                label="Skip reason"
                htmlFor={`capture-skip-${queueId}`}
                hint="Required. The lead stays partial and the reason is kept on the queue item."
              >
                <TextInput id={`capture-skip-${queueId}`} name="reason" defaultValue="" />
              </Field>
              {skip.error !== null && (
                <Alert accent="amber" role="alert">
                  {skip.error}
                </Alert>
              )}
              {skip.error === null && skip.message !== undefined && (
                <Alert accent="green" role="status">
                  {skip.message}
                </Alert>
              )}
              <Button type="submit" variant="ghost" busy={skipping}>
                Skip this lead
              </Button>
            </Stack>
          </form>
        </>
      )}
    </Stack>
  );
}
