/**
 * POST /api/v1/companion/session — sign in and receive a user bearer token.
 * DELETE — revoke the calling token (sign out).
 *
 * The raw token is returned exactly once and only its SHA-256 hash is stored, so a
 * database disclosure cannot yield a usable credential.
 */
import { z } from 'zod';

import { withServiceRole } from '@/lib/actor';
import { localAuthEnabled, verifyLocalCredentials } from '@/lib/auth';
import { generateUserToken, hashToken, resolveCredential } from '@/lib/gateway';

import { jsonError, jsonOk, parseBody } from '../../_lib/http';

export const dynamic = 'force-dynamic';

const signInSchema = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(200),
  label: z.string().trim().max(80).optional(),
});

export async function POST(request: Request): Promise<Response> {
  if (!localAuthEnabled()) {
    return jsonError('Local sign-in is disabled. Connect Supabase Auth instead.', 403);
  }

  const parsed = await parseBody(request, signInSchema);
  if (!parsed.ok) return parsed.response;

  const outcome = await verifyLocalCredentials(parsed.data.email, parsed.data.password);
  if (!outcome.ok || outcome.userId === undefined) {
    return jsonError(outcome.reason ?? 'Email or password is incorrect.', 401);
  }

  const token = generateUserToken();

  const issued = await withServiceRole('companion: issue user token', async (sql) => {
    await sql.query(`select public.issue_user_token($1, $2, $3, $4, 'companion', 30)`, [
      outcome.userId,
      token.hash,
      token.prefix,
      parsed.data.label ?? 'Companion',
    ]);

    const profile = await sql.query<{
      id: string;
      email: string;
      full_name: string | null;
      role: 'admin' | 'manager' | 'user';
    }>(`select id, email, full_name, role from public.users where id = $1`, [outcome.userId]);

    return profile.rows[0];
  });

  if (issued === undefined) return jsonError('The account could not be loaded.', 500);

  return jsonOk({
    token: token.raw,
    session: {
      userId: issued.id,
      email: issued.email,
      fullName: issued.full_name,
      role: issued.role,
    },
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const match = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') ?? '').trim());
  const raw = match?.[1]?.trim() ?? '';
  if (raw.length === 0) return jsonError('Missing token.', 401);

  // Revoke by hash: the caller proves possession, and nothing else can revoke it.
  await withServiceRole('companion: revoke user token', async (sql) => {
    await sql.query(
      `update public.user_api_tokens set revoked_at = now()
        where token_hash = $1 and revoked_at is null`,
      [hashToken(raw)],
    );
  });

  // Confirm the token is actually gone before reporting success.
  const stillValid = await resolveCredential(request.headers.get('authorization'));
  return stillValid.kind === 'anonymous'
    ? jsonOk({ revoked: true })
    : jsonError('The token could not be revoked.', 500);
}
