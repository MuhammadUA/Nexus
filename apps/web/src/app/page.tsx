import type { ReactNode } from 'react';

import { redirect } from 'next/navigation';

import { currentViewer } from '@/lib/current-viewer';

export const dynamic = 'force-dynamic';

export default async function HomePage(): Promise<ReactNode> {
  const viewer = await currentViewer();
  redirect(viewer === null ? '/login' : '/my-day');
}
