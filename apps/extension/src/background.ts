/**
 * MV3 service worker.
 *
 * Responsibilities are deliberately small: open the side panel, run the
 * browser-session heartbeat, and answer content-script messages. No LinkedIn
 * automation happens here — spec `product.non_goal` is explicit that Nexus is not an
 * autonomous cold-outreach spammer, so the extension never sends a message on the
 * operator's behalf.
 */
import { HEARTBEAT_MINUTES } from './config';
import { bootstrap, getBinding, heartbeat } from './api';

const HEARTBEAT_ALARM = 'nexus-heartbeat';

/**
 * One stable id per browser profile.
 *
 * spec `roles_and_permissions.same_user_multiple_browsers`: "Each browser profile can
 * bind to the same Nexus user but a different assigned outreach identity." That only
 * works if a profile is distinguishable, so the id is persisted in local storage and
 * reused across service-worker restarts (the worker is torn down aggressively).
 */
async function installId(): Promise<string> {
  const stored = await chrome.storage.local.get('nexus.installId');
  const existing: unknown = stored['nexus.installId'];
  if (typeof existing === 'string' && existing.length > 0) return existing;

  const generated = crypto.randomUUID();
  await chrome.storage.local.set({ 'nexus.installId': generated });
  return generated;
}

async function openPanel(tab: chrome.tabs.Tab | undefined): Promise<void> {
  // Clicking the toolbar icon opens the side panel for this window; the panel stays
  // open while the operator browses, which is the whole point of the layout.
  const windowId = tab?.windowId;
  if (windowId === undefined) return;
  await chrome.sidePanel.open({ windowId });
}

chrome.runtime.onInstalled.addListener(() => {
  // Let the operator click the icon to open the panel.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    /* Older Chrome builds may not support this; the click handler below covers it. */
  });
  void chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
});

chrome.action.onClicked.addListener((tab) => {
  void openPanel(tab);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  void (async () => {
    const binding = await getBinding();
    if (binding === null) return;
    const id = await installId();
    // A heartbeat failure is not actionable for the operator, and the API client
    // already clears the token on 401 — so this deliberately does not surface an
    // error notification.
    await heartbeat(id);
    await bootstrap(id);
  })();
});

/**
 * Content-script bridge.
 *
 * The content script asks the service worker to identify the person on the page it runs in, and
 * gets back at most one lead id. The response is reduced to that id on purpose: page context is
 * untrusted, so the narrowest answer that serves the purpose is the only one it gets.
 */
chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (typeof message !== 'object' || message === null) return false;
    const typed = message as { type?: unknown; linkedinUrl?: unknown };
    if (typed.type !== 'nexus:identify' || typeof typed.linkedinUrl !== 'string') return false;
    const linkedinUrl = typed.linkedinUrl;

    void (async () => {
      const { search } = await import('./api.js');
      const result = await search(linkedinUrl);
      // The matching rows are `results`; the id is read by name rather than by position so a change
      // in ordering cannot silently identify the wrong person.
      const first = result.ok ? result.results.find((row) => row.leadId.length > 0) : undefined;
      sendResponse({ leadId: first?.leadId ?? null });
    })();

    // Keep the message channel open for the async reply.
    return true;
  },
);

void installId();
