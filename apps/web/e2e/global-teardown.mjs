/**
 * Playwright global teardown for the V1.2 browser suite.
 *
 * Removes the temporary data directory the run created. That is what makes the suite leave no trace:
 * the embedded database lives, and dies, entirely under the OS temp dir, so no developer's
 * `apps/web/.data` is read or written and no account this suite creates survives it.
 *
 * Deliberately unconditional. A failed spec still leaves a provisioned directory, and keeping it would
 * mean the *next* run started from state a previous run had mutated — which is exactly the "runnable
 * twice in a row" property this suite has to guarantee. Playwright's traces and failure screenshots are
 * written under the same run directory, so a reader who needs them after a failure should read them
 * before the next invocation; the failing assertion's message is in the report either way.
 */
import { removeRunDir } from './harness.mjs';

export default async function globalTeardown() {
  removeRunDir();
  console.log('[e2e] removed the isolated web database directory');
}
