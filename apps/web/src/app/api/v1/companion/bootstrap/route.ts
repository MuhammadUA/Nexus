/**
 * GET /api/v1/companion/bootstrap — everything the panel needs on open.
 *
 * One round trip rather than four: the panel paints the selectors, the binding and
 * any concurrency warning together, so it never renders a half-configured shell.
 */
import { loadViewer } from '@/lib/actor';
import { concurrencyPayload, identityConcurrencyFor } from '@/lib/companion-concurrency';
import { listBusinesses } from '@/lib/repo/businesses';
import {
  companionIdentities,
  companionSession,
  findBinding,
  type BrowserBindingRow,
  type CompanionBusinessRow,
  type CompanionIdentityRow,
} from '@/lib/repo/companion';

import { authorizeUser, jsonOk } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const auth = await authorizeUser(request);
  if (!auth.ok) return auth.response;

  const { actor, userId } = auth.context;
  const url = new URL(request.url);
  const installId = url.searchParams.get('installId') ?? '';

  // spec `extension_visibility_rule` is applied by `companionIdentities`, which
  // intersects the user's business access with each identity's own access.
  const [identities, businesses] = await Promise.all([
    companionIdentities(actor, userId),
    listBusinesses(actor),
  ]);

  const binding: BrowserBindingRow | null =
    installId.length === 0 ? null : await findBinding(actor, userId, installId);

  let concurrency: Record<string, unknown> = {
    action: 'allow',
    reason: 'no conflicting session detected',
    canTransfer: false,
    blocked: false,
    conflicts: [],
  };

  if (binding !== null) {
    // Derived by the same function the bind route uses, so the warning shown on open and the
    // refusal returned on bind can never disagree.
    const viewer = await loadViewer(actor);
    const answer = await identityConcurrencyFor({
      actor,
      viewer,
      identityId: binding.identityId,
      installId,
      businessId: binding.defaultBusinessId,
    });
    concurrency = concurrencyPayload(answer);
  }

  const session = await companionSession(actor, userId);

  return jsonOk({
    session,
    businesses: businesses.map<CompanionBusinessRow>((business) => ({
      id: business.id,
      slug: business.key,
      name: business.name,
    })),
    identities: identities.map<CompanionIdentityRow>((identity) => identity),
    binding,
    concurrency,
  });
}
