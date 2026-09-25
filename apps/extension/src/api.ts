/**
 * Typed client for the limited Companion API.
 *
 * Two properties matter here:
 *
 *  1. **The session token lives only in `chrome.storage.session`**, which is
 *     in-memory and never written to disk, and it is attached here — not stored in
 *     page context. Nothing in this bundle holds a database credential; the
 *     extension authenticates as the signed-in user and the server applies RLS
 *     exactly as it does for the web app.
 *  2. **Every response is treated as untrusted input.** Scraped LinkedIn content and
 *     server payloads are data, never instructions, and the caller always receives a
 *     discriminated result instead of a thrown exception it might ignore.
 */
import { API_BASE, STORAGE_KEYS } from './config';
import type {
  ApiResult,
  BrowserBinding,
  CompanionBusiness,
  CompanionIcp,
  CompanionIdentity,
  CompanionLead,
  CompanionLeadDetail,
  CompanionSession,
  CompanionTodayItem,
  SearchResult,
} from './types';

export async function getToken(): Promise<string | null> {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.token);
  const token: unknown = stored[STORAGE_KEYS.token];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export async function setToken(token: string | null): Promise<void> {
  if (token === null) {
    await chrome.storage.session.remove(STORAGE_KEYS.token);
    return;
  }
  await chrome.storage.session.set({ [STORAGE_KEYS.token]: token });
}

export async function getBinding(): Promise<BrowserBinding | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.binding);
  const binding: unknown = stored[STORAGE_KEYS.binding];
  if (typeof binding !== 'object' || binding === null) return null;
  const candidate = binding as Partial<BrowserBinding>;
  if (typeof candidate.identityId !== 'string' || typeof candidate.installId !== 'string') return null;
  return {
    installId: candidate.installId,
    identityId: candidate.identityId,
    defaultBusinessId: typeof candidate.defaultBusinessId === 'string' ? candidate.defaultBusinessId : null,
    boundAt: typeof candidate.boundAt === 'string' ? candidate.boundAt : new Date().toISOString(),
  };
}

export async function setBinding(binding: BrowserBinding | null): Promise<void> {
  if (binding === null) {
    await chrome.storage.local.remove(STORAGE_KEYS.binding);
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.binding]: binding });
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; authenticated?: boolean } = {},
): Promise<ApiResult<T>> {
  // The session exchange is the one call that must work *before* a token exists — it is what
  // produces the token. Routing it through the guard below made signing in impossible: the
  // panel reported "Sign in to Nexus Companion" without ever reaching the server, so a fresh
  // install could never be signed in at all.
  const authenticated = init.authenticated ?? true;
  const token = authenticated ? await getToken() : null;
  if (authenticated && token === null) return { ok: false, error: 'Sign in to Nexus Companion.', status: 401 };

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    // A network failure is the common case when the API origin is unreachable;
    // report it as an error rather than letting an exception escape the UI.
    return { ok: false, error: 'Nexus is unreachable. Check the API origin and your connection.', status: 0 };
  }

  if (response.status === 401 && authenticated) {
    await setToken(null);
    return { ok: false, error: 'Your Nexus session expired. Sign in again.', status: 401 };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const body = (typeof payload === 'object' && payload !== null ? payload : {}) as {
      error?: unknown;
      reason?: unknown;
      canTransfer?: unknown;
      conflicts?: unknown;
      blocked?: unknown;
    };
    const message = typeof body.error === 'string' ? body.error : `Nexus returned ${String(response.status)}.`;
    // A 409 that means "another profile holds this identity" carries the holder's details. They
    // are narrowed here rather than asserted: the payload is server output, not a typed value.
    return {
      ok: false,
      error: message,
      status: response.status,
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      ...(typeof body.canTransfer === 'boolean' ? { canTransfer: body.canTransfer } : {}),
      ...(body.blocked === true ? { blocked: true } : {}),
      ...(Array.isArray(body.conflicts)
        ? {
            conflicts: body.conflicts.flatMap((entry) => {
              if (typeof entry !== 'object' || entry === null) return [];
              const conflict = entry as { sessionId?: unknown; operatorName?: unknown; lastActiveAt?: unknown; isSelf?: unknown };
              if (typeof conflict.sessionId !== 'string') return [];
              return [
                {
                  sessionId: conflict.sessionId,
                  operatorName: typeof conflict.operatorName === 'string' ? conflict.operatorName : null,
                  lastActiveAt: typeof conflict.lastActiveAt === 'string' ? conflict.lastActiveAt : '',
                  isSelf: conflict.isSelf === true,
                },
              ];
            }),
          }
        : {}),
    };
  }

  return { ok: true, ...(payload as T) };
}

/* ------------------------------------------------------------------ auth -- */

export function signIn(email: string, password: string): Promise<ApiResult<{ session: CompanionSession; token: string }>> {
  // Unauthenticated by design: this call is what obtains the token.
  return request<{ session: CompanionSession; token: string }>('/companion/session', {
    method: 'POST',
    body: { email, password },
    authenticated: false,
  });
}

export function signOut(): Promise<ApiResult<Record<string, never>>> {
  return request<Record<string, never>>('/companion/session', { method: 'DELETE' });
}

export function me(): Promise<ApiResult<{ session: CompanionSession }>> {
  return request<{ session: CompanionSession }>('/companion/me');
}

export interface BootstrapPayload {
  readonly session: CompanionSession;
  readonly businesses: readonly CompanionBusiness[];
  readonly identities: readonly CompanionIdentity[];
  readonly binding: BrowserBinding | null;
  readonly concurrency: { readonly action: 'allow' | 'warn' | 'block'; readonly reason: string };
}

