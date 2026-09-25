/**
 * Deduplication engine.
 *
 * Spec `lead_invariants`:
 *   - "Normalized LinkedIn URL is the strongest person dedupe key when available."
 *   - "Normalized company domain is the strongest company dedupe key when available."
 *   - "Fallback dedupe may use normalized name + company + title with confidence."
 *   - "Rediscovery creates a new Signal/SourceEvidence, not a duplicate Person/Company."
 *
 * Spec `lead_sources.duplicate_review`: merge | keep separate | skip.
 *
 * This module is pure: it takes an incoming candidate plus the set of existing
 * canonical records and returns a decision. The database enforces the same rules
 * as constraints so a caller that bypasses this module still cannot violate them.
 */

import {
  normalizeCompanyName,
  normalizeDomainKey,
  normalizeEmail,
  normalizeJobTitle,
  normalizeLinkedInUrl,
  normalizePersonName,
  type NormalizedLinkedIn,
} from './normalize.js';
import type { DuplicateMatchReason } from './vocabulary.js';

/* ------------------------------------------------------------ interfaces - */

/** Incoming, un-persisted identity candidate extracted from a lead source. */
export interface PersonCandidate {
  readonly fullName?: string | null;
  readonly headline?: string | null;
  readonly jobTitle?: string | null;
  readonly companyName?: string | null;
  readonly companyDomain?: string | null;
  readonly linkedinUrl?: string | null;
  readonly email?: string | null;
  readonly location?: string | null;
}

/** A canonical `people` row as seen by the matcher. */
export interface ExistingPerson {
  readonly id: string;
  readonly full_name: string;
  readonly normalized_name?: string | null;
  readonly linkedin_url?: string | null;
  readonly normalized_linkedin_url?: string | null;
  readonly primary_email?: string | null;
  readonly company_id?: string | null;
  readonly job_title?: string | null;
}

export interface ExistingCompany {
  readonly id: string;
  readonly name: string;
  readonly normalized_name?: string | null;
  readonly normalized_domain?: string | null;
}

/* ---------------------------------------------------------------- persons */

export type PersonMatchKind = 'exact' | 'strong' | 'weak' | 'none';

export interface PersonMatch {
  readonly kind: PersonMatchKind;
  readonly personId: string | null;
  readonly reason: DuplicateMatchReason | null;
  /** 0..1 — 1.0 means "same person, certain". */
  readonly confidence: number;
  /** Secondary candidates for the Duplicate Review screen. */
  readonly alternatives: readonly PersonMatchAlternative[];
  readonly normalized: NormalizedLinkedIn;
}

export interface PersonMatchAlternative {
  readonly personId: string;
  readonly confidence: number;
  readonly reason: DuplicateMatchReason;
}

/**
 * Match an incoming candidate against existing canonical people.
 *
 * Resolution ladder (spec-ordered):
 *   1. normalized LinkedIn URL            -> exact, confidence 1.0
 *   2. normalized email                   -> exact, confidence 0.98
 *   3. normalized name + company domain   -> strong, confidence 0.86
 *   4. normalized name + company name + job title -> weak, confidence 0.62
 *   5. normalized name only               -> weak, 0.34 (never auto-merge)
 */
