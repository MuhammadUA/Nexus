/**
 * LinkedIn content script.
 *
 * Its only job is to answer the panel's questions about the page it runs on: is this a profile,
 * what is its canonical URL, and what does it say. It never modifies the page, never clicks
 * anything, and never sends anything on its own — spec `product.non_goal` forbids autonomous
 * outreach, and spec `security_and_reliability.rules` treats page content as untrusted input.
 *
 * All extraction lives in `linkedin-adapter.ts` so a LinkedIn redesign breaks one tested file
 * instead of this one, and so a field that cannot be read degrades to "paste it instead" rather
 * than to a wrong value.
 */
import { isProfileUrl, readProfile, type LinkedInProfile } from './linkedin-adapter.js';

/** The reply the panel receives. Narrower than the adapter's shape: only what it uses. */
type CaptureReply =
  | { readonly available: false; readonly reason: string }
  | ({ readonly available: true } & LinkedInProfile);

function capture(): CaptureReply {
  const profile = readProfile(document, window.location.href);
  if (profile === null) {
    return {
      available: false,
      reason: 'This is not a LinkedIn profile page. Open the prospect\u2019s profile, then capture it.',
    };
  }
  return { available: true, ...profile };
}

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (typeof message !== 'object' || message === null) return false;
    const typed = message as { type?: unknown };

    if (typed.type === 'nexus:capture-page') {
      sendResponse(capture());
      return true;
    }

    if (typed.type === 'nexus:current-url') {
      sendResponse({ url: window.location.href, isProfile: isProfileUrl(window.location.href) });
      return true;
    }

    return false;
  },
);

// Tell the panel which profile is on screen. The panel decides whether to use it — nothing here
// triggers a write.
void chrome.runtime
  .sendMessage({
    type: 'nexus:page-changed',
    url: window.location.href,
    isProfile: isProfileUrl(window.location.href),
  })
  .catch(() => {
    /* No listener yet (panel closed); harmless. */
  });
