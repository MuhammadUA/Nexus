'use client';

/**
 * Presentation and controls for the Business Setup · AI tab (spec §63).
 *
 * As on the Agent Jobs screen, the mapping from a stored row to what an operator reads is
 * decided here and rendered through small components, because a non-component export of a
 * `'use client'` module cannot be called from a Server Component. The page keeps the reads,
 * the guard and the column list.
 *
 * The activate control is rendered only for an administrator — but that is presentation. The
 * action refuses a non-admin first, `activatePromptVersion` refuses one again, and the write
 * policy on `prompt_versions` requires `is_admin()`, so a forged post fails three times over
 * rather than being "hidden" and allowed.
 */
import { useActionState, type ReactElement } from 'react';

import { Button, Chip, Stack, type AccentName } from '@nexus/ui';

import type { AiSettingsActionResult } from '@/app/b/[slug]/setup/ai/actions';

const IDLE: AiSettingsActionResult = { ok: false, error: null };

/** The words for a prompt's scope, used by the status column and by every history row. */
export function scopeLabel(businessId: string | null): string {
  return businessId === null ? 'global' : 'business override';
}

export function scopeAccent(businessId: string | null): AccentName {
  return businessId === null ? 'neutral' : 'indigo';
}

/**
 * The effective prompt's origin.
 *
 * Three cases, and the third matters: with no stored row the built-in default runs, so the tab
 * is useful on a deployment whose registry was never seeded rather than showing a blank cell
 * (§63.5).
 */
export function PromptScopeChip({
  businessId,
  stored,
}: {
  readonly businessId: string | null;
  readonly stored: boolean;
}): ReactElement {
  if (!stored) {
    return (
      <Chip accent="amber" dataState="builtin-default">
        built-in default
      </Chip>
    );
  }
  return (
    <Chip accent={scopeAccent(businessId)} dataState={businessId === null ? 'global' : 'override'}>
      {businessId === null ? 'global version' : 'business override'}
    </Chip>
  );
}

export interface PromptVersionView {
  readonly id: string;
  readonly version: number;
  readonly businessId: string | null;
  readonly model: string | null;
  readonly temperature: number | null;
  readonly maxOutputTokens: number | null;
  readonly isActive: boolean;
  readonly updatedAt: string | null;
}

/**
 * The version history for one prompt key, with an Activate control per inactive version.
 *
 * Rendered inline rather than behind a disclosure: the point of versioning is that an operator
 * can see what the previous version was and put it back, and a history that has to be found is
 * a history that is not read. Activation is audited by the database's own write policy, and
 * nothing here can edit or delete a version — the history is append-only in the UI too.
 */
export function PromptVersionHistory({
  action,
  promptKey,
  businessId,
  businessSlug,
  versions,
  canActivate,
}: {
  readonly action: (
    previous: AiSettingsActionResult,
    formData: FormData,
  ) => Promise<AiSettingsActionResult>;
  readonly promptKey: string;
  readonly businessId: string;
  readonly businessSlug: string;
  readonly versions: readonly PromptVersionView[];
  readonly canActivate: boolean;
}): ReactElement {
  const [state, formAction, pending] = useActionState(action, IDLE);

  if (versions.length === 0) {
    return <span className="nx-hint">no stored version; the built-in default runs</span>;
  }

  return (
    <Stack size="sm">
      {versions.map((version) => (
        <div key={version.id} className="nx-row nx-row--wrap">
          <span className="nx-table__mono">{`v${String(version.version)}`}</span>
          <PromptScopeChip businessId={version.businessId} stored />
          {version.isActive ? (
            <Chip accent="green" dataState="active">
              active
            </Chip>
          ) : canActivate ? (
            <form action={formAction}>
              <input type="hidden" name="versionId" value={version.id} />
              <input type="hidden" name="promptKey" value={promptKey} />
              <input type="hidden" name="businessId" value={businessId} />
              <input type="hidden" name="businessSlug" value={businessSlug} />
              <Button type="submit" variant="ghost" size="sm" busy={pending}>
                {`Activate v${String(version.version)}`}
              </Button>
            </form>
          ) : (
            <Chip accent="neutral">inactive</Chip>
          )}
        </div>
      ))}

      {state.error !== null && (
        <span className="nx-error" role="alert">
          {state.error}
        </span>
      )}
      {state.error === null && state.message !== undefined && (
        <span className="nx-hint" role="status">
          {state.message}
        </span>
      )}
    </Stack>
  );
}
