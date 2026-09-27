/**
 * How a drafting refusal reads to the operator.
 *
 * Separated from the control so the wording — the part that decides whether "no AI key here" reads as
 * a normal deployment state or as a fault — is testable without a DOM.
 *
 * The notices are a `Record` over `DraftErrorCode`, so the mapping is total by construction: a new
 * failure kind cannot reach the UI without someone writing a sentence for it, and every one of the
 * nine `AiFailureKind` members has its own, distinct rendering.
 *
 * Nothing here may contain a secret, an API key, a base URL or an upstream error body. These strings
 * are written for the operator and are asserted to be free of key-shaped text by the test that covers
 * this module.
 */
import type { AiFailureKind } from './types';

/**
 * Every state the drafting control renders.
 *
 * The first nine are the provider's own closed vocabulary, surfaced verbatim so the control branches
 * on a code rather than on prose that a reword would break. The last three describe refusals the
 * provider never sees.
 */
export type DraftErrorCode = AiFailureKind | 'session_expired' | 'permission_denied' | 'invalid_input';

export interface DraftNotice {
  readonly accent: 'neutral' | 'amber' | 'red';
  /** A normal deployment state announces itself (`status`); a refusal interrupts (`alert`). */
  readonly interrupt: boolean;
  readonly title: string;
  readonly body: string;
}

export const DRAFT_NOTICES: Readonly<Record<DraftErrorCode, DraftNotice>> = {
  provider_not_configured: {
    // Deliberately NOT an error and not on a warning palette: a deployment without an AI key is a
    // supported configuration, and the operator has done nothing wrong and has nothing to retry.
    accent: 'neutral',
    interrupt: false,
    title: 'AI drafting is not configured on this deployment',
    body:
      'No AI provider key is set here, so drafting is unavailable — a normal deployment state rather than a fault, and nothing is broken. Write or paste the message yourself and send it as usual.',
  },
  unauthorized: {
    accent: 'red',
    interrupt: true,
    title: 'The AI provider rejected the credential on this deployment',
    body:
      'This is a deployment configuration problem, not something to retry from here, and nothing was stored. Tell an administrator that the AI provider key is invalid.',
  },
  rate_limited: {
    accent: 'amber',
    interrupt: true,
    title: 'The AI provider is rate limiting requests',
    body: 'Wait a moment, then regenerate. Nothing was stored by this attempt.',
  },
  timeout: {
    accent: 'amber',
    interrupt: true,
    title: 'The AI provider did not answer in time',
    body: 'Regenerate — nothing was stored. A slow provider is the usual cause, and a second attempt often succeeds.',
  },
  provider_unavailable: {
    accent: 'amber',
    interrupt: true,
    title: 'The AI provider is unavailable',
    body: 'Regenerate in a little while — nothing was stored. The provider could not be reached, which is not about this lead.',
  },
  invalid_request: {
    accent: 'amber',
    interrupt: true,
    title: 'The AI provider rejected the request',
    body:
      'Regenerating usually will not help, because the request itself was refused. Nothing was stored. Review the step wording and try once more before reporting it.',
  },
  malformed_json: {
    accent: 'amber',
    interrupt: true,
    title: 'The AI returned an answer that could not be read',
    body: 'Regenerate — nothing was stored. Unparseable output is never kept.',
  },
  schema_invalid: {
    accent: 'amber',
    interrupt: true,
    title: 'The draft broke the messaging rules, so it was discarded',
    body:
      'Regenerate — nothing was stored. A body that misses its personalization signal, asserts an unapproved claim or uses a prohibited phrase is discarded rather than repaired, so what you are shown is never unvalidated text.',
  },
  empty_response: {
    accent: 'amber',
    interrupt: true,
    title: 'The AI returned an empty answer',
    body: 'Regenerate — nothing was stored.',
  },
  session_expired: {
    accent: 'red',
    interrupt: true,
    title: 'Your session expired',
    body: 'Sign in again and reload this lead. Nothing was stored.',
  },
  permission_denied: {
    accent: 'red',
    interrupt: true,
    title: 'You cannot draft on this lead',
    body:
      'Drafting follows the same access as this lead screen. Ask an administrator for access to this business. Nothing was stored.',
  },
  invalid_input: {
    accent: 'amber',
    interrupt: true,
    title: 'That draft is no longer available',
    body:
      'The message changed — it was sent, or a newer version replaced this draft — so nothing was stored or accepted. Regenerate to get a current draft.',
  },
};

export function noticeFor(code: DraftErrorCode): DraftNotice {
  return DRAFT_NOTICES[code];
}
