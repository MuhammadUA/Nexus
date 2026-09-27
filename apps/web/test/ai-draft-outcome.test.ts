/**
 * How every drafting refusal reads to the operator.
 *
 * This is the operator-facing half of `AiFailureKind`. The nine provider kinds plus the three local
 * refusals must each render as their own state, and the two that matter most must read the way the
 * contract requires: "no AI key on this deployment" is a *normal deployment state*, and an unusable
 * model answer means "regenerate — nothing was stored" rather than a silent or alarming failure.
 */
import { describe, expect, it } from 'vitest';

import { DRAFT_NOTICES, noticeFor, type DraftErrorCode } from '@/lib/ai/draft-outcome';
import type { AiFailureKind } from '@/lib/ai/types';

/**
 * The nine provider kinds, as declared by `AiFailureKind`.
 *
 * `satisfies` keeps every entry a real member of the union. That the list is *complete* is enforced
 * elsewhere: `DRAFT_NOTICES` is a `Record<DraftErrorCode, DraftNotice>`, so a tenth kind cannot be
 * added without a notice, and the key-set comparison below fails if this list falls behind.
 */
const AI_FAILURE_KINDS = [
  'provider_not_configured',
  'unauthorized',
  'rate_limited',
  'timeout',
  'provider_unavailable',
  'invalid_request',
  'malformed_json',
  'schema_invalid',
  'empty_response',
] as const satisfies readonly AiFailureKind[];

const LOCAL_CODES = ['session_expired', 'permission_denied', 'invalid_input'] as const;

const ALL_CODES: readonly DraftErrorCode[] = [...AI_FAILURE_KINDS, ...LOCAL_CODES];

describe('drafting failure vocabulary', () => {
  it('declares exactly the nine provider kinds plus three local refusals', () => {
    expect(AI_FAILURE_KINDS).toHaveLength(9);
    expect(ALL_CODES).toHaveLength(12);
    // Drift guard: the mapping is total, so its key set is the real vocabulary.
    expect(new Set(Object.keys(DRAFT_NOTICES))).toEqual(new Set(ALL_CODES));
  });
});

describe('noticeFor', () => {
  it('renders every AiFailureKind, with no fall-through case', () => {
    for (const kind of AI_FAILURE_KINDS) {
      const notice = noticeFor(kind);
      expect(notice.title.length).toBeGreaterThan(0);
      expect(notice.body.length).toBeGreaterThan(0);
      expect(notice).toBe(DRAFT_NOTICES[kind]);
    }
  });

  it('gives every state its own title, so no two failures read the same', () => {
    const titles = ALL_CODES.map((code) => noticeFor(code).title);
    expect(new Set(titles).size).toBe(ALL_CODES.length);
  });

  it('never leaks a key, a token or a provider URL', () => {
    for (const code of ALL_CODES) {
      const notice = noticeFor(code);
      const text = `${notice.title}\n${notice.body}`;
      expect(text).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
      expect(text).not.toMatch(/bearer\s/i);
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/DEEPSEEK_API_KEY\s*=/);
    }
  });
});

describe('provider_not_configured', () => {
  const notice = noticeFor('provider_not_configured');

  it('is a normal deployment state, not an error', () => {
    // Neutral palette and a `status` announcement: a deployment without a key is supported, and the
    // operator has neither made a mistake nor got anything to retry.
    expect(notice.accent).toBe('neutral');
    expect(notice.interrupt).toBe(false);
    expect(notice.title).toMatch(/not configured/i);
    expect(notice.title).not.toMatch(/error|failed|failure|invalid|broken/i);
    expect(notice.body).toMatch(/normal deployment state/i);
    expect(notice.body).not.toMatch(/try again|retry/i);
  });

  it('still offers the manual path', () => {
    expect(notice.body).toMatch(/message yourself/i);
  });
});

describe('an unusable model answer', () => {
  it('reads as regenerate with nothing stored', () => {
    for (const code of ['schema_invalid', 'malformed_json', 'empty_response'] as const) {
      const notice = noticeFor(code);
      expect(notice.body).toMatch(/regenerate/i);
      expect(notice.body).toMatch(/nothing was stored/i);
      expect(notice.accent).toBe('amber');
      expect(notice.interrupt).toBe(true);
    }
  });

  it('says a rules violation was discarded rather than repaired', () => {
    const notice = noticeFor('schema_invalid');
    expect(notice.title).toMatch(/messaging rules/i);
    expect(notice.body).toMatch(/discarded rather than repaired/i);
  });

  it('reports that nothing was stored for every failure that wrote nothing', () => {
    // Every refusal except a session problem leaves the message exactly as it was; the operator has to
    // be told that explicitly, or "did it save something broken?" is unanswerable from the screen.
    for (const code of [
      'unauthorized',
      'rate_limited',
      'timeout',
      'provider_unavailable',
      'invalid_request',
      'malformed_json',
      'schema_invalid',
      'empty_response',
      'permission_denied',
      'invalid_input',
      'session_expired',
    ] as const) {
      expect(noticeFor(code).body).toMatch(/nothing was stored|nothing was stored or accepted/i);
    }
  });
});
