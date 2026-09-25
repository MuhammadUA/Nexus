/**
 * Companion configuration.
 *
 * The API origin is baked in at build time (`__NEXUS_API_ORIGIN__`), so the
 * extension's `host_permissions` can stay narrow instead of asking for broad access
 * at runtime.
 */
export const API_ORIGIN: string =
  typeof __NEXUS_API_ORIGIN__ === 'string' ? __NEXUS_API_ORIGIN__ : 'http://127.0.0.1:3000';

export const API_BASE = `${API_ORIGIN}/api/v1`;

/**
 * Reference surface. spec `design_system.companion_reference`: 420x820. Chrome owns
 * the real panel size, so these are used for layout decisions only.
 */
export const COMPANION_REFERENCE = { width: 420, height: 820 } as const;

/** How often the bound browser session heartbeats, so concurrency warnings stay truthful. */
export const HEARTBEAT_MINUTES = 5;

/** localStorage keys. Namespaced so a stale browser profile cannot collide. */
export const STORAGE_KEYS = {
  token: 'nexus.token',
  binding: 'nexus.binding',
  listState: 'nexus.listState',
} as const;
