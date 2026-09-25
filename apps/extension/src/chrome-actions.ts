/**
 * Chrome tab and storage operations the Companion performs.
 *
 * These live outside the React component for one reason: they are the only part of the panel
 * that touches a real browser API, and a browser API is the part most likely to behave
 * differently from the assumption. Keeping them here lets each one be tested against the real
 * `chrome.*` implementation in a loaded extension rather than reasoned about.
 */

/**
 * Opens a prospect's profile in the browser's active tab, leaving the panel alive.
 *
 * spec `companion_extension.navigation`: "Opening a prospect's profile happens in the active
 * browser tab" — the panel is pinned beside it and must not be navigated itself.
 *
 * The subtlety is that "the active tab" can be the panel. Chrome renders a side panel inside the
 * browser window, so the active tab is normally the page the operator was reading; but when the
 * panel's document is itself a tab (a preview, or a second window), `active: true` returns the
 * panel, and navigating it would destroy the panel instead of opening the profile.
 *
 * Order of preference:
 *   1. the active tab, when it is not the panel itself;
 *   2. otherwise a new tab.
 */
export async function openInActiveTab(url: string): Promise<'updated' | 'created' | 'invalid'> {
  const target = normaliseProfileUrl(url);
  if (target === null) return 'invalid';

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== undefined && active.url !== url && !isExtensionPage(active.url)) {
    await chrome.tabs.update(active.id, { url: target });
    return 'updated';
  }

  await chrome.tabs.create({ url: target });
  return 'created';
}

/** Whether a URL belongs to this or another extension, and so is not a page to navigate. */
export function isExtensionPage(url: string | undefined): boolean {
  if (url === undefined) return false;
  return url.startsWith('chrome-extension://') || url.startsWith('chrome://') || url.startsWith('devtools://');
}

/**
 * Validates the URL the panel is about to open.
 *
 * A profile URL reaches the panel from a content script (untrusted page context), from a paste,
 * or from the API. `chrome.tabs.update` accepts many schemes, so the target is restricted to the
 * one host this extension is for rather than passed through — a `javascript:` or `file:` URL must
 * never be navigated on the strength of page-controlled input.
 */
export function normaliseProfileUrl(url: string): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  // LinkedIn serves regional hosts (de., uk., …), and all of them are the same site.
  if (parsed.hostname !== 'linkedin.com' && !parsed.hostname.endsWith('.linkedin.com')) return null;

  return parsed.toString();
}

/** The install id: one stable value per browser profile, never a device fingerprint. */
export async function installId(): Promise<string> {
  const stored = await chrome.storage.local.get('nexus.installId');
  const existing: unknown = stored['nexus.installId'];
  if (typeof existing === 'string' && existing.length > 0) return existing;

  const generated = crypto.randomUUID();
  await chrome.storage.local.set({ 'nexus.installId': generated });
  return generated;
}

/** Removes everything a signed-out panel must not keep. */
export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove('nexus.token');
}

/** Whether a session token is currently held, without exposing it. */
export async function hasSession(): Promise<boolean> {
  const stored = await chrome.storage.session.get('nexus.token');
  const token: unknown = stored['nexus.token'];
  return typeof token === 'string' && token.length > 0;
}
