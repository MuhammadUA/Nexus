'use client';

/**
 * AI drafting control for the Lead Detail "current action" (A04 / U06).
 *
 * It invokes the real `draftMessageAction` for the lead's due `message_instance`, renders the stored
 * result in the same `MessageBlock` the rest of the screen uses, and lets the operator accept the
 * draft (through `acceptDraftAction`, which records the acceptance) or regenerate it.
 *
 * Three rules shape it:
 *
 *   1. **Every refusal is a distinct, named state.** The nine members of `AiFailureKind` are all
 *      rendered, because "no AI key here" (a normal deployment state), "the provider is throttling"
 *      (retry shortly) and "the model's answer was unusable" (regenerate — nothing was stored) call
 *      for three different operator responses.
 *   2. **`provider_not_configured` is not an error.** It is announced on the neutral palette with
 *      `role="status"`, never as a failure, and the manual path is still offered: a deployment with no
 *      AI key is a supported configuration, not a broken feature.
 *   3. **Nothing secret is rendered.** The action returns an operator-safe sentence, rule codes and a
 *      body; no key, base URL or upstream error body is part of the result, and none is shown.
 */
import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Chip, MessageBlock, Row, Stack } from '@nexus/ui';

import { noticeFor, type DraftErrorCode } from '@/lib/ai/draft-outcome';

import {
  acceptDraftAction,
  draftMessageAction,
  type DraftActionResult,
} from '@/app/b/[slug]/leads/[id]/actions';

const INITIAL: DraftActionResult = { ok: false, error: null };

/** Renders a refusal. Rule codes are shown as names only: they are never message content. */
function DraftFailure({
  code,
  retryable,
  issues,
  error,
}: {
  readonly code: DraftErrorCode;
  readonly retryable?: boolean;
  readonly issues?: readonly string[];
  readonly error: string | null | undefined;
}): ReactElement {
  const notice = noticeFor(code);
  return (
    <Alert accent={notice.accent} title={notice.title} role={notice.interrupt ? 'alert' : 'status'}>
      <Stack size="sm">
        <span>{notice.body}</span>
        {error !== null && error !== undefined && <span>{error}</span>}
        {issues !== undefined && issues.length > 0 && (
          <Row wrap>
            {issues.slice(0, 4).map((issue) => (
              <Chip key={issue} accent="neutral">
                {issue}
              </Chip>
            ))}
          </Row>
        )}
        {retryable === true && <span>This one may succeed on a second attempt.</span>}
      </Stack>
    </Alert>
  );
}

export function AiDraftControl({
  leadId,
  businessSlug,
  businessId,
  messageInstanceId,
  messageVersionId,
  hasStoredContent,
}: {
  readonly leadId: string;
  readonly businessSlug: string;
  readonly businessId: string;
  readonly messageInstanceId: string;
  /** The stored version this message already has, if any. The acceptance acts on exactly this row. */
  readonly messageVersionId: string | null;
  /** True when the message already has stored content, so the button offers a regeneration. */
  readonly hasStoredContent: boolean;
}): ReactElement {
  const [draftState, draftAction, drafting] = useActionState(draftMessageAction, INITIAL);
  const [acceptState, acceptAction, accepting] = useActionState(acceptDraftAction, INITIAL);

  // The version just stored wins; otherwise the one the page read. Only a stored version can be
  // accepted, so the control offers acceptance exactly when one exists — including a draft generated
  // in an earlier visit, which a fresh page load still shows.
  const acceptVersionId = draftState.draft?.messageVersionId ?? messageVersionId;
  const drafted = draftState.draft;

  return (
    <Stack size="sm">
      <Row wrap>
        <Chip accent="indigo">AI drafting</Chip>
        <span className="nx-hint">
          Grounded only in this business&apos;s approved, AI-usable knowledge assets.
        </span>
      </Row>

      <form action={draftAction}>
        <input type="hidden" name="leadId" value={leadId} />
        <input type="hidden" name="businessSlug" value={businessSlug} />
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="messageInstanceId" value={messageInstanceId} />
        <Stack size="sm">
          {draftState.errorCode !== undefined && (
            <DraftFailure
              code={draftState.errorCode}
              retryable={draftState.retryable}
              issues={draftState.issues}
              error={draftState.error}
            />
          )}
          {draftState.ok && draftState.message !== undefined && (
            <Alert accent="green" role="status">
              {draftState.message}
            </Alert>
          )}
          <Row wrap>
            <Button type="submit" variant={hasStoredContent ? 'secondary' : 'primary'} busy={drafting}>
              {hasStoredContent ? 'Regenerate with AI' : 'Draft with AI'}
            </Button>
            {draftState.errorCode === undefined && !draftState.ok && (
              <span className="nx-hint">
                Sends this lead, its due step and the approved knowledge assets to the configured model.
              </span>
            )}
          </Row>
        </Stack>
      </form>

      {drafted !== undefined && (
        <MessageBlock
          direction="outbound"
          meta={
            <span>
              AI draft · {String(drafted.wordCount)} words · {drafted.model} · awaiting your review
            </span>
          }
        >
          {drafted.body}
        </MessageBlock>
      )}

      {acceptVersionId !== null && (
        <form action={acceptAction}>
          <input type="hidden" name="leadId" value={leadId} />
          <input type="hidden" name="businessSlug" value={businessSlug} />
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="messageInstanceId" value={messageInstanceId} />
          <input type="hidden" name="messageVersionId" value={acceptVersionId} />
          <Stack size="sm">
            {acceptState.errorCode !== undefined && (
              <DraftFailure code={acceptState.errorCode} error={acceptState.error} />
            )}
            {acceptState.ok && acceptState.message !== undefined && (
              <Alert accent="green" role="status">
                {acceptState.message}
              </Alert>
            )}
            <Row wrap>
              <Button type="submit" variant="primary" busy={accepting}>
                Accept draft
              </Button>
              <span className="nx-hint">
                Keeps this version as the message and records the acceptance in the audit trail.
              </span>
            </Row>
          </Stack>
        </form>
      )}
    </Stack>
  );
}
