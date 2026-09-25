/**
 * Boot probe: does this browser really load the built extension, and does the panel mount?
 *
 * Run before anything else. If this fails, every other E2E result is meaningless, so it is kept
 * separate and reports the browser version and the reason it could not load.
 */
import { launchExtension, waitForMounted, collectConsole } from './harness.mjs';

const extension = await launchExtension();
try {
  const worker = await extension.serviceWorker();
  console.log('browser:', extension.context.browser()?.version() ?? 'unknown');
  console.log('extension id:', extension.extensionId);
  console.log('service worker:', worker.url());
  console.log('panel url:', extension.panelUrl);

  const page = await extension.openPanel();
  const console_ = collectConsole(page);
  await waitForMounted(page);

  const probe = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    shell: document.querySelector('.nx-companion') !== null,
    text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    hasChromeStorage: typeof chrome !== 'undefined' && typeof chrome.storage?.local?.get === 'function',
    hasChromeTabs: typeof chrome !== 'undefined' && typeof chrome.tabs?.query === 'function',
    isExtensionOrigin: location.protocol === 'chrome-extension:',
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));

  console.log('mounted:', JSON.stringify(probe, null, 2));
  console.log('console errors/warnings:', JSON.stringify(console_));

  const ok =
    probe.isExtensionOrigin &&
    probe.shell &&
    probe.hasChromeStorage &&
    probe.hasChromeTabs &&
    probe.innerWidth === 420 &&
    probe.innerHeight === 820 &&
    console_.length === 0;

  console.log(ok ? 'RESULT: extension boot OK' : 'RESULT: extension boot FAILED');
  process.exitCode = ok ? 0 : 1;
} finally {
  await extension.close();
}