export function matchPerson(
  candidate: PersonCandidate,
  existing: readonly ExistingPerson[],
  companies: readonly ExistingCompany[] = [],
): PersonMatch {
  const normalized = normalizeLinkedInUrl(candidate.linkedinUrl ?? null);
  const normalizedName = candidate.fullName ? normalizePersonName(candidate.fullName) : '';
  const normalizedEmail = normalizeEmail(candidate.email ?? null);
  const candidateDomain =
    normalizeDomainKey(candidate.companyDomain ?? null) ??
    normalizeDomainKey(candidate.companyName ?? null);
  const normalizedCompany = candidate.companyName ? normalizeCompanyName(candidate.companyName) : '';
  const normalizedTitle = candidate.jobTitle ? normalizeJobTitle(candidate.jobTitle) : '';

  // 1. LinkedIn URL — the strongest key. Only a parsed member slug is usable; a
  //    short link or an unparseable LinkedIn URL must not be treated as a key.
  if (normalized.canonicalUrl !== null && normalized.memberSlug !== null) {
    const hit = existing.find(
      (p) =>
        p.normalized_linkedin_url === normalized.canonicalUrl ||
        normalizeLinkedInUrl(p.linkedin_url ?? null).canonicalUrl === normalized.canonicalUrl,
    );
    if (hit) {
      return {
        kind: 'exact',
        personId: hit.id,
        reason: 'linkedin_url',
        confidence: 1,
        alternatives: [],
        normalized,
      };
    }
    // Having a unique LinkedIn URL that matches nobody means this is a new person;
    // do not fall through to fuzzy matching, which would risk merging two
    // genuinely different people who share a name.
    return {
      kind: 'none',
      personId: null,
      reason: null,
      confidence: 0,
      alternatives: collectNameAlternatives(existing, normalizedName),
      normalized,
    };
  }

  // 2. Email
  if (normalizedEmail !== null) {
    const hit = existing.find((p) => normalizeEmail(p.primary_email ?? null) === normalizedEmail);
    if (hit) {
      return {
        kind: 'exact',
        personId: hit.id,
        reason: 'email',
        confidence: 0.98,
        alternatives: [],
        normalized,
      };
    }
  }

  if (normalizedName.length === 0) {
    return { kind: 'none', personId: null, reason: null, confidence: 0, alternatives: [], normalized };
  }

  const nameMatches = existing.filter((p) => {
    const theirName = p.normalized_name ?? normalizePersonName(p.full_name);
    return theirName === normalizedName;
  });

  if (nameMatches.length === 0) {
    return { kind: 'none', personId: null, reason: null, confidence: 0, alternatives: [], normalized };
  }

  // 3. name + company domain
  if (candidateDomain !== null) {
    const domainHit = nameMatches.find((p) => {
      const company = companies.find((c) => c.id === p.company_id);
      const theirDomain = company?.normalized_domain ?? null;
      return theirDomain !== null && theirDomain === candidateDomain;
    });
    if (domainHit) {
      return {
        kind: 'strong',
        personId: domainHit.id,
        reason: 'company_domain',
        confidence: 0.86,
        alternatives: [],
        normalized,
      };
    }
  }

  // 4. name + company name + job title
  if (normalizedCompany.length > 0 && normalizedTitle.length > 0) {
    const tripleHit = nameMatches.find((p) => {
      const company = companies.find((c) => c.id === p.company_id);
      const theirCompany = company
        ? (company.normalized_name ?? normalizeCompanyName(company.name))
        : '';
      const theirTitle = normalizeJobTitle(p.job_title ?? '');
      return theirCompany === normalizedCompany && theirTitle === normalizedTitle;
    });
    if (tripleHit) {
      return {
        kind: 'weak',
        personId: tripleHit.id,
        reason: 'name_company_title',
        confidence: 0.62,
        alternatives: [],
        normalized,
      };
    }
  }

  // 5. name only — surfaced for Duplicate Review, never auto-merged.
  const alternatives: PersonMatchAlternative[] = nameMatches.map((p) => {
    let confidence = 0.34;
    const reason: DuplicateMatchReason = 'name_company_title';
    const company = companies.find((c) => c.id === p.company_id);
    const theirCompany = company ? (company.normalized_name ?? normalizeCompanyName(company.name)) : '';
    if (normalizedCompany.length > 0 && theirCompany === normalizedCompany) {
      confidence = 0.55;
    }
    return { personId: p.id, confidence, reason };
  });

  return {
    kind: 'weak',
    personId: alternatives[0]?.personId ?? null,
    reason: alternatives[0]?.reason ?? null,
    confidence: alternatives[0]?.confidence ?? 0,
    alternatives,
    normalized,
  };
}

