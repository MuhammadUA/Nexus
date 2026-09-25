/**
 * Permissions and access scope.
 *
 * Spec `roles_and_permissions`, `identity_model`, `extension_visibility_rule`,
 * `admin_self_assignment_and_domains`.
 *
 * This is the single authorization vocabulary shared by the Next.js server, the
 * REST API and the Companion extension. It mirrors the RLS policy matrix in
 * `docs/DB_CONTRACT.md` §3 so a client-side check and the database check can never
 * disagree about *intent* — the database remains the enforcement point.
 */

import type { Role } from './vocabulary.js';

/* ------------------------------------------------------------- actor ---- */

export interface UserActor {
  readonly kind: 'user';
  readonly userId: string;
  readonly role: Role;
}

export interface ApiClientActor {
  readonly kind: 'api_client';
  readonly apiClientId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly businessIds: readonly string[];
}

export interface SystemActor {
  readonly kind: 'system';
  readonly name: string;
}

export type Actor = UserActor | ApiClientActor | SystemActor;

/** Scope strings accepted on `api_clients.scopes`. */
export const API_SCOPES = [
  'businesses:read',
  'context:read',
  'person:search',
  'company:search',
  'duplicate:check',
  'candidate:submit',
  'signal:create',
  'evidence:add',
  'lead:create',
  'lead:update',
  'lead:assign',
  'lead:read',
  'profile:capture',
  'reply:capture',
  'note:add',
  'task:create',
  'today:read',
  'research:submit',
  'message:draft',
  'agent_run:finish',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Scopes that mutate state — every one of these requires an audit event. */
export const WRITE_SCOPES: readonly ApiScope[] = [
  'candidate:submit',
  'signal:create',
  'evidence:add',
  'lead:create',
  'lead:update',
  'lead:assign',
  'profile:capture',
  'reply:capture',
  'note:add',
  'task:create',
  'research:submit',
  'message:draft',
  'agent_run:finish',
];

/* ------------------------------------------------------ permission keys - */

/**
 * Fine-grained permissions a user may hold inside a business. These map 1:1 to
 * the `user_business_access` columns so the UI and DB stay aligned.
 */
export const PERMISSIONS = [
  'business.view',
  'business.manage',
  'lead.view_all',
  'lead.view_assigned',
  'lead.view_own',
  'lead.create',
  'lead.update',
  'lead.assign_owner',
  'lead.change_primary_icp',
  'lead.change_sender_identity',
  'lead.archive',
  'lead.soft_delete',
  'lead.restore',
  'lead.permanent_delete',
  'lead.capture_reply',
  'lead.do_not_contact',
  'lead.snooze',
  'task.create',
  'task.complete',
  'note.create',
  'sequence.view',
  'sequence.pause_resume',
  'sequence.reactivate',
  'message.edit',
  'message.lock',
  'message.mark_sent',
  'lead_source.use',
  'profile_queue.use',
  'duplicate.review',
  'import.undo',
  'icp.manage',
  'sequence.manage',
  'knowledge.manage',
  'scoring.manage',
  'user.manage',
  'identity.manage',
  'identity.self_assign',
  'domain.manage',
  'integration.manage',
  'automation.manage',
  'audit.view',
  'insights.view',
  'settings.manage',
  'trash.view',
  'business.create',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** spec `roles_and_permissions.admin.can` — the admin set. */
export const ADMIN_PERMISSIONS: readonly Permission[] = PERMISSIONS;

/**
 * spec `roles_and_permissions.manager` — "Manage team leads within granted scope",
 * "Perform lead work"; "cannot_by_default: Create businesses, Edit global
 * integrations, Change another business outside granted access".
 */
export const MANAGER_PERMISSIONS: readonly Permission[] = [
  'business.view',
  'lead.view_all',
  'lead.create',
  'lead.update',
  'lead.assign_owner',
  'lead.change_primary_icp',
  'lead.change_sender_identity',
  'lead.archive',
  'lead.soft_delete',
  'lead.restore',
  'lead.capture_reply',
  'lead.snooze',
  'task.create',
  'task.complete',
  'note.create',
  'sequence.view',
  'sequence.pause_resume',
  'sequence.reactivate',
  'message.edit',
  'message.lock',
  'message.mark_sent',
  'lead_source.use',
  'profile_queue.use',
  'duplicate.review',
  'identity.self_assign',
  'insights.view',
  'trash.view',
];

/**
 * spec `roles_and_permissions.user.can`:
 *  "See only businesses explicitly granted by admin",
 *  "Use My Day, My Leads, Lead Detail, notes, reply capture, tasks, snooze, user
 *   Lead Sources and Profile Queue if permission enabled",
 *  "Soft-delete own/permitted leads and restore from Trash".
 * spec `.cannot`: no business/ICP/sequence/knowledge config, no permanent delete,
 *  no hidden businesses.
 */
export const USER_PERMISSIONS: readonly Permission[] = [
  'business.view',
  'lead.view_assigned',
  'lead.view_own',
  'lead.create',
  'lead.update',
  'lead.capture_reply',
  'lead.snooze',
  'lead.soft_delete',
  'lead.restore',
  'task.create',
  'task.complete',
  'note.create',
  'sequence.view',
  'message.edit',
  'message.lock',
  'message.mark_sent',
  'lead_source.use',
  'profile_queue.use',
  'duplicate.review',
  'trash.view',
];

export function defaultPermissionsForRole(role: Role): readonly Permission[] {
  switch (role) {
    case 'admin':
      return ADMIN_PERMISSIONS;
    case 'manager':
      return MANAGER_PERMISSIONS;
    case 'user':
      return USER_PERMISSIONS;
  }
}

/** Permissions that are never granted to a non-admin, whatever the overrides. */
export const ADMIN_ONLY_PERMISSIONS: readonly Permission[] = [
  'lead.permanent_delete',
  'user.manage',
  'integration.manage',
  'business.create',
  'settings.manage',
  'audit.view',
  'domain.manage',
];

/* --------------------------------------------------------- access model - */

export interface UserBusinessGrant {
  readonly businessId: string;
  /**
   * Per-business access level, matching the `user_business_access_level_check`
   * constraint in `0002_tenancy.sql` (`admin` | `manager` | `user`).
   *
   * The three capability booleans below are what actually drive
   * `effectivePermissions`; this field says *how much* access the grant confers, and
   * the level is a superset of the role (an `admin`-level grant on one business does
   * not make a `manager` an admin everywhere).
   */
  readonly accessLevel: 'admin' | 'manager' | 'user';
  readonly canManageLeads: boolean;
  readonly canUseLeadSources: boolean;
  readonly canUseProfileQueue: boolean;
  readonly canDeleteLeads: boolean;
  /** Extra permissions granted on top of the role default. */
  readonly extraPermissions?: readonly Permission[];
  /** Permissions removed from the role default for this business. */
  readonly revokedPermissions?: readonly Permission[];
  /** Lead scope mode for this business. */
  readonly leadScope?: 'all' | 'assigned' | 'own';
  /** Optional ICP restriction; empty/undefined means all ICPs. */
  readonly icpIds?: readonly string[];
}

export interface AccessContext {
  readonly actor: Actor;
  readonly grants: readonly UserBusinessGrant[];
}

/**
 * Effective permissions for a user inside one business.
 *
 * Role default -> grant overrides -> admin-only clamp. The clamp is last so a
 * mis-typed `extraPermissions` entry can never escalate a normal user.
 */
export function effectivePermissions(
  role: Role,
  grant: UserBusinessGrant | undefined,
  businessId: string,
): ReadonlySet<Permission> {
  if (grant === undefined || grant.businessId !== businessId) return new Set();
  const base = new Set<Permission>(defaultPermissionsForRole(role));
  for (const extra of grant.extraPermissions ?? []) base.add(extra);
  for (const revoked of grant.revokedPermissions ?? []) base.delete(revoked);
  if (role !== 'admin') {
    for (const adminOnly of ADMIN_ONLY_PERMISSIONS) base.delete(adminOnly);
  }
  return base;
}

export function hasPermission(
  actor: Actor,
  permissions: ReadonlySet<Permission>,
  permission: Permission,
): boolean {
  if (actor.kind === 'system') return true;
  if (actor.kind === 'api_client') return apiClientCan(actor, permission);
  return permissions.has(permission);
}

/**
 * Map a user Permission to the API scope that would be required for an equivalent
 * service-token action. Used by the gateway so an api_client can never perform a
 * user action it has no scope for.
 */
const PERMISSION_TO_SCOPE: Partial<Record<Permission, ApiScope>> = {
  'business.view': 'businesses:read',
  'lead.view_all': 'lead:read',
  'lead.view_assigned': 'lead:read',
  'lead.view_own': 'lead:read',
  'lead.create': 'lead:create',
  'lead.update': 'lead:update',
  'lead.assign_owner': 'lead:assign',
  'lead.change_primary_icp': 'lead:update',
  'lead.change_sender_identity': 'lead:update',
  'lead.capture_reply': 'reply:capture',
  'note.create': 'note:add',
  'task.create': 'task:create',
  'lead_source.use': 'candidate:submit',
  'profile_queue.use': 'profile:capture',
  'duplicate.review': 'duplicate:check',
};

export function scopeForPermission(permission: Permission): ApiScope | null {
  return PERMISSION_TO_SCOPE[permission] ?? null;
}

export function apiClientCan(actor: ApiClientActor, permission: Permission): boolean {
  const scope = scopeForPermission(permission);
  if (scope === null) return false;
  return actor.scopes.includes(scope);
}

/* ------------------------------------------------------- business scope - */

export function accessibleBusinessIds(actor: Actor, grants: readonly UserBusinessGrant[]): readonly string[] {
  if (actor.kind === 'system') return grants.map((g) => g.businessId);
  if (actor.kind === 'api_client') return actor.businessIds;
  return grants
    .filter((g) => g.businessId.length > 0)
    .map((g) => g.businessId);
}

export function canAccessBusiness(actor: Actor, grants: readonly UserBusinessGrant[], businessId: string): boolean {
  if (actor.kind === 'system') return true;
  if (actor.kind === 'api_client') return actor.businessIds.includes(businessId);
  if (actor.role === 'admin') return true;
  return grants.some((g) => g.businessId === businessId);
}

/* -------------------------------------------------- identity visibility - */

export interface OutreachIdentityLike {
  readonly id: string;
  readonly managedByUserId: string | null;
  readonly status: string;
  readonly businessIds: readonly string[];
}

/**
 * spec `roles_and_permissions.user.can`: "Use only LinkedIn identities assigned to
 * them".
 * spec `extension_visibility_rule`: visible businesses = user access INTERSECT
 * selected identity access.
 *
 * An identity is usable only when it is assigned to the actor *and* covers at
 * least one business the actor can reach: granting sender scope over a business
 * the user cannot see would contradict the intersection rule above.
 */
export function usableIdentities(
  actor: Actor,
  grants: readonly UserBusinessGrant[],
  identities: readonly OutreachIdentityLike[],
): readonly OutreachIdentityLike[] {
  if (actor.kind === 'system') return identities;
  if (actor.kind === 'api_client') {
    return identities.filter((i) => i.businessIds.some((b) => actor.businessIds.includes(b)));
  }
  if (actor.role === 'admin') return identities;
  const reachable = new Set(accessibleBusinessIds(actor, grants));
  return identities.filter(
    (i) =>
      i.managedByUserId === actor.userId &&
      i.status === 'active' &&
      i.businessIds.some((b) => reachable.has(b)),
  );
}

export function canUseIdentity(
  actor: Actor,
  grants: readonly UserBusinessGrant[],
  identities: readonly OutreachIdentityLike[],
  identityId: string,
): boolean {
  return usableIdentities(actor, grants, identities).some((i) => i.id === identityId);
}

/**
 * spec `extension_visibility_rule`:
 * "Visible businesses in Companion = user_business_access INTERSECT
 *  selected_outreach_identity.business_access."
 */
export function companionVisibleBusinessIds(
  actor: Actor,
  grants: readonly UserBusinessGrant[],
  identity: OutreachIdentityLike | null,
): readonly string[] {
  const userBusinesses = new Set(accessibleBusinessIds(actor, grants));
  if (identity === null) return [...userBusinesses];
  return identity.businessIds.filter((b) => userBusinesses.has(b));
}

/**
 * spec `roles_and_permissions.same_user_multiple_browsers`: "Concurrent use of the
 * same outreach identity in multiple active browser sessions should warn and can be
 * blocked by setting."
 */
export interface BrowserSessionLike {
  readonly id: string;
  readonly userId: string;
  readonly installId: string;
  readonly outreachIdentityId: string | null;
  readonly status: string;
  readonly lastActiveAt: string;
  /**
   * The holder's display name, when the caller resolved it.
   *
   * Carried on the session rather than returned separately so the conflict list is built from one
   * shape. It is optional: the policy works without it, and a caller that only has ids still gets a
   * usable conflict list.
   */
  readonly operatorName?: string | null;
}

export interface ConcurrencyDecision {
  readonly action: 'allow' | 'warn' | 'block';
  readonly reason: string;
  readonly conflictingSessionIds: readonly string[];
  /**
   * Who currently holds the identity, so the warning can name them.
   *
   * "This identity is active elsewhere" is not actionable on its own: the operator cannot tell
   * whether they left their own second browser open or somebody else is using the sender. The
   * warning shows the holder and when they were last active, and this is that information.
   */
  readonly conflicts: readonly BrowserConflict[];
  /** Whether this actor may take the identity over from the holder. */
  readonly canTransfer: boolean;
}

/** One live session holding the identity the operator is trying to bind. */
export interface BrowserConflict {
  readonly sessionId: string;
  readonly userId: string;
  readonly operatorName: string | null;
  readonly lastActiveAt: string;
  /** True when the holder is the operator themselves, in another browser profile. */
  readonly isSelf: boolean;
}

/**
 * A session is a live conflict only when it is active, belongs to another browser
 * install, and has heartbeated inside `staleAfterMinutes`. Sessions that went stale
 * (a profile closed without a clean shutdown) must not lock an identity out forever.
 *
 * Transfer permission is separate from conflict detection on purpose. The spec allows an
 * administrator to take an identity over and requires everyone else to be refused; expressing
 * that as "conflicts exist" plus "this actor may transfer" keeps the two questions apart, so a
 * blocked bind and a permitted transfer cannot be confused for one another.
 */
export function evaluateIdentityConcurrency(params: {
  requestedIdentityId: string;
  currentInstallId: string;
  sessions: readonly BrowserSessionLike[];
  blockConcurrentIdentityUse: boolean;
  staleAfterMinutes?: number;
  /** Clock injection point; defaults to now. */
  at?: Date;
  /** The acting user, so a conflict with their own other profile can be labelled. */
  actingUserId?: string;
  /** Whether the actor's role/permissions allow taking the identity over. */
  actorCanTransfer?: boolean;
}): ConcurrencyDecision {
  const staleMs = (params.staleAfterMinutes ?? 15) * 60_000;
  const now = (params.at ?? new Date()).getTime();
  const conflicts = params.sessions.filter(
    (s) =>
      s.outreachIdentityId === params.requestedIdentityId &&
      s.installId !== params.currentInstallId &&
      s.status === 'active' &&
      now - new Date(s.lastActiveAt).getTime() <= staleMs,
  );

  const canTransfer = params.actorCanTransfer === true;

  if (conflicts.length === 0) {
    return {
      action: 'allow',
      reason: 'no other active session uses this identity',
      conflictingSessionIds: [],
      conflicts: [],
      canTransfer,
    };
  }

  return {
    action: params.blockConcurrentIdentityUse ? 'block' : 'warn',
    reason: params.blockConcurrentIdentityUse
      ? 'this sender identity is already active in another browser profile and concurrent use is blocked by configuration'
      : 'this sender identity is also active in another browser profile',
    conflictingSessionIds: conflicts.map((s) => s.id),
    conflicts: conflicts.map((s) => ({
      sessionId: s.id,
      userId: s.userId,
      operatorName: s.operatorName ?? null,
      lastActiveAt: s.lastActiveAt,
      isSelf: params.actingUserId !== undefined && s.userId === params.actingUserId,
    })),
    canTransfer,
  };
}

/* -------------------------------------------- admin self-assignment ----- */

export interface IdentityAssignmentState {
  readonly identityId: string;
  readonly assignedUserId: string | null;
}

export interface SelfAssignDecision {
  readonly action: 'grant' | 'require_confirmation';
  readonly reason: string;
  readonly requiresAudit: boolean;
  readonly previousUserId: string | null;
}

/**
 * spec `admin_self_assignment_and_domains.admin_self_assignment`:
 * "Admin may self-assign an unassigned outreach identity. If identity is assigned
 * to someone else, require explicit transfer confirmation and audit event."
 */
export function decideSelfAssignIdentity(
  actor: UserActor,
  state: IdentityAssignmentState,
): SelfAssignDecision {
  if (actor.role !== 'admin') {
    return {
      action: 'require_confirmation',
      reason: 'only an admin may self-assign an outreach identity',
      requiresAudit: true,
      previousUserId: state.assignedUserId,
    };
  }
  if (state.assignedUserId === null || state.assignedUserId === actor.userId) {
    return {
      action: 'grant',
      reason: 'identity is unassigned or already assigned to this admin',
      requiresAudit: false,
      previousUserId: state.assignedUserId,
    };
  }
  return {
    action: 'require_confirmation',
    reason: 'identity is assigned to another user; explicit transfer confirmation and an audit event are required',
    requiresAudit: true,
    previousUserId: state.assignedUserId,
  };
}

/* ----------------------------------------------- lead scope filtering -- */

export interface LeadScopeFilter {
  readonly mode: 'all' | 'assigned' | 'own';
  readonly userId: string;
  readonly icpIds: readonly string[];
}

export function resolveLeadScope(actor: Actor, grant: UserBusinessGrant | undefined): LeadScopeFilter {
  if (actor.kind === 'api_client') {
    return { mode: 'all', userId: '', icpIds: [] };
  }
  if (actor.kind === 'system') {
    return { mode: 'all', userId: '', icpIds: [] };
  }
  if (actor.role === 'admin') {
    return { mode: 'all', userId: actor.userId, icpIds: grant?.icpIds ?? [] };
  }
  const mode = grant?.leadScope ?? (actor.role === 'manager' ? 'all' : 'assigned');
  return { mode, userId: actor.userId, icpIds: grant?.icpIds ?? [] };
}

export interface LeadScopeSubject {
  readonly ownerUserId: string | null;
  readonly primaryIcpId: string;
  readonly businessId: string;
}

export function leadVisibleUnderScope(subject: LeadScopeSubject, filter: LeadScopeFilter): boolean {
  if (filter.icpIds.length > 0 && !filter.icpIds.includes(subject.primaryIcpId)) return false;
  switch (filter.mode) {
    case 'all':
      return true;
    case 'assigned':
    case 'own':
      return subject.ownerUserId === filter.userId;
  }
}

/* -------------------------------------------------- DNC safety net ------ */

export interface SuppressionLike {
  readonly personId: string;
  readonly channel: string;
  readonly active: boolean;
}

/**
 * spec `sequence_engine.do_not_contact`: "Do not bypass via another account."
 * A person+channel suppression blocks every sender identity, so this check
 * deliberately ignores the identity argument.
 */
export function isSuppressed(
  personId: string,
  channel: string,
  suppressions: readonly SuppressionLike[],
): boolean {
  return suppressions.some((s) => s.personId === personId && s.active && s.channel === channel);
}

export interface OutreachEligibilityInput {
  readonly personId: string;
  readonly leadStatus: string;
  readonly channel: string;
  readonly suppressions: readonly SuppressionLike[];
  readonly activeCooldownUntil: string | null;
  readonly at: Date;
  readonly identityId: string | null;
}

export interface OutreachEligibility {
  readonly allowed: boolean;
  readonly blockedBy: 'suppression' | 'lead_state' | 'cooldown' | 'missing_identity' | null;
  readonly message: string;
}

/**
 * The single pre-send gate. Both the API and the extension call this before
 * allowing a message to be marked sent; the database enforces the same rules in
 * `block_dnc_message()`.
 */
export function outreachEligibility(input: OutreachEligibilityInput): OutreachEligibility {
  if (isSuppressed(input.personId, input.channel, input.suppressions)) {
    return {
      allowed: false,
      blockedBy: 'suppression',
      message:
        'This person has requested no contact. The suppression applies across every LinkedIn sender identity and cannot be bypassed.',
    };
  }
  if (input.leadStatus === 'do_not_contact' || input.leadStatus === 'wrong_person') {
    return {
      allowed: false,
      blockedBy: 'lead_state',
      message: `Lead is in state "${input.leadStatus}"; outreach is not permitted.`,
    };
  }
  if (input.activeCooldownUntil !== null && new Date(input.activeCooldownUntil).getTime() > input.at.getTime()) {
    return {
      allowed: false,
      blockedBy: 'cooldown',
      message: `This person is in a cooling period until ${input.activeCooldownUntil}.`,
    };
  }
  if (input.identityId === null) {
    return {
      allowed: false,
      blockedBy: 'missing_identity',
      message: 'A sender identity is required before this message can be marked sent.',
    };
  }
  return { allowed: true, blockedBy: null, message: 'ok' };
}

/* ------------------------------------------------------- role matrices - */

export interface RoutePermissionRequirement {
  readonly route: string;
  readonly surface: 'admin' | 'user' | 'extension';
  readonly permissions: readonly Permission[];
  readonly anyOf?: boolean;
}

/**
 * The route -> permission matrix. The Next.js middleware and the extension read
 * this exact table, and a test asserts every screen in the spec's
 * `screen_inventory` has an entry (acceptance criterion 1).
 */
export const ROUTE_PERMISSIONS: readonly RoutePermissionRequirement[] = [
  { route: '/login', surface: 'admin', permissions: [] },
  { route: '/b/:businessSlug/overview', surface: 'admin', permissions: ['insights.view'] },
  { route: '/b/:businessSlug/leads', surface: 'admin', permissions: ['lead.view_all'] },
  { route: '/b/:businessSlug/leads/:leadId', surface: 'admin', permissions: ['lead.view_all'] },
  { route: '/b/:businessSlug/lead-sources', surface: 'admin', permissions: ['lead_source.use'] },
  { route: '/b/:businessSlug/lead-sources/file', surface: 'admin', permissions: ['lead_source.use'] },
  { route: '/b/:businessSlug/lead-sources/paste', surface: 'admin', permissions: ['lead_source.use'] },
  { route: '/b/:businessSlug/lead-sources/google', surface: 'admin', permissions: ['lead_source.use'] },
  { route: '/b/:businessSlug/lead-sources/apollo', surface: 'admin', permissions: ['lead_source.use'] },
  { route: '/b/:businessSlug/profile-queue', surface: 'admin', permissions: ['profile_queue.use'] },
  { route: '/b/:businessSlug/duplicates', surface: 'admin', permissions: ['duplicate.review'] },
  { route: '/b/:businessSlug/trash', surface: 'admin', permissions: ['trash.view'] },
  { route: '/b/:businessSlug/reactivation', surface: 'admin', permissions: ['sequence.reactivate'] },
  { route: '/businesses', surface: 'admin', permissions: ['business.create'] },
  { route: '/businesses/new', surface: 'admin', permissions: ['business.create'] },
  { route: '/b/:businessSlug/setup/brain', surface: 'admin', permissions: ['knowledge.manage'] },
  { route: '/b/:businessSlug/setup/icps', surface: 'admin', permissions: ['icp.manage'] },
  { route: '/b/:businessSlug/setup/sequences', surface: 'admin', permissions: ['sequence.manage'] },
  { route: '/b/:businessSlug/setup/knowledge', surface: 'admin', permissions: ['knowledge.manage'] },
  { route: '/team', surface: 'admin', permissions: ['user.manage'] },
  { route: '/team/:userId/permissions', surface: 'admin', permissions: ['user.manage'] },
  { route: '/identities', surface: 'admin', permissions: ['identity.manage'] },
  { route: '/identities/:identityId', surface: 'admin', permissions: ['identity.manage'] },
  { route: '/integrations', surface: 'admin', permissions: ['integration.manage'] },
  { route: '/b/:businessSlug/automations', surface: 'admin', permissions: ['automation.manage'] },
  { route: '/b/:businessSlug/lead-sources/import', surface: 'admin', permissions: ['lead_source.use'] },
  { route: '/b/:businessSlug/insights/messaging', surface: 'admin', permissions: ['insights.view'] },
  { route: '/settings', surface: 'admin', permissions: ['settings.manage'] },
  { route: '/my-access', surface: 'admin', permissions: ['identity.self_assign'] },
  { route: '/business-domains', surface: 'admin', permissions: ['domain.manage'] },

  { route: '/my-day', surface: 'user', permissions: ['business.view'] },
  { route: '/my-day/upcoming', surface: 'user', permissions: ['business.view'] },
  { route: '/my-day/done', surface: 'user', permissions: ['business.view'] },
  { route: '/my-leads', surface: 'user', permissions: ['lead.view_assigned', 'lead.view_own'], anyOf: true },
  { route: '/my-leads/:leadId', surface: 'user', permissions: ['lead.view_assigned', 'lead.view_own'], anyOf: true },
  { route: '/my-leads/:leadId/edit', surface: 'user', permissions: ['lead.update'] },
  { route: '/my-leads/:leadId/task', surface: 'user', permissions: ['task.create'] },
  { route: '/my-leads/:leadId/snooze', surface: 'user', permissions: ['lead.snooze'] },
  { route: '/my-lead-sources', surface: 'user', permissions: ['lead_source.use'] },
  { route: '/my-lead-sources/file', surface: 'user', permissions: ['lead_source.use'] },
  { route: '/my-lead-sources/paste', surface: 'user', permissions: ['lead_source.use'] },
  { route: '/my-lead-sources/google', surface: 'user', permissions: ['lead_source.use'] },
  { route: '/my-lead-sources/apollo', surface: 'user', permissions: ['lead_source.use'] },
  { route: '/my-profile-queue', surface: 'user', permissions: ['profile_queue.use'] },
  { route: '/my-duplicates', surface: 'user', permissions: ['duplicate.review'] },
  { route: '/my-trash', surface: 'user', permissions: ['trash.view'] },

  { route: 'companion/login', surface: 'extension', permissions: [] },
  { route: 'companion/leads', surface: 'extension', permissions: ['lead.view_assigned', 'lead.view_own'], anyOf: true },
  { route: 'companion/today', surface: 'extension', permissions: ['business.view'] },
  { route: 'companion/search', surface: 'extension', permissions: ['lead.view_assigned', 'lead.view_own'], anyOf: true },
  { route: 'companion/add', surface: 'extension', permissions: ['lead.create'] },
  { route: 'companion/connection-focus', surface: 'extension', permissions: ['message.mark_sent'] },
  { route: 'companion/followup-focus', surface: 'extension', permissions: ['message.mark_sent'] },
  { route: 'companion/reply', surface: 'extension', permissions: ['lead.capture_reply'] },
  { route: 'companion/reactivation', surface: 'extension', permissions: ['sequence.reactivate'] },
];

export function routeRequirement(route: string): RoutePermissionRequirement | undefined {
  return ROUTE_PERMISSIONS.find((r) => r.route === route);
}

/** True when the actor satisfies a route requirement. */
export function satisfiesRoute(
  actor: Actor,
  permissions: ReadonlySet<Permission>,
  requirement: RoutePermissionRequirement,
): boolean {
  if (requirement.permissions.length === 0) return true;
  if (requirement.anyOf === true) {
    return requirement.permissions.some((p) => hasPermission(actor, permissions, p));
  }
  return requirement.permissions.every((p) => hasPermission(actor, permissions, p));
}

/* ------------------------------------------------------- admin nav ----- */

export interface NavItem {
  readonly label: string;
  readonly route: string;
  readonly permission: Permission | null;
}

/** Admin navigation, ordered by the spec's admin workflow. */
export const ADMIN_NAV: readonly { readonly group: string; readonly items: readonly NavItem[] }[] = [
  {
    group: 'Operate',
    items: [
      { label: 'Overview', route: '/b/:businessSlug/overview', permission: 'insights.view' },
      { label: 'Leads', route: '/b/:businessSlug/leads', permission: 'lead.view_all' },
      { label: 'Reactivation', route: '/b/:businessSlug/reactivation', permission: 'sequence.reactivate' },
      { label: 'Profile Queue', route: '/b/:businessSlug/profile-queue', permission: 'profile_queue.use' },
      { label: 'Duplicate Review', route: '/b/:businessSlug/duplicates', permission: 'duplicate.review' },
    ],
  },
  {
    group: 'Business setup',
    items: [
      { label: 'Businesses', route: '/businesses', permission: 'business.create' },
      { label: 'Business Brain', route: '/b/:businessSlug/setup/brain', permission: 'knowledge.manage' },
      { label: 'ICPs', route: '/b/:businessSlug/setup/icps', permission: 'icp.manage' },
      { label: 'Sequences', route: '/b/:businessSlug/setup/sequences', permission: 'sequence.manage' },
      { label: 'Knowledge', route: '/b/:businessSlug/setup/knowledge', permission: 'knowledge.manage' },
      { label: 'Business Domains', route: '/business-domains', permission: 'domain.manage' },
    ],
  },
  {
    group: 'Team & access',
    items: [
      { label: 'Team & Accounts', route: '/team', permission: 'user.manage' },
      { label: 'Outreach Identities', route: '/identities', permission: 'identity.manage' },
      { label: 'My Access & Assignment', route: '/my-access', permission: 'identity.self_assign' },
    ],
  },
  {
    group: 'Ingestion',
    items: [
      { label: 'Lead Sources', route: '/b/:businessSlug/lead-sources', permission: 'lead_source.use' },
      { label: 'Import Builder', route: '/b/:businessSlug/lead-sources/import', permission: 'lead_source.use' },
      { label: 'Trash', route: '/b/:businessSlug/trash', permission: 'trash.view' },
    ],
  },
  {
    group: 'Platform',
    items: [
      { label: 'Integrations Gateway', route: '/integrations', permission: 'integration.manage' },
      // Automations and insights are per-business: a mapping or a reply theme only
      // means something inside one business, so they carry the slug like the rest of
      // the operational surfaces. Entries without `:businessSlug` are global
      // (tokens, platform settings).
      { label: 'Automation Mapping', route: '/b/:businessSlug/automations', permission: 'automation.manage' },
      { label: 'Messaging Insights', route: '/b/:businessSlug/insights/messaging', permission: 'insights.view' },
      { label: 'Settings', route: '/settings', permission: 'settings.manage' },
    ],
  },
];

/** User navigation. spec: "Operators should work from My Day -> exact action". */
export const USER_NAV: readonly { readonly group: string; readonly items: readonly NavItem[] }[] = [
  {
    group: 'Work',
    items: [
      { label: 'My Day', route: '/my-day', permission: 'business.view' },
      { label: 'My Leads', route: '/my-leads', permission: 'lead.view_assigned' },
    ],
  },
  {
    group: 'Ingestion',
    items: [
      { label: 'Lead Sources', route: '/my-lead-sources', permission: 'lead_source.use' },
      { label: 'Profile Queue', route: '/my-profile-queue', permission: 'profile_queue.use' },
      { label: 'Duplicate Review', route: '/my-duplicates', permission: 'duplicate.review' },
      { label: 'Trash', route: '/my-trash', permission: 'trash.view' },
    ],
  },
];

export function visibleNavItems(
  actor: Actor,
  permissions: ReadonlySet<Permission>,
  nav: readonly { readonly group: string; readonly items: readonly NavItem[] }[],
): readonly { readonly group: string; readonly items: readonly NavItem[] }[] {
  return nav
    .map((section) => ({
      group: section.group,
      items: section.items.filter(
        (item) => item.permission === null || hasPermission(actor, permissions, item.permission),
      ),
    }))
    .filter((section) => section.items.length > 0);
}
