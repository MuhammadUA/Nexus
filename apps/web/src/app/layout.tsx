import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '@nexus/ui/styles.css';

export const metadata: Metadata = {
  title: 'Nexus',
  description: 'Multi-business lead intelligence CRM and outreach workspace.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