function collectNameAlternatives(
  existing: readonly ExistingPerson[],
  normalizedName: string,
): readonly PersonMatchAlternative[] {
  if (normalizedName.length === 0) return [];
  return existing
    .filter((p) => (p.normalized_name ?? normalizePersonName(p.full_name)) === normalizedName)
    .map((p) => ({ personId: p.id, confidence: 0.3, reason: 'name_company_title' as const }));
}

/* -------------------------------------------------------------- companies */

export interface CompanyMatch {
  readonly companyId: string | null;
  readonly confidence: number;
  readonly reason: DuplicateMatchReason | null;
  readonly normalizedDomain: string | null;
}

/**
 * Match a company by domain first, then by normalized name.
 * spec: "Normalized company domain is the strongest company dedupe key".
 */
export function matchCompany(
  candidateName: string | null | undefined,
  candidateDomain: string | null | undefined,
  existing: readonly ExistingCompany[],
): CompanyMatch {
  const domain = normalizeDomainKey(candidateDomain ?? null) ?? normalizeDomainKey(candidateName ?? null);
  if (domain !== null) {
    const hit = existing.find(
      (c) =>
        c.normalized_domain === domain ||
        normalizeDomainKey(c.normalized_domain ?? null) === domain ||
        normalizeDomainKey(c.name) === domain,
    );
    if (hit) {
      return { companyId: hit.id, confidence: 1, reason: 'company_domain', normalizedDomain: domain };
    }
  }

  const name = candidateName ? normalizeCompanyName(candidateName) : '';
  if (name.length === 0) {
    return { companyId: null, confidence: 0, reason: null, normalizedDomain: domain };
  }

  const nameHit = existing.find((c) => (c.normalized_name ?? normalizeCompanyName(c.name)) === name);
  if (nameHit) {
    return { companyId: nameHit.id, confidence: 0.8, reason: 'name_company_title', normalizedDomain: domain };
  }

  return { companyId: null, confidence: 0, reason: null, normalizedDomain: domain };
}

/* --------------------------------------------------------------- decisions */

export type DedupeDecision =
  | { readonly action: 'create_person'; readonly confidence: number; readonly personId: null }
  | {
      readonly action: 'update_person';
      readonly confidence: number;
      readonly personId: string;
      readonly reason: DuplicateMatchReason | null;
    }
  | {
      readonly action: 'review';
      readonly confidence: number;
      readonly personId: string;
      readonly reason: DuplicateMatchReason | null;
      readonly alternatives: readonly PersonMatchAlternative[];
    };

/**
 * Decide what to do with an incoming person candidate.
 *
 * `autoMergeThreshold` defaults to 0.85, matching the ladder above: exact LinkedIn
 * URL, exact email and name+company-domain auto-merge; name-only never does.
 * A weak-but-existing hit is routed to Duplicate Review rather than silently
 * creating a second Person (spec `duplicate_review`), and never silently merges.
 */
export function decidePersonDedupe(
  match: PersonMatch,
  options: { autoMergeThreshold?: number } = {},
): DedupeDecision {
  const threshold = options.autoMergeThreshold ?? 0.85;
  if (match.kind === 'none' || match.personId === null) {
    return { action: 'create_person', confidence: match.confidence, personId: null };
  }
  if (match.confidence >= threshold) {
    return {
      action: 'update_person',
      confidence: match.confidence,
      personId: match.personId,
      reason: match.reason,
    };
  }
  return {
    action: 'review',
    confidence: match.confidence,
    personId: match.personId,
    reason: match.reason,
    alternatives: match.alternatives,
  };
}

/* ------------------------------------------------- lead-level dedupe ----- */

export interface ExistingLead {
  readonly id: string;
  readonly business_id: string;
  readonly person_id: string;
  readonly status: string;
  readonly deleted_at: string | null;
}

export type LeadDedupeOutcome =
  | { readonly outcome: 'reuse_lead'; readonly leadId: string }
  | { readonly outcome: 'create_lead' }
  | { readonly outcome: 'blocked_deleted_lead'; readonly leadId: string };

