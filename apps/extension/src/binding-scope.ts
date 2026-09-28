/**
 * Companion binding scope — the pure selection logic behind the two selectors.
 *
 * spec §36 / §61: the business selector offers **only** the businesses the selected
 * channel account (outreach identity) may send from, switching the account
 * recalculates the list and clears a selection that is no longer valid, and the Bind
 * control is disabled with a *specific* explanation when nothing is eligible — never
 * a generic permission message.
 *
 * The rule itself lives on the server (`public.companion_visible_business_ids`), and
 * the server refuses an ineligible pair whether or not the panel is bypassed. What
 * lives here is only the rendering decision: the panel receives, per identity, the
 * businesses the actor may actually bind, and this module turns that into the state
 * the selectors render. Keeping it pure is what makes the recalculation testable
 * without a browser.
 *
 * No React, no chrome, no I/O: the same module is exercised by the web test suite.
 */

/** Why a pair is or is not bindable, as the panel needs to explain it. */
export type CompanionScopeReason =
  | 'ok'
  | 'no_identity'
  | 'no_account_access'
  | 'no_user_grant'
  | 'identity_not_usable';

export interface ScopeBusiness {
  readonly id: string;
  readonly name: string;
}

export interface ScopeIdentity {
  readonly id: string;
  readonly displayName: string;
  /** Business ids the server says this account may be bound to for this actor. */
  readonly businessIds: readonly string[];
  /** Optional: the server omits retired accounts from the selector entirely. */
  readonly status?: string;
}

/**
 * The businesses valid for one channel account.
 *
 * An unknown identity yields nothing rather than everything: a selector that falls
 * back to "all businesses" when it does not recognise the account is exactly the
 * defect this replaces.
 */
export function eligibleBusinesses<B extends ScopeBusiness>(
  businesses: readonly B[],
  identity: ScopeIdentity | null | undefined,
): readonly B[] {
  if (identity === null || identity === undefined) return [];
  const allowed = new Set(identity.businessIds);
  return businesses.filter((business) => allowed.has(business.id));
}

/**
 * The explanation shown when nothing can be bound.
 *
 * Each sentence names the specific obstacle and the next step. None of them reveals
 * whether a particular business exists: they describe the account and the caller's own
 * access, both of which the operator is already entitled to see.
 */
export function scopeMessage(reason: CompanionScopeReason): string {
  switch (reason) {
    case 'ok':
      return '';
    case 'no_identity':
      return 'No channel account is assigned to you yet, so this browser profile cannot be bound. Ask an administrator to assign one.';
    case 'identity_not_usable':
      return 'This channel account cannot be used. Choose another account, or ask an administrator to assign it.';
    case 'no_user_grant':
      return 'You do not have access to any business this channel account sends from. Ask an administrator to grant it to you.';
    case 'no_account_access':
    default:
      return 'This channel account is not assigned to any business yet, so there is nothing to bind it to. Ask an administrator to assign it to a business.';
  }
}

export interface CompanionScopeInput {
  /** Every business the actor can reach, as the bootstrap payload lists them. */
  readonly businesses: readonly ScopeBusiness[];
  readonly identities: readonly ScopeIdentity[];
  readonly identityId: string;
  /** The current selection; replaced when it is not eligible for the account. */
  readonly businessId: string;
  /** Preferred replacement (the stored binding) when the current selection is invalid. */
  readonly preferredBusinessId?: string | null;
}

export interface CompanionScopeState {
  readonly eligible: readonly ScopeBusiness[];
  /** The selection after recalculation: '' when nothing is eligible. */
  readonly businessId: string;
  readonly identityId: string;
  readonly canBind: boolean;
  readonly reason: CompanionScopeReason;
  /** Specific, operator-facing explanation. Empty when bindable. */
  readonly message: string;
}

/**
 * Recalculates the business selection for the chosen channel account.
 *
 * Order matters: the identity is resolved first, then its business scope, and only
 * then the selection. That is what makes switching accounts deterministic — the
 * previous business is kept when it is still valid, replaced by the stored binding
 * when that is valid, and otherwise replaced by the first eligible business or
 * cleared.
 */
export function companionScope(input: CompanionScopeInput): CompanionScopeState {
  const identity =
    input.identityId.length === 0
      ? undefined
      : input.identities.find((candidate) => candidate.id === input.identityId);

  if (identity === undefined) {
    return {
      eligible: [],
      businessId: '',
      identityId: '',
      canBind: false,
      reason: 'no_identity',
      message: scopeMessage('no_identity'),
    };
  }

  if (identity.status !== undefined && identity.status !== 'active') {
    return {
      eligible: [],
      businessId: '',
      identityId: identity.id,
      canBind: false,
      reason: 'identity_not_usable',
      message: scopeMessage('identity_not_usable'),
    };
  }

  const eligible = eligibleBusinesses(input.businesses, identity);

  if (eligible.length === 0) {
    // Two different obstacles, and the operator can act on only one of them: the
    // account is not assigned anywhere (an administrator must assign it), or it is
    // assigned but the caller holds no grant (an administrator must grant it).
    const reason: CompanionScopeReason =
      identity.businessIds.length === 0 ? 'no_account_access' : 'no_user_grant';
    return {
      eligible: [],
      businessId: '',
      identityId: identity.id,
      canBind: false,
      reason,
      message: scopeMessage(reason),
    };
  }

  const preferred = input.preferredBusinessId ?? '';
  const selected = eligible.some((business) => business.id === input.businessId)
    ? input.businessId
    : eligible.some((business) => business.id === preferred)
      ? preferred
      : (eligible[0]?.id ?? '');

  return {
    eligible,
    businessId: selected,
    identityId: identity.id,
    canBind: selected.length > 0,
    reason: 'ok',
    message: '',
  };
}

/**
 * The businesses a *read-only* selector may offer for the bound account.
 *
 * The shell's business selector feeds the Leads/Today queries, so it is scoped the
 * same way. One exception, deliberately: when the bound account is not in the
 * identity list at all (it was archived, or the binding predates the account) there
 * is no scope to apply, and hiding every business would take the whole panel down for
 * an operator whose data is still theirs to read. The list is then the businesses the
 * actor can reach, and the caller surfaces a notice instead.
 */
export function shellBusinesses<B extends ScopeBusiness>(
  businesses: readonly B[],
  identities: readonly ScopeIdentity[],
  identityId: string,
): readonly B[] {
  const identity = identities.find((candidate) => candidate.id === identityId);
  if (identity === undefined) return businesses;
  return eligibleBusinesses(businesses, identity);
}
