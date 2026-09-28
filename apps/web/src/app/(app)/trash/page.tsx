import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * Alias: `/trash` -> `/my-trash`.
 *
 * The user Trash screen lives at `/my-trash`, which is what `USER_NAV` and `ROUTE_PERMISSIONS`
 * name. This path keeps an existing link or bookmark working.
 *
 * The destination runs the real guard against `trash.view`; this alias has no read of its own to
 * protect.
 */
export default function TrashAlias(): never {
  redirect('/my-trash');
}