/**
 * spec `lead_invariants`: "Within the same business, a Person may have only one
 * active Lead record."
 *
 * A soft-deleted lead does not count as active, but it must be restored rather
 * than shadowed by a second row, so it is reported distinctly.
 */
export function resolveLeadForPerson(
  businessId: string,
  personId: string,
  existingLeads: readonly ExistingLead[],
): LeadDedupeOutcome {
  const inBusiness = existingLeads.filter(
    (l) => l.business_id === businessId && l.person_id === personId,
  );
  const active = inBusiness.find((l) => l.deleted_at === null && l.status !== 'deleted');
  if (active) return { outcome: 'reuse_lead', leadId: active.id };
  const softDeleted = inBusiness.find((l) => l.deleted_at !== null || l.status === 'deleted');
  if (softDeleted) return { outcome: 'blocked_deleted_lead', leadId: softDeleted.id };
  return { outcome: 'create_lead' };
}

/* -------------------------------------------------------- ICP matching --- */

export interface IcpCriterionFields {
  readonly company_types?: readonly string[] | null;
  readonly markets?: readonly string[] | null;
  readonly buyer_titles?: readonly string[] | null;
  readonly exclusions?: readonly string[] | null;
  readonly min_employees?: number | null;
  readonly max_employees?: number | null;
  readonly geographies?: readonly string[] | null;
}

export interface IcpLike {
  readonly id: string;
  readonly business_id: string;
  readonly name: string;
  readonly criteria: IcpCriterionFields | null;
  readonly is_default?: boolean;
}

export interface IcpMatchInput {
  readonly companyName?: string | null;
  readonly companyIndustry?: string | null;
  readonly companyEmployeeCount?: number | null;
  readonly jobTitle?: string | null;
  readonly geography?: string | null;
  readonly signalText?: string | null;
}

export interface IcpMatchResult {
  readonly icpId: string;
  readonly matchScore: number;
  readonly reason: string;
}

/**
 * Score a candidate against each ICP of a business.
 *
 * This produces a ranked list; the caller chooses the highest as Primary ICP.
 * spec `lead_invariants`: "A person may match multiple ICPs in the same business,
 * but secondary ICP matches must not create duplicate leads" — therefore this
 * returns every match and the caller records the rest as `lead_icp_matches` rows
 * with `is_primary = false`.
 */
export function matchIcps(
  input: IcpMatchInput,
  icps: readonly IcpLike[],
): readonly IcpMatchResult[] {
  const results: IcpMatchResult[] = [];
  const title = normalizeJobTitle(input.jobTitle ?? '');
  const industry = input.companyIndustry ? normalizeTextLoose(input.companyIndustry) : '';
  const haystack = normalizeTextLoose(
    [input.companyName, input.companyIndustry, input.jobTitle, input.signalText]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join(' '),
  );
  const geo = input.geography ? normalizeTextLoose(input.geography) : '';

  for (const icp of icps) {
    const criteria = icp.criteria ?? {};
    const reasons: string[] = [];
    let score = 0;
    let evaluated = 0;

    const exclusions = criteria.exclusions ?? [];
    if (exclusions.length > 0) {
      evaluated += 1;
      const hit = exclusions.find((e) => phraseIn(haystack, e));
      if (hit) {
        // An exclusion is decisive: the candidate does not match this ICP at all.
        continue;
      }
      reasons.push('no exclusions matched');
    }

    const companyTypes = criteria.company_types ?? [];
    if (companyTypes.length > 0) {
      evaluated += 1;
      const hit = companyTypes.find((c) => phraseIn(industry, c) || phraseIn(haystack, c));
      if (hit) {
        score += 30;
        reasons.push(`company type: ${hit}`);
      }
    }

    const buyerTitles = criteria.buyer_titles ?? [];
    if (buyerTitles.length > 0) {
      evaluated += 1;
      const hit = buyerTitles.find((t) => phraseIn(title, t));
      if (hit) {
        score += 30;
        reasons.push(`buyer title: ${hit}`);
      }
    }

    const markets = criteria.markets ?? [];
    if (markets.length > 0) {
      evaluated += 1;
      const hit = markets.find((m) => phraseIn(haystack, m));
      if (hit) {
        score += 20;
        reasons.push(`market: ${hit}`);
      }
    }

    const geographies = criteria.geographies ?? [];
    if (geographies.length > 0 && geo.length > 0) {
      evaluated += 1;
      const hit = geographies.find((g) => phraseIn(geo, g));
      if (hit) {
        score += 20;
        reasons.push(`geography: ${hit}`);
      }
    }

    if (
      typeof criteria.min_employees === 'number' ||
      typeof criteria.max_employees === 'number'
    ) {
      evaluated += 1;
      const size = input.companyEmployeeCount ?? null;
      if (size !== null) {
        const aboveMin = criteria.min_employees == null || size >= criteria.min_employees;
        const belowMax = criteria.max_employees == null || size <= criteria.max_employees;
        if (aboveMin && belowMax) {
          score += 20;
          reasons.push('company size in range');
        }
      }
    }

    // An ICP with no configured criteria is a catch-all; give it a floor score so
    // that Auto-match can still resolve when only a default ICP is configured.
    if (evaluated === 0) {
      results.push({
        icpId: icp.id,
        matchScore: icp.is_default === true ? 10 : 5,
        reason: 'ICP has no configured criteria (catch-all)',
      });
      continue;
    }

    if (score > 0) {
      results.push({ icpId: icp.id, matchScore: score, reason: reasons.join('; ') });
    }
  }

  return results.sort((a, b) => b.matchScore - a.matchScore || a.icpId.localeCompare(b.icpId));
}

