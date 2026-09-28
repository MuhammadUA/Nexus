/**
 * POST /api/v1/companion/bind — bind this browser profile to a sender identity.
 *
 * An identity can only be held by one active browser session, so binding one that another profile
 * already holds is a decision rather than a save. The flow is deliberately two-step:
 *
 *   1. without `transfer`, a bind that would take a live identity returns `409` **and a payload
 *      naming the current holder**, so the panel can ask "Cancel / Transfer to this browser"
 *      instead of reporting a failure the operator cannot act on;
 *   2. with `transfer: true`, the caller has chosen that option, the holder's sessions are
 *      revoked, the new binding is created, and an audit entry records who asked and what was
 *      revoked.
 *
 * Before either is acted on, the (channel account, business) pair must be bindable: the account has
 * to be available to the business, and a non-admin caller needs an explicit grant on it. That
 * refusal carries its own reason code so the panel can explain the specific obstacle. It is
 * answered *after* the two concurrency branches, on purpose: for a caller who also holds no claim
 * on the identity, "this identity is held by another operator and you may not release it" is the
 * verdict that matches what the operator asked for, and `transfer_not_permitted` must keep that
 * meaning.
 *
 * Revoking happens only on step 2. It is never a side effect of an ordinary bind, and never a side
 * effect of a refused pair.
 */
import { z } from 'zod';

import { loadViewer } from '@/lib/actor';
import { concurrencyPayload, identityConcurrencyFor } from '@/lib/companion-concurrency';
import {
  bindBrowserSession,
  companionBindingScope,
  recordIdentityTransfer,
} from '@/lib/repo/companion';

import { authorizeUser, jsonError, jsonOk, parseBody } from '../../_lib/http';

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

const bindSchema = z.object({
  installId: z.string().trim().min(8).max(120),
  identityId: uuid,
  defaultBusinessId: uuid.nullable(),
  /**
   * Explicit consent to take the identity from its current holder. Absent means "do not take it":
   * the request is refused when a transfer would be needed.
   */
  transfer: z.boolean().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const auth = await authorizeUser(request);
  if (!auth.ok) return auth.response;

  const parsed = await parseBody(request, bindSchema);
  if (!parsed.ok) return parsed.response;

  const viewer = await loadViewer(auth.context.actor);

  const answer = await identityConcurrencyFor({
    actor: auth.context.actor,
    viewer,
    identityId: parsed.data.identityId,
    installId: parsed.data.installId,
    businessId: parsed.data.defaultBusinessId,
  });

  const wantsTransfer = parsed.data.transfer === true;

  if (answer.decision.action !== 'allow' && !wantsTransfer) {
    // 409 with the holder's details: this is the "show the warning" branch, not a failure the
    // operator is expected to guess their way out of.
    const selfOnly = answer.decision.conflicts.every((conflict) => conflict.isSelf);
    return jsonError(
      answer.decision.conflicts.length > 0 && selfOnly
        ? 'This LinkedIn identity is currently active in another of your browser profiles.'
        : 'This LinkedIn identity is currently active elsewhere.',
      409,
      // `reason` last: the concurrency payload carries the policy's own prose in the same key,
      // and the machine-readable discriminator is what the panel branches on.
      { ...concurrencyPayload(answer), reason: 'identity_in_use' },
    );
  }

  if (answer.decision.action !== 'allow' && wantsTransfer && !answer.canTransfer) {
    // The operator asked to transfer but may not: transferring is an administrator action, or one
    // granted by permission. Checked after the consent flag so the two refusals read differently.
    return jsonError(
      'Taking this identity over needs administrator permission. Ask an administrator to release it.',
      403,
      { ...concurrencyPayload(answer), reason: 'transfer_not_permitted' },
    );
  }

  /**
   * The (account, business) pair, refused with its own specific reason.
   *
   * spec §36 / §61: the business selector offers only businesses the chosen channel
   * account may send from, and the server must refuse the pair even when the panel is
   * bypassed. A crafted request therefore answers `no_account_access`, `no_user_grant`
   * or `identity_not_usable` — the specific obstacle, not a generic permission
   * sentence.
   *
   * Deliberately **after** the two concurrency branches: when an identity is held by
   * another operator, "this actor may not release it" (`transfer_not_permitted`) is the
   * decision the operator acted on, and answering "this account cannot be used" would
   * replace a precise refusal with a looser one. The pair condition and the transfer
   * condition genuinely overlap for a caller who holds no management claim on the
   * identity, and in that overlap the transfer verdict wins.
   *
   * `bindBrowserSession` re-checks the same helper inside the write transaction, so this
   * answer is an explanation rather than the authorization.
   */
  const scope = await companionBindingScope(
    auth.context.actor,
    parsed.data.identityId,
    parsed.data.defaultBusinessId,
  );
  if (!scope.ok) {
    return jsonError(scope.message, 403, { reason: scope.reason });
  }

  // The transfer and the bind happen in one transaction inside the repository, so there is no
  // window in which the identity is released but not yet taken. `transfer: true` is the consent.
  const result = await bindBrowserSession(viewer, {
    ...parsed.data,
    transfer: answer.decision.action !== 'allow' && wantsTransfer,
  });
  if (!result.ok || result.binding === undefined) {
    // A refusal that carries a scope reason is a decision about this pair, not a
    // failure: it keeps its own status and machine-readable reason so the panel can
    // explain it (and offer nothing else) instead of reporting a generic save failure.
    if (result.reason !== undefined && result.reason !== 'ok') {
      return jsonError(result.error ?? 'That binding is not allowed.', 403, { reason: result.reason });
    }
    return jsonError(result.error ?? 'The browser binding was not saved.', 400, { reason: 'bind_failed' });
  }

  const revokedSessionIds = result.revokedSessionIds ?? [];

  if (revokedSessionIds.length > 0) {
    // After the write, so a failed bind cannot leave an audit entry claiming a transfer happened.
    await recordIdentityTransfer(viewer, {
      identityId: parsed.data.identityId,
      installId: parsed.data.installId,
      revokedSessionIds,
      transferPermissions: answer.canTransfer,
    });
  }

  return jsonOk({
    binding: result.binding,
    transferredFrom: revokedSessionIds.length,
    concurrency: {
      action: 'allow',
      reason:
        revokedSessionIds.length > 0
          ? `transferred from ${String(revokedSessionIds.length)} other browser session`
          : 'no conflicting session detected',
      canTransfer: answer.canTransfer,
      blocked: answer.blocked,
      conflicts: [],
    },
  });
}
