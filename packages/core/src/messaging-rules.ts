/**
 * Messaging rules and claim policy.
 *
 * Spec `messaging_rules.general`, `messaging_rules.zemnas`,
 * `business_brain_and_knowledge.claim_policy`.
 *
 * The rule set is *configuration*, not product constants: `ZEMNAS_MESSAGE_DEFAULTS`
 * is the seed used for a new business, and every check takes an explicit
 * `MessageRuleSet` so a business can override it through Business Brain without a
 * code change.
 */

import { collapseWhitespace, wordCount } from './normalize.js';

/* ------------------------------------------------------------- rule set - */

export interface MessageRuleSet {
  /** Inclusive word budget. */
  readonly minWords: number;
  readonly maxWords: number;
  /** Phrases that must not appear, matched case-insensitively. */
  readonly prohibitedPhrases: readonly string[];
  /** Require at least one concrete personalization signal. */
  readonly requirePersonalizationSignal: boolean;
  /** Require the positioning sentence explaining the company. */
  readonly requireOneSentenceExplanation: boolean;
  /** Require a low-pressure CTA. */
  readonly requireLowPressureCta: boolean;
  /** Disallow numeric results / metrics not backed by approved claims. */
  readonly requireApprovedClaimsForNumbers: boolean;
}

/**
 * spec `messaging_rules.zemnas`:
 *   target_length_words: "about 60-80"
 *   avoid_phrases: ["I hope you're well", "following up", "quick question",
 *     "I came across your profile", "generic praise"]
 *   positioning: "We handle editing quietly in the background so clients can
 *     increase delivery capacity without building everything in-house."
 */
export const ZEMNAS_MESSAGE_DEFAULTS: MessageRuleSet = {
  minWords: 60,
  maxWords: 80,
  prohibitedPhrases: [
    "I hope you're well",
    'I hope you are well',
    'hope this finds you well',
    'following up',
    'follow up on my previous',
    'just following up',
    'quick question',
    'I came across your profile',
    'came across your profile',
    'reaching out because I saw your profile',
  ],
  requirePersonalizationSignal: true,
  requireOneSentenceExplanation: true,
  requireLowPressureCta: true,
  requireApprovedClaimsForNumbers: true,
};

/**
 * Generic praise that the spec bans outright. These are patterns rather than
 * fixed strings because the banned category is "generic praise", not one phrase.
 */