/** One round trip for everything the shell needs on open. */
export function bootstrap(installId: string): Promise<ApiResult<BootstrapPayload>> {
  return request<BootstrapPayload>(`/companion/bootstrap?installId=${encodeURIComponent(installId)}`);
}

/* ------------------------------------------------------------- selectors -- */

export function icps(businessId: string): Promise<ApiResult<{ icps: readonly CompanionIcp[] }>> {
  return request<{ icps: readonly CompanionIcp[] }>(`/companion/icps?businessId=${encodeURIComponent(businessId)}`);
}

export function bindBrowser(input: {
  readonly installId: string;
  readonly identityId: string;
  readonly defaultBusinessId: string | null;
  /**
   * Explicit consent to take the identity from another browser profile.
   *
   * Absent on the first attempt, so the API answers 409 with the holder's details and the panel
   * can ask. Sent only after the operator chooses "Transfer to this browser".
   */
  readonly transfer?: boolean;
}): Promise<
  ApiResult<{
    binding: BrowserBinding;
    transferredFrom: number;
    concurrency: { readonly action: string; readonly reason: string };
  }>
> {
  return request('/companion/bind', { method: 'POST', body: input });
}

export function heartbeat(installId: string): Promise<ApiResult<Record<string, never>>> {
  return request<Record<string, never>>('/companion/heartbeat', { method: 'POST', body: { installId } });
}

/* ------------------------------------------------------------------ data -- */

export function leads(params: {
  readonly businessId: string;
  readonly icpId?: string;
  readonly status?: string;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}): Promise<ApiResult<{ leads: readonly CompanionLead[]; total: number }>> {
  const search = new URLSearchParams({ businessId: params.businessId });
  if (params.icpId !== undefined && params.icpId.length > 0) search.set('icpId', params.icpId);
  if (params.status !== undefined && params.status.length > 0) search.set('status', params.status);
  if (params.search !== undefined && params.search.length > 0) search.set('search', params.search);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.offset !== undefined) search.set('offset', String(params.offset));
  return request<{ leads: readonly CompanionLead[]; total: number }>(`/companion/leads?${search.toString()}`);
}

export function today(params: {
  readonly businessId: string;
  readonly userId: string;
  readonly categories?: readonly string[];
}): Promise<ApiResult<{ items: readonly CompanionTodayItem[] }>> {
  const search = new URLSearchParams({ businessId: params.businessId, userId: params.userId });
  if (params.categories !== undefined && params.categories.length > 0) {
    search.set('categories', params.categories.join(','));
  }
  return request<{ items: readonly CompanionTodayItem[] }>(`/companion/today?${search.toString()}`);
}

export function leadDetail(leadId: string): Promise<ApiResult<{ detail: CompanionLeadDetail }>> {
  return request<{ detail: CompanionLeadDetail }>(`/companion/leads/${encodeURIComponent(leadId)}`);
}

export function search(query: string): Promise<ApiResult<{ results: readonly SearchResult[] }>> {
  return request<{ results: readonly SearchResult[] }>(
    `/companion/search?q=${encodeURIComponent(query)}`,
  );
}

/* ---------------------------------------------------------------- writes -- */

export function addToCrm(input: {
  readonly linkedinUrl: string;
  readonly pastedContent: string;
  readonly businessId: string;
  readonly icpId: string | null;
  readonly autoMatch: boolean;
  readonly ownerUserId?: string | null;
  readonly identityId?: string | null;
  readonly idempotencyKey: string;
}): Promise<ApiResult<{ leadId: string; created: boolean; needsProfile: boolean }>> {
  return request('/companion/add', { method: 'POST', body: input });
}

/**
 * All lead mutations route through one operation endpoint.
 *
 * A single path keeps the mutation surface small and auditable: every write the
 * Companion can perform is enumerated in one server-side handler, rather than being
 * spread across a dozen routes that could drift apart.
 */
function operate<T>(
  operation: string,
  body: Record<string, unknown>,
): Promise<ApiResult<T & Record<string, never>>> {
  return request<T & Record<string, never>>(`/companion/actions/${operation}`, { method: 'POST', body });
}

export function markConnectionSent(input: {
  readonly leadId: string;
  readonly identityId: string;
  readonly withNote: boolean;
}): Promise<ApiResult<Record<string, never>>> {
  return operate('mark-connection-sent', { ...input });
}

export function markMessageSent(input: {
  readonly messageInstanceId: string;
  readonly identityId: string;
}): Promise<ApiResult<Record<string, never>>> {
  return operate('mark-message-sent', { ...input });
}

export function captureReply(input: {
  readonly leadId: string;
  readonly exactText: string;
  readonly outcome: string;
  readonly note: string | null;
}): Promise<ApiResult<Record<string, never>>> {
  return operate('capture-reply', { ...input });
}

export function snooze(input: {
  readonly leadId: string;
  readonly until: string;
  readonly reason: string | null;
}): Promise<ApiResult<Record<string, never>>> {
  return operate('snooze', { ...input });
}

export function captureProfile(input: {
  readonly leadId: string;
  readonly linkedinUrl: string;
  readonly pastedContent: string;
}): Promise<ApiResult<Record<string, never>>> {
  return operate('capture-profile', { ...input });
}

export function startReactivation(leadId: string): Promise<ApiResult<Record<string, never>>> {
  return operate('reactivate', { leadId });
}
