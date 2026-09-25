/**
 * Claim checking and message validation.
 *
 * The claim policy is the rule that stops an invented metric reaching a prospect, so these tests are
 * mostly about what it *catches*. One of them is a regression test for a defect found while wiring
 * the AI drafting path: the percentage branch of the numeric-claim pattern ended in `\b`, and since
 * `%` is not a word character a boundary immediately after it can only be satisfied by another word
 * character. `40%` therefore never matched, and every percentage claim — the single most likely
 * fabricated metric in outreach — passed the check unchallenged.
 */
import { describe, expect, it } from 'vitest';

import {
  ZEMNAS_MESSAGE_DEFAULTS,
  checkClaims,
  validateMessage,
  type MessageRuleSet,
} from './messaging-rules.js';

/** A body that satisfies every Zemnas rule, with a number that must be traceable to a claim. */
const VALID_BODY = [
  'Nadia, the hiring push you posted for 3 editors usually means delivery capacity is the',
  'constraint before headcount is. We edit quietly in the background so clients can increase',
  'capacity without building a team in-house. The work sits behind your brand and your process,',
  'and turnaround stays predictable through busy quarters. Happy to share how a comparable',
  'production team structured the same handoff, and equally happy to leave it if the timing is',
  'wrong.',
].join(' ');

const SIGNAL = 'hiring push for 3 editors';

function validate(content: string, overrides: Partial<MessageRuleSet> = {}, approvedClaims: readonly string[] = []) {
  return validateMessage({
    content,
    rules: { ...ZEMNAS_MESSAGE_DEFAULTS, ...overrides },
    approvedClaims,
    personalizationSignal: SIGNAL,
    mayMentionNumericResults: true,
    mayMentionClientName: false,
  });
}

describe('checkClaims — numeric claim detection', () => {
  it.each([
    'We cut turnaround by 40% for clients.',
    'We cut turnaround by 40 percent for clients.',
    'We work at 3x speed.',
    'We edit 3 videos a month.',
    'We handle 12 projects at once.',
    'We cover 40 hours a week for clients.',
    'Our retainer is $1.2m a year.',
  ])('flags the unapproved metric in %j', (content) => {
    const result = checkClaims({ content, approvedClaims: [] });
    expect(result.ok).toBe(false);
    expect(result.unverifiedClaims.length).toBeGreaterThan(0);
  });

  it('accepts a metric that an approved claim covers', () => {
    const result = checkClaims({
      content: 'Our retainer is $1.2m a year.',
      approvedClaims: ['We charge $1.2m for the annual retainer'],
    });
    expect(result.ok).toBe(true);
  });

  it('ignores a number that is not a first-person capability claim', () => {
    // The prospect's own posting is not Zemnas asserting a result.
    const result = checkClaims({
      content: 'Nadia posted a hiring push for 3 editors.',
      approvedClaims: [],
    });
    expect(result.ok).toBe(true);
  });

  it('refuses any digit when the business has forbidden numeric results', () => {
    // The sentence carries a metric but is not a first-person capability claim, so the
    // unapproved-claim reason does not fire and the configuration rule is what has to reject it.
    const result = checkClaims({
      content: 'The retainer would be $1.2m a year.',
      approvedClaims: [],
      mayMentionNumericResults: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('forbids mentioning numeric results');
  });

  it('does not corrupt its own state between calls', () => {
    // `NUMERIC_CLAIM_PATTERN` is global, and a global regex carries `lastIndex`. Two identical calls
    // must give the same answer.
    const input = { content: 'We edit 3 videos a month.', approvedClaims: [] };
    const first = checkClaims(input);
    const second = checkClaims(input);
    expect(second.unverifiedClaims).toEqual(first.unverifiedClaims);
    expect(second.ok).toBe(first.ok);
  });
});

describe('validateMessage — the full rule set', () => {
  it('passes a message that meets every rule', () => {
    const result = validate(VALID_BODY);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.words).toBe(74);
  });

  it('reports a prohibited phrase', () => {
    const result = validate(`Quick question — ${VALID_BODY}`);
    expect(result.violations.map((violation) => violation.code)).toContain('prohibited_phrase');
  });

  it('reports generic praise', () => {
    const result = validate(`Your profile is impressive. ${VALID_BODY}`);
    expect(result.violations.map((violation) => violation.code)).toContain('generic_praise');
  });

  it('reports a high-pressure call to action', () => {
    const result = validate(`${VALID_BODY} Book a call today.`);
    expect(result.violations.map((violation) => violation.code)).toContain('high_pressure_cta');
  });

  it('reports a missing personalization signal', () => {
    // Every token of the signal ("hiring push for 3 editors") is absent, so there is nothing for the
    // overlap test to match on.
    const result = validate(
      VALID_BODY.replace('the hiring push you posted for 3 editors', 'your team scaling plans for next year'),
    );
    expect(result.violations.map((violation) => violation.code)).toContain('missing_personalization');
  });

  it('reports a message that is too short', () => {
    const result = validate('Ada, we edit quietly in the background.');
    expect(result.violations.map((violation) => violation.code)).toContain('too_short');
  });

  it('reports a message that is too long', () => {
    const result = validate(`${VALID_BODY} ${VALID_BODY}`);
    expect(result.violations.map((violation) => violation.code)).toContain('too_long');
  });

  it('reports an unapproved numeric claim through the rules path', () => {
    const result = validate(
      VALID_BODY.replace(
        'Happy to share how a comparable production team structured the same handoff, and equally happy to leave it if the timing is wrong.',
        'We cut turnaround by 40% for clients, and happy to share how.',
      ),
    );
    expect(result.violations.map((violation) => violation.code)).toContain('unapproved_claim');
  });

  it('reports an empty message without inventing other violations', () => {
    const result = validate('   ');
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toEqual(['empty']);
  });

  it('enforces a narrowed word budget without touching the other rules', () => {
    const result = validate(VALID_BODY, { maxWords: 40 });
    expect(result.violations.map((violation) => violation.code)).toContain('too_long');
  });

  it('never rewrites content', () => {
    // "Sent message content is immutable" — validation reports, it does not repair.
    const result = validateMessage({
      content: 'Quick question — short.',
      rules: ZEMNAS_MESSAGE_DEFAULTS,
      approvedClaims: [],
      personalizationSignal: SIGNAL,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});
