/**
 * Identity concurrency policy.
 *
 * spec `roles_and_permissions.same_user_multiple_browsers`: concurrent use of one outreach
 * identity in several browser profiles "should warn and can be blocked by setting". The rules
 * encoded here decide two things the product must not get wrong:
 *
 *   * a stale session — a profile closed without a clean shutdown — must never hold an identity
 *     hostage, so the comparison is against a heartbeat window rather than mere existence;
 *   * who currently holds the identity has to come back with the conflict, and taking it over has
 *     to be a separate permission, because "warn" is only actionable if the operator can see that
 *     it is their own other browser rather than a colleague's.
 */
import { describe, expect, it } from 'vitest';

import { evaluateIdentityConcurrency } from './permissions.js';

const IDENTITY = 'identity-1';
const ME = 'user-me';
const THEM = 'user-them';

function session(
  overrides: Partial<Parameters<typeof evaluateIdentityConcurrency>[0]['sessions'][number]> = {},
) {
  return {
    id: 'session-1',
    userId: ME,
    installId: 'install-other',
    outreachIdentityId: IDENTITY,
    status: 'active',
    lastActiveAt: new Date('2026-09-25T10:00:00Z').toISOString(),
    ...overrides,
  };
}

const AT = new Date('2026-09-25T10:05:00Z');

describe('identity concurrency', () => {
  it('allows a bind when no other live session holds the identity', () => {
    const decision = evaluateIdentityConcurrency({
      requestedIdentityId: IDENTITY,
      currentInstallId: 'install-mine',
      sessions: [session({ installId: 'install-mine' })],
      blockConcurrentIdentityUse: false,
      at: AT,
    });
    expect(decision.action).toBe('allow');
    expect(decision.conflicts).toHaveLength(0);
  });

  it('warns and names the holder when another profile holds it', () => {
    const decision = evaluateIdentityConcurrency({
      requestedIdentityId: IDENTITY,
      currentInstallId: 'install-mine',
      sessions: [session({ userId: THEM, operatorName: 'Osama Sender' })],
      blockConcurrentIdentityUse: false,
      at: AT,
      actingUserId: ME,
    });

    expect(decision.action).toBe('warn');
    expect(decision.conflicts).toHaveLength(1);
    expect(decision.conflicts[0]?.operatorName).toBe('Osama Sender');
    expect(decision.conflicts[0]?.isSelf).toBe(false);
  });

  it('marks a conflict with the same user\u2019s other profile as self', () => {
    const decision = evaluateIdentityConcurrency({
      requestedIdentityId: IDENTITY,
      currentInstallId: 'install-mine',
      sessions: [session({ userId: ME })],
      blockConcurrentIdentityUse: false,
      at: AT,
      actingUserId: ME,
    });
    expect(decision.conflicts[0]?.isSelf).toBe(true);
  });

  it('does not treat a stale session as a conflict', () => {
    const decision = evaluateIdentityConcurrency({
      requestedIdentityId: IDENTITY,
      currentInstallId: 'install-mine',
      // 20 minutes before the clock: outside the default 15-minute window.
      sessions: [session({ lastActiveAt: new Date('2026-09-25T09:45:00Z').toISOString() })],
      blockConcurrentIdentityUse: false,
      at: AT,
    });
    expect(decision.action).toBe('allow');
  });

  it('honours an explicit staleness window', () => {
    const decision = evaluateIdentityConcurrency({
      requestedIdentityId: IDENTITY,
      currentInstallId: 'install-mine',
      sessions: [session({ lastActiveAt: new Date('2026-09-25T09:45:00Z').toISOString() })],
      blockConcurrentIdentityUse: false,
      staleAfterMinutes: 60,
      at: AT,
    });
    expect(decision.action).toBe('warn');
  });

  it('blocks rather than warns when configuration says so', () => {
    const decision = evaluateIdentityConcurrency({
      requestedIdentityId: IDENTITY,
      currentInstallId: 'install-mine',
      sessions: [session()],
      blockConcurrentIdentityUse: true,
      at: AT,
    });
    expect(decision.action).toBe('block');
  });

  it('carries transfer permission independently of the conflict', () => {
    const allowed = evaluateIdentityConcurrency({
      requestedIdentityId: IDENTITY,
      currentInstallId: 'install-mine',
      sessions: [session()],
      blockConcurrentIdentityUse: false,
      at: AT,
      actorCanTransfer: true,
    });
    const refused = evaluateIdentityConcurrency({
      requestedIdentityId: IDENTITY,
      currentInstallId: 'install-mine',
      sessions: [session()],
      blockConcurrentIdentityUse: false,
      at: AT,
      actorCanTransfer: false,
    });

    expect(allowed.canTransfer).toBe(true);
    expect(refused.canTransfer).toBe(false);
    // Both still report the conflict: the panel has to show the warning either way, and disable
    // only the transfer button.
    expect(allowed.action).toBe('warn');
    expect(refused.action).toBe('warn');
  });
});
