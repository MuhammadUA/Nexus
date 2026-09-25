/**
 * Browser-session concurrency for one outreach identity.
 *
 * spec `roles_and_permissions.same_user_multiple_browsers`: "Concurrent use of the
 * same outreach identity in multiple active browser sessions should warn and can be
 * blocked by setting."
 *
 * This module is deliberately free of `server-only` and of any database import: the
 * A17 screen renders the warning inside a client component, so the rule has to be
 * shareable. The decision itself is not re-implemented here — it is
 * `evaluateIdentityConcurrency` from `@nexus/core`, which is also what the
 * Companion calls before binding an identity.
 */
import { evaluateIdentityConcurrency, type ConcurrencyDecision } from '@nexus/core';

/**
 * A browser profile that has not heartbeated inside this window is no longer
 * "concurrent": a profile closed without a clean shutdown must not keep warning
 * about — or blocking — an identity forever.
 */
export const STALE_SESSION_MINUTES = 15;

/** The subset of a `browser_sessions` row this rule needs. */
export interface ConcurrencySession {
  readonly id: string;
  readonly userId: string;
  readonly installId: string;
  readonly status: string;
  readonly lastActiveAt: string | null;
}

/**
 * Evaluates the spec's rule across every session bound to one identity.
 *
 * `evaluateIdentityConcurrency` compares *other* installs against one "current"
 * install, so each session is evaluated in turn as if it were the current one. A
 * conflict reported for any of them means two browser profiles are genuinely
 * sharing the identity.
 *
 * Freshness is measured from the newest heartbeat in the set: the core function is
 * pure and takes its clock as an argument, and the database's `now()` is not
 * available to it. Using the newest heartbeat is the conservative choice — it is
 * exactly the moment a newly opened conflicting profile would be noticed.
 */
export function evaluateSessionConflict(
  sessions: readonly ConcurrencySession[],
  options: {
    readonly blockConcurrentIdentityUse: boolean;
    readonly staleAfterMinutes?: number;
    /** Clock injection point; defaults to the newest heartbeat, else now. */
    readonly at?: Date;
    /** The signed-in operator, so a conflict with their own other profile is labelled. */
    readonly actingUserId?: string;
    /** Whether this operator may take the identity over from its holder. */
    readonly actorCanTransfer?: boolean;
  },
): ConcurrencyDecision {
  const staleAfterMinutes = options.staleAfterMinutes ?? STALE_SESSION_MINUTES;
  const active = sessions.filter((session) => session.status === 'active');
  const canTransfer = options.actorCanTransfer === true;
  if (active.length <= 1) {
    return {
      action: 'allow',
      reason: 'no other active session uses this identity',
      conflictingSessionIds: [],
      conflicts: [],
      canTransfer,
    };
  }

  const at = options.at ?? newestHeartbeat(active);
  const decisions = active.map((session) =>
    evaluateIdentityConcurrency({
      // One identity is under test, so every session shares this id; the function
      // compares installs, not identities.
      requestedIdentityId: 'identity-under-test',
      currentInstallId: session.installId,
      sessions: active.map((other) => ({
        id: other.id,
        userId: other.userId,
        installId: other.installId,
        outreachIdentityId: 'identity-under-test',
        status: other.status,
        lastActiveAt: other.lastActiveAt ?? at.toISOString(),
      })),
      blockConcurrentIdentityUse: options.blockConcurrentIdentityUse,
      staleAfterMinutes,
      at,
      actingUserId: options.actingUserId,
      actorCanTransfer: options.actorCanTransfer,
    }),
  );

  const conflictingSessionIds = [
    ...new Set(decisions.flatMap((decision) => decision.conflictingSessionIds)),
  ];
  if (conflictingSessionIds.length === 0) {
    return {
      action: 'allow',
      reason: 'no other active session uses this identity',
      conflictingSessionIds: [],
      conflicts: [],
      canTransfer,
    };
  }

  // The holders of the identity, deduplicated: the same session is reported by each of its peers.
  const conflicts = [
    ...new Map(
      decisions.flatMap((decision) => decision.conflicts).map((conflict) => [conflict.sessionId, conflict]),
    ).values(),
  ];

  return {
    action: options.blockConcurrentIdentityUse ? 'block' : 'warn',
    reason: options.blockConcurrentIdentityUse
      ? 'this sender identity is active in another browser profile and concurrent use is blocked by configuration'
      : 'this sender identity is also active in another browser profile',
    conflictingSessionIds,
    conflicts,
    canTransfer,
  };
}

/** The most recent heartbeat in the set, or now when none carries a timestamp. */
export function newestHeartbeat(sessions: readonly ConcurrencySession[]): Date {
  let newest = 0;
  for (const session of sessions) {
    if (session.lastActiveAt === null) continue;
    const parsed = new Date(session.lastActiveAt).getTime();
    if (Number.isFinite(parsed) && parsed > newest) newest = parsed;
  }
  return newest === 0 ? new Date() : new Date(newest);
}
