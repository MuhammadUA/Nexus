import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * `USER_NAV` lists the user Trash screen as `/my-trash`, while the canonical route is
 * `/trash` (the same page the admin nav reaches). Rather than duplicate the screen or
 * silently drop the entry, this alias redirects.
 *
 * A permanent redirect is deliberate: the destination will not change again, and a
 * bookmark of either path should keep working.
 */
export default function MyTrashAlias(): never {
  redirect('/trash');
}