function normalizeTextLoose(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function phraseIn(haystack: string, needle: string): boolean {
  const n = normalizeTextLoose(needle);
  if (n.length === 0) return false;
  if (haystack.includes(n)) return true;
  // Token-subset match so "video production" matches "video production company".
  const tokens = n.split(' ').filter((t) => t.length > 2);
  if (tokens.length === 0) return false;
  return tokens.every((t) => haystack.includes(t));
}

/**
 * Auto-match contract shared by every ingestion path
 * (spec: "required_context_each_ingestion: Business, Primary ICP OR Auto-match").
 */
export type IcpSelection =
  | { readonly mode: 'primary'; readonly icpId: string }
  | { readonly mode: 'auto_match'; readonly icpId: null };

export interface IcpAssignment {
  readonly primaryIcpId: string;
  readonly secondaryIcpIds: readonly string[];
  readonly reason: string;
  readonly needsReview: boolean;
}

/**
 * Resolve the ICP assignment for a lead, enforcing "exactly one Primary ICP".
 * When `auto_match` is requested and nothing scores, the default ICP of the
 * business is used and the lead is flagged for review rather than being created
 * with no ICP.
 */
export function assignPrimaryIcp(
  selection: IcpSelection,
  input: IcpMatchInput,
  icps: readonly IcpLike[],
): IcpAssignment | { readonly error: 'no_icp_available' } {
  if (selection.mode === 'primary') {
    const chosen = icps.find((i) => i.id === selection.icpId);
    if (!chosen) return { error: 'no_icp_available' };
    const others = matchIcps(input, icps).filter((m) => m.icpId !== chosen.id);
    return {
      primaryIcpId: chosen.id,
      secondaryIcpIds: others.map((o) => o.icpId),
      reason: 'explicitly selected as Primary ICP',
      needsReview: false,
    };
  }

  const scored = matchIcps(input, icps);
  const best = scored[0];
  if (best) {
    return {
      primaryIcpId: best.icpId,
      secondaryIcpIds: scored.slice(1).map((s) => s.icpId),
      reason: `auto-matched: ${best.reason}`,
      needsReview: best.matchScore < 20,
    };
  }

  const fallback = icps.find((i) => i.is_default === true) ?? icps[0];
  if (!fallback) return { error: 'no_icp_available' };
  return {
    primaryIcpId: fallback.id,
    secondaryIcpIds: [],
    reason: 'auto-match found no criteria hit; fell back to default ICP',
    needsReview: true,
  };
}
