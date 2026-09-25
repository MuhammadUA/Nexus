'use server';

/**
 * A18 — Integrations Gateway actions.
 *
 * A service token is generated server-side and returned to the form exactly once. The
 * raw value is never stored, never logged, and never re-readable: `api_clients` holds
 * only a SHA-256 hash plus a display prefix. That is why the UI must show it
 * immediately and ask the operator to copy it.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { API_SCOPES } from '@nexus/core';

import { currentViewer } from '@/lib/current-viewer';
import { generateServiceToken } from '@/lib/gateway';
import { createApiClient, revokeApiClient } from '@/lib/repo/integrations';
import { formString, formStringOrNull, formStrings } from '@/lib/form-data';

export interface IntegrationActionResult {
  readonly ok: boolean;
  readonly error: string | null | undefined;
  readonly message?: string;
  /** Present exactly once, on successful creation. Never persisted. */
  readonly token?: string;
}

const scopeValues = API_SCOPES as readonly string[];

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['mcp', 'rest_ingest', 'webhook', 'internal_worker']),
  expiresInDays: z
    .union([z.coerce.number().int().min(1).max(3650), z.literal('').transform(() => null)])
    .nullable(),
});

export async function createApiClientAction(
  _previous: IntegrationActionResult,
  formData: FormData,
): Promise<IntegrationActionResult> {
  const viewer = await currentViewer();
  if (viewer === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  const parsed = createSchema.safeParse({
    name: formStringOrNull(formData, 'name'),
    kind: formString(formData, 'kind', 'rest_ingest'),
    expiresInDays: formStringOrNull(formData, 'expiresInDays') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, error: 'Give the token a name and a valid expiry, or leave the expiry blank.' };
  }

  // Scopes arrive as repeated checkbox values. `getAll` can return `File` entries, so
  // they are filtered to strings first — `String(value)` on a File would yield
  // "[object Object]" and could smuggle an unexpected scope name past the allow-list.
  const scopes = formStrings(formData, 'scopes').filter((value) => scopeValues.includes(value));

  const businessIds = formStrings(formData, 'businessIds').filter(
    (value) => z.string().uuid().safeParse(value).success,
  );

  if (scopes.length === 0) {
    return { ok: false, error: 'Choose at least one scope. A token with no scopes can do nothing.' };
  }
  if (businessIds.length === 0) {
    return { ok: false, error: 'Choose at least one business. A token scoped to no business can do nothing.' };
  }

  const token = generateServiceToken();
  const result = await createApiClient(
    viewer,
    {
      name: parsed.data.name ?? undefined,
      kind: parsed.data.kind ?? undefined,
      scopes,
      businessIds,
      expiresInDays: parsed.data.expiresInDays ?? undefined,
    },
    { hash: token.hash, prefix: token.prefix },
  );

  if (!result.ok) return { ok: false, error: result.error ?? 'The token was not created.' };

  revalidatePath('/integrations');

  return {
    ok: true,
    error: null,
    message: 'Token created. Copy it now — it cannot be shown again.',
    token: token.raw,
  };
}

export async function revokeApiClientAction(
  _previous: IntegrationActionResult,
  formData: FormData,
): Promise<IntegrationActionResult> {
  const viewer = await currentViewer();
  if (viewer === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  const parsed = z.object({ clientId: z.string().uuid() }).safeParse({
    clientId: formStringOrNull(formData, 'clientId'),
  });
  if (!parsed.success) return { ok: false, error: 'That token could not be found.' };

  const result = await revokeApiClient(viewer, parsed.data.clientId);
  if (result.ok) revalidatePath('/integrations');

  return {
    ok: result.ok,
    error: result.error ?? null,
    message: result.ok ? 'Token revoked.' : undefined,
  };
}
