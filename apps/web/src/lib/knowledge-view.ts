/**
 * Client-safe knowledge shapes, approval pipeline and claim-policy helpers (A14).
 *
 * `lib/repo/*` is server-only, so anything a client component needs lives here.
 * spec `business_brain_and_knowledge.claim_policy`: "Outbound may use only approved
 * factual claims. Never invent metrics/results." — which is why retrieval eligibility
 * is exactly `ai_use_allowed and approval_state = 'approved'`, the same predicate
 * `selectRelevantAssets` applies in `@nexus/core`.
 */
import type { ApprovalState } from '@nexus/core';

export interface KnowledgeAsset {
  readonly id: string;
  readonly businessId: string;
  readonly type: string;
  readonly url: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly aiUseAllowed: boolean;
  readonly mayMentionClientName: boolean;
  readonly mayMentionNumericResults: boolean;
  readonly approvalState: ApprovalState;
  readonly currentVersionId: string | null;
  readonly versionCount: number;
  readonly extractionCount: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface AssetTagWeight {
  readonly assetId: string;
  readonly tag: string;
  readonly weight: number;
}

/**
 * Allowed approval transitions.
 *
 * Derived from spec `business_brain_and_knowledge.ingestion`, which fixes the order of
 * the pipeline (extraction -> analysis -> review -> approve -> retrieval). Every state
 * can be pulled back to `draft` so a human can correct it, and `superseded` is the
 * forward-only state for a replaced asset.
 */
export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalState, readonly ApprovalState[]>> = {
  draft: ['extracting', 'needs_review', 'approved', 'rejected', 'superseded'],
  extracting: ['needs_review', 'draft', 'rejected'],
  needs_review: ['approved', 'rejected', 'draft'],
  approved: ['superseded', 'needs_review', 'rejected'],
  rejected: ['draft', 'needs_review'],
  superseded: ['draft'],
};

export function nextApprovalStates(state: ApprovalState): readonly ApprovalState[] {
  return APPROVAL_TRANSITIONS[state];
}

/** spec `business_brain_and_knowledge.claim_policy` + `retrieval`. */
export function isRetrievalEligible(asset: {
  readonly aiUseAllowed: boolean;
  readonly approvalState: ApprovalState;
}): boolean {
  return asset.aiUseAllowed && asset.approvalState === 'approved';
}