export const GENERIC_PRAISE_PATTERNS: readonly RegExp[] = [
  /\b(love|really like|big fan of)\s+(your|the)\s+(profile|work|content|posts)\b/i,
  /\byour\s+(profile|background)\s+is\s+(impressive|amazing|great)\b/i,
  /\bimpressive\s+(background|profile|career|track record)\b/i,
  /\byou(?:'re| are)\s+doing\s+(great|amazing|incredible)\s+work\b/i,
  /\b(awesome|great|amazing|fantastic)\s+(work|company|culture)\b/i,
  /\bcongrats?\s+on\s+(the|your)\s+(growth|success|milestone)\b/i,
];

/** Phrases that read as high-pressure CTAs. */
export const HIGH_PRESSURE_CTA_PATTERNS: readonly RegExp[] = [
  /\bbook\s+a\s+(call|demo|meeting)\s+(today|now|asap)\b/i,
  /\b(schedule|book)\s+time\s+(on|in)\s+my\s+calendar\b/i,
  /\bwhen\s+can\s+we\s+(talk|jump\s+on\s+a\s+call|get\s+on\s+a\s+call)\b/i,
  /\bare\s+you\s+free\s+(today|tomorrow|this\s+week)\b/i,
  /\blet'?s\s+(get\s+on\s+a\s+call|hop\s+on\s+a\s+call)\b/i,
  /\burgent(ly)?\b/i,
  /\b(last|final)\s+chance\b/i,
  /\bdon'?t\s+miss\s+out\b/i,
];

/**
 * A low-pressure CTA either invites a soft reply or offers something free with no
 * commitment. This is deliberately permissive: the rule bans pressure, not
 * directness.
 */
export const LOW_PRESSURE_CTA_PATTERNS: readonly RegExp[] = [
  /\bif\s+(it'?s|that'?s)\s+(useful|relevant|helpful|of\s+interest)\b/i,
  /\bworth\s+a\s+(look|quick\s+look|chat)\b/i,
  /\bno\s+(pressure|rush|obligation|worries)\b/i,
  /\bhappy\s+to\s+(share|send|show)\b/i,
  /\bwould\s+(it|that)\s+(be\s+)?(useful|helpful|worth)\b/i,
  /\bopen\s+to\s+(a\s+)?(quick\s+)?(chat|look|conversation)\b/i,
  /\bif\s+you'?d\s+like\b/i,
  /\blet\s+me\s+know\s+if\b/i,
  /\bwant\s+me\s+to\s+(send|share|try)\b/i,
  /\bfree\s+(first\s+)?(edit|trial|sample|test)\b/i,
  /\bonly\s+if\s+(it'?s|that'?s)\s+relevant\b/i,
];

/* ------------------------------------------------------- claim checking - */

/** A number-with-unit token such as "40%", "3x", "$1.2m", "200 videos". */
const NUMERIC_CLAIM_PATTERN =
  /(?:\$\s?\d[\d,.]*\s?(?:k|m|bn|billion|million|thousand)?|\b\d[\d,.]*\s?(?:%|x|×|percent|fold)\b|\b\d[\d,.]*\s?\+?\s?(?:videos?|edits?|projects?|clients?|brands?|hours?|days?|weeks?|months?|years?|people|editors?)\b)/gi;

/** Words that make a sentence a first-person capability claim. */
const FIRST_PERSON_CLAIM = /\b(we|our|i|my)\b/i;

export interface ClaimCheckInput {
  readonly content: string;
  /** Approved factual claims from Business Brain that the draft may assert. */
  readonly approvedClaims?: readonly string[];
  /** When false, the business has not authorised mentioning numeric results. */
  readonly mayMentionNumericResults?: boolean;
}

export interface ClaimCheckResult {
  readonly ok: boolean;
  readonly unverifiedClaims: readonly string[];
  readonly blocked: boolean;
  readonly reasons: readonly string[];
}

/**
 * spec `business_brain_and_knowledge.claim_policy`:
 * "Outbound may use only approved factual claims. Never invent metrics/results."
 *
 * Detection is intentionally conservative: any numeric quantifier attached to a
 * capability noun in a first-person sentence must be traceable to an approved
 * claim string, otherwise the draft is blocked server-side before it can be sent.
 */
export function checkClaims(input: ClaimCheckInput): ClaimCheckResult {
  const reasons: string[] = [];
  const unverified: string[] = [];
  const approved = input.approvedClaims ?? [];
  const approvedNormalized = approved.map((c) => collapseWhitespace(c).toLowerCase());

  const sentences = splitSentences(input.content);
  for (const sentence of sentences) {
    const matches = sentence.match(NUMERIC_CLAIM_PATTERN);
    if (!matches) continue;
    if (!FIRST_PERSON_CLAIM.test(sentence)) continue;
    for (const match of matches) {
      const token = collapseWhitespace(match).toLowerCase();
      const covered = approvedNormalized.some((claim) => claim.includes(token));
      if (!covered) unverified.push(token);
    }
  }

  if (unverified.length > 0) {
    reasons.push(
      `unapproved numeric claim(s): ${[...new Set(unverified)].join(', ')} — outbound may only use approved factual claims`,
    );
  }

  if (input.mayMentionNumericResults === false && unverified.length === 0) {
    const anyNumbers = NUMERIC_CLAIM_PATTERN.test(input.content);
    NUMERIC_CLAIM_PATTERN.lastIndex = 0;
    if (anyNumbers) {
      reasons.push('business configuration forbids mentioning numeric results');
    }
  }

  return { ok: reasons.length === 0, unverifiedClaims: unverified, blocked: reasons.length > 0, reasons };
}

function splitSentences(content: string): string[] {
  return collapseWhitespace(content)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/* -------------------------------------------------------- validation ---- */

export interface MessageValidationInput {
  readonly content: string;
  readonly rules: MessageRuleSet;
  /** The one real personalization signal the draft is built on, if supplied. */
  readonly personalizationSignal?: string | null;
  readonly approvedClaims?: readonly string[];
  readonly mayMentionClientName?: boolean;
  readonly mayMentionNumericResults?: boolean;
  /** Client names that must not appear when not authorised. */
  readonly clientNamesToAvoid?: readonly string[];
}

export type MessageViolationCode =
  | 'too_short'
  | 'too_long'
  | 'prohibited_phrase'
  | 'generic_praise'
  | 'high_pressure_cta'
  | 'missing_personalization'
  | 'missing_explanation'
  | 'missing_low_pressure_cta'
  | 'unapproved_claim'
  | 'unauthorized_client_name'
  | 'empty';

export interface MessageViolation {
  readonly code: MessageViolationCode;
  readonly message: string;
  readonly detail?: string;
}

export interface MessageValidationResult {
  readonly ok: boolean;
  readonly words: number;
  readonly violations: readonly MessageViolation[];
}

/**
 * Validate a generated or manually edited outbound message.
 *
 * This runs server-side immediately before a message may be marked sent, and is
 * also used to warn the operator in Focus views. It never rewrites content —
 * rewrites would violate "Sent message content is immutable".
 */
export function validateMessage(input: MessageValidationInput): MessageValidationResult {
  const violations: MessageViolation[] = [];
  const content = input.content ?? '';
  const trimmed = collapseWhitespace(content);

  if (trimmed.length === 0) {
    return { ok: false, words: 0, violations: [{ code: 'empty', message: 'Message is empty' }] };
  }

  const words = wordCount(content);
  const rules = input.rules;

  if (words < rules.minWords) {
    violations.push({
      code: 'too_short',
      message: `Message is ${words} words; target is about ${rules.minWords}–${rules.maxWords}`,
      detail: String(words),
    });
  }
  if (words > rules.maxWords) {
    violations.push({
      code: 'too_long',
      message: `Message is ${words} words; target is about ${rules.minWords}–${rules.maxWords}`,
      detail: String(words),
    });
  }

  for (const phrase of rules.prohibitedPhrases) {
    if (containsPhrase(trimmed, phrase)) {
      violations.push({
        code: 'prohibited_phrase',
        message: `Contains a prohibited phrase: "${phrase}"`,
        detail: phrase,
      });
    }
  }

  for (const pattern of GENERIC_PRAISE_PATTERNS) {
    const hit = pattern.exec(trimmed);
    if (hit) {
      violations.push({
        code: 'generic_praise',
        message: `Contains generic praise: "${hit[0]}"`,
        detail: hit[0],
      });
      break;
    }
  }

  for (const pattern of HIGH_PRESSURE_CTA_PATTERNS) {
    const hit = pattern.exec(trimmed);
    if (hit) {
      violations.push({
        code: 'high_pressure_cta',
        message: `High-pressure CTA: "${hit[0]}"`,
        detail: hit[0],
      });
      break;
    }
  }

  if (rules.requirePersonalizationSignal) {
    const signal = input.personalizationSignal ? collapseWhitespace(input.personalizationSignal) : '';
    if (signal.length === 0) {
      violations.push({
        code: 'missing_personalization',
        message: 'One real personalization signal is required',
      });
    } else if (!contentOverlapsSignal(trimmed, signal)) {
      violations.push({
        code: 'missing_personalization',
        message: 'The message does not reference the supplied personalization signal',
        detail: signal,
      });
    }
  }

  if (rules.requireOneSentenceExplanation) {
    // "explain Zemnas in one sentence" — look for a first-person capability
    // sentence of a single clause.
    const hasExplanation = splitSentences(trimmed).some(
      (s) =>
        /\b(we|our)\b/i.test(s) &&
        /\b(handle|help|do|build|provide|work|edit|deliver|run|manage|offer)\b/i.test(s),
    );
    if (!hasExplanation) {
      violations.push({
        code: 'missing_explanation',
        message: 'Missing the one-sentence explanation of what we do',
      });
    }
  }

  if (rules.requireLowPressureCta) {
    const hasLowPressure = LOW_PRESSURE_CTA_PATTERNS.some((p) => p.test(trimmed));
    if (!hasLowPressure) {
      violations.push({
        code: 'missing_low_pressure_cta',
        message: 'Missing a low-pressure call to action',
      });
    }
  }

  if (rules.requireApprovedClaimsForNumbers) {
    const claimCheck = checkClaims({
      content: trimmed,
      approvedClaims: input.approvedClaims,
      mayMentionNumericResults: input.mayMentionNumericResults,
    });
    if (!claimCheck.ok) {
      violations.push({
        code: 'unapproved_claim',
        message: claimCheck.reasons.join('; '),
        detail: claimCheck.unverifiedClaims.join(', '),
      });
    }
  }

  if (input.mayMentionClientName === false) {
    for (const name of input.clientNamesToAvoid ?? []) {
      if (name.length > 2 && containsPhrase(trimmed, name)) {
        violations.push({
          code: 'unauthorized_client_name',
          message: `Client name must not be mentioned: "${name}"`,
          detail: name,
        });
      }
    }
  }

  return { ok: violations.length === 0, words, violations };
}

function containsPhrase(haystack: string, needle: string): boolean {
  const n = collapseWhitespace(needle).toLowerCase();
  if (n.length === 0) return false;
  return haystack.toLowerCase().includes(n);
}

/** Overlap test used for personalization: at least one significant token shared. */
function contentOverlapsSignal(content: string, signal: string): boolean {
  const significant = collapseWhitespace(signal)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
  if (significant.length === 0) {
    return content.toLowerCase().includes(signal.toLowerCase());
  }
  const lower = content.toLowerCase();
  return significant.some((token) => lower.includes(token));
}

/* ------------------------------------------------ selective retrieval --- */

export interface RetrievalAsset {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly approvalState: string;
  readonly aiUseAllowed: boolean;
  readonly businessId: string;
  readonly icpIds: readonly string[];
}

export interface RetrievalInput {
  readonly businessId: string;
  readonly icpId: string | null;
  readonly signalKinds: readonly string[];
  readonly companyIndustry?: string | null;
  readonly limit?: number;
}

/**
 * spec `business_brain_and_knowledge.retrieval`: "Prospect + company + signal +
 * ICP/need -> retrieve top relevant approved value prop + proof -> model draft.
 * Do not dump the entire Business Brain into every prompt."
 *
 * Only assets with `aiUseAllowed` and an approved state are eligible, and the
 * result is capped so prompts stay small.
 */
export function selectRelevantAssets(
  input: RetrievalInput,
  assets: readonly RetrievalAsset[],
): readonly RetrievalAsset[] {
  const limit = input.limit ?? 5;
  const signalTokens = new Set(
    input.signalKinds.flatMap((s) => s.split(/[^a-z0-9]+/i).map((t) => t.toLowerCase())).filter((t) => t.length >= 4),
  );
  const industryTokens = new Set(
    (input.companyIndustry ?? '')
      .split(/[^a-z0-9]+/i)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 4),
  );

  const scored = assets
    .filter((a) => a.businessId === input.businessId)
    .filter((a) => a.aiUseAllowed)
    .filter((a) => a.approvalState === 'approved')
    .filter((a) => input.icpId === null || a.icpIds.length === 0 || a.icpIds.includes(input.icpId))
    .map((asset) => {
      let score = 0;
      for (const tag of asset.tags) {
        const t = tag.toLowerCase();
        if (signalTokens.has(t)) score += 3;
        if (industryTokens.has(t)) score += 2;
      }
      // Proof-bearing asset types are preferred for follow-ups.
      if (asset.type === 'Case Study' || asset.type === 'Testimonial') score += 2;
      if (asset.type === 'Offer' || asset.type === 'Value proposition') score += 1;
      return { asset, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));

  return scored.slice(0, limit).map((s) => s.asset);
}

/* ------------------------------------------------- prompt composition -- */

export interface DraftPromptInput {
  readonly stepName: string;
  readonly goal: string | null;
  readonly wordMax: number | null;
  readonly ctaStyle: string | null;
  readonly tone: string | null;
  readonly proofPolicy: string | null;
  readonly allowedContext: readonly string[];
  readonly rules: MessageRuleSet;
  readonly personalizationSignal: string;
  readonly companyName: string;
  readonly jobTitle: string | null;
  readonly icpName: string;
  readonly approvedClaims: readonly string[];
  readonly retrievedAssets: readonly RetrievalAsset[];
  readonly priorMessages: readonly string[];
  readonly reactivation: boolean;
}

/**
 * Compose the drafting prompt.
 *
 * The retrieved asset set is passed as a bounded, explicit allow-list and the
 * prompt states plainly that anything outside it is not assertable, which is what
 * makes `checkClaims` enforceable after generation.
 */
export function composeDraftPrompt(input: DraftPromptInput): string {
  const lines: string[] = [];
  lines.push('You draft a single short LinkedIn outreach message.');
  lines.push('');
  lines.push('HARD RULES');
  lines.push(`- Between ${input.rules.minWords} and ${input.rules.maxWords} words.`);
  lines.push('- Never invent company facts, results, client names, metrics or hiring signals.');
  lines.push('- Use only the approved claims and assets listed below. If a fact is not listed, do not state it.');
  lines.push('- Do not use any of these phrases: ' + input.rules.prohibitedPhrases.map((p) => `"${p}"`).join(', ') + '.');
  lines.push('- No generic praise about the prospect or their profile.');
  lines.push('- Exactly one real personalization signal must be referenced.');
  lines.push('- Explain what we do in one sentence.');
  lines.push('- End with a low-pressure call to action.');
  lines.push('- Return the message body only. No subject line, no markdown, no sign-off placeholder.');
  if (input.reactivation) {
    lines.push('- This is a REACTIVATION. Use a new angle and fresh context. Do not repeat or paraphrase the prior messages.');
    lines.push('- Reference the new signal, not the old sequence.');
  }
  lines.push('');
  lines.push('STEP');
  lines.push(`- Step: ${input.stepName}`);
  if (input.goal) lines.push(`- Goal: ${input.goal}`);
  if (input.wordMax !== null) lines.push(`- Step word max: ${input.wordMax}`);
  if (input.ctaStyle) lines.push(`- CTA style: ${input.ctaStyle}`);
  if (input.tone) lines.push(`- Tone: ${input.tone}`);
  if (input.proofPolicy) lines.push(`- Proof policy: ${input.proofPolicy}`);
  if (input.allowedContext.length > 0) {
    lines.push(`- Allowed context: ${input.allowedContext.join(', ')}`);
  }
  lines.push('');
  lines.push('PROSPECT');
  lines.push(`- Name: (use only if natural)`);
  lines.push(`- Company: ${input.companyName}`);
  if (input.jobTitle) lines.push(`- Title: ${input.jobTitle}`);
  lines.push(`- ICP: ${input.icpName}`);
  lines.push(`- Personalization signal: ${input.personalizationSignal}`);
  lines.push('');
  lines.push('APPROVED CLAIMS (the only assertable facts)');
  if (input.approvedClaims.length === 0) {
    lines.push('- (none)');
  } else {
    for (const claim of input.approvedClaims) lines.push(`- ${claim}`);
  }
  lines.push('');
  lines.push('RETRIEVED ASSETS (approved, retrieval-eligible only)');
  if (input.retrievedAssets.length === 0) {
    lines.push('- (none)');
  } else {
    for (const asset of input.retrievedAssets) {
      const desc = asset.description ? ` — ${asset.description}` : '';
      lines.push(`- [${asset.type}] ${asset.title}${desc}`);
    }
  }
  if (input.priorMessages.length > 0) {
    lines.push('');
    lines.push('PRIOR OUTBOUND MESSAGES (context only; do NOT repeat)');
    for (const prior of input.priorMessages.slice(-3)) {
      lines.push(`---`);
      lines.push(prior);
    }
  }
  return lines.join('\n');
}

/* --------------------------------------------------- personalization ---- */

export interface PersonalizationCandidate {
  readonly kind: string;
  readonly text: string;
  readonly sourceUrl: string | null;
  readonly confidence: number;
  readonly observedAt: string;
}

export interface SignalCandidate {
  readonly kind: string;
  readonly polarity: 'positive' | 'negative' | 'neutral';
  readonly label: string;
  readonly strength: number;
  readonly observedAt: string;
  readonly detail: string | null;
}

/**
 * Pick the single strongest personalization signal.
 *
 * spec `messaging_rules.general`: "Prefer one strong personalization signal
 * instead of generic praise." Negative signals are never used as the
 * personalization hook.
 */
export function pickPersonalizationSignal(
  signals: readonly SignalCandidate[],
  at: Date,
): SignalCandidate | null {
  const usable = signals
    .filter((s) => s.polarity !== 'negative')
    .filter((s) => {
      const age = at.getTime() - new Date(s.observedAt).getTime();
      // Stale evidence is not a personalization hook.
      return age <= 180 * 86_400_000;
    })
    .sort((a, b) => {
      if (b.strength !== a.strength) return b.strength - a.strength;
      return new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime();
    });
  return usable[0] ?? null;
}

/** Sum configured scoring rules for a set of signals (spec `signals_and_scoring`). */
export function scoreSignals(
  signals: readonly SignalCandidate[],
  rules: readonly { signalKind: string; polarity: string; points: number; isActive: boolean }[],
): number {
  let total = 0;
  for (const signal of signals) {
    for (const rule of rules) {
      if (!rule.isActive) continue;
      if (rule.signalKind !== signal.kind) continue;
      if (rule.polarity !== signal.polarity) continue;
      total += rule.points;
    }
  }
  return total;
}
