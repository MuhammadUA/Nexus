/**
 * The identity-concurrency decision, shared by `/companion/bind` and `/companion/bootstrap`.
 *
 * Both routes have to answer the same question — "is this sender identity already held by another
 * live browser profile, and may this operator take it over?" — and they must answer it the same
 * way. Binding decides whether to refuse; bootstrap decides what to display on open. Deriving both
 * from one function is what stops the panel warning about a conflict the bind would have allowed,
 * or the reverse.
 */
import 'server-only';

import { evaluateIdentityConcurrency, type ConcurrencyDecision } from '@nexus/core';

import type { Actor } from '@/lib/actor';
import { blockConcurrentIdentityUse, conflictingSessions, viewerCanTransferIdentity } from '@/lib/repo/companion';
import type { Viewer } from '@/lib/actor';

export interface IdentityConcurrencyAnswer {
  readonly decision: ConcurrencyDecision;
  /** Whether concurrent use is blocked by platform configuration rather than merely warned. */
  readonly blocked: boolean;
  readonly canTransfer: boolean;
}

export async function identityConcurrencyFor(params: {
  readonly actor: Actor;
  readonly viewer: Viewer;
  readonly identityId: string;
  readonly installId: string;
  readonly businessId: string | null;
}): Promise<IdentityConcurrencyAnswer> {
  const [conflicts, blocked, canTransfer] = await Promise.all([
    conflictingSessions(params.actor, params.identityId, params.installId),
    blockConcurrentIdentityUse(params.actor, params.businessId),
    viewerCanTransferIdentity(params.viewer),
  ]);

  const decision = evaluateIdentityConcurrency({
    requestedIdentityId: params.identityId,
    currentInstallId: params.installId,
    // The repository has already narrowed this to *other* live installs, so every row here is a
    // conflict; the install id is a placeholder for the comparison the core function performs.
    sessions: conflicts.map((conflict) => ({
      id: conflict.sessionId,
      userId: conflict.userId,
      installId: 'other-install',
      outreachIdentityId: params.identityId,
      status: 'active',
      lastActiveAt: conflict.lastActiveAt,
      operatorName: conflict.operatorName,
    })),
    blockConcurrentIdentityUse: blocked,
    actingUserId: params.viewer.userId ?? undefined,
    actorCanTransfer: canTransfer,
  });

  return { decision, blocked, canTransfer };
}

/** The concurrency block as the panel consumes it. */
export function concurrencyPayload(answer: IdentityConcurrencyAnswer): Record<string, unknown> {
  return {
    action: answer.decision.action,
    reason: answer.decision.reason,
    canTransfer: answer.canTransfer,
    blocked: answer.blocked,
    conflicts: answer.decision.conflicts.map((conflict) => ({
      sessionId: conflict.sessionId,
      operatorName: conflict.operatorName,
      lastActiveAt: conflict.lastActiveAt,
      isSelf: conflict.isSelf,
    })),
  };
}
