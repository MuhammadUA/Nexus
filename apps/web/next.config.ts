import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@nexus/core', '@nexus/db', '@nexus/ui'],
  eslint: {
    ignoreDuringBuilds: true,
  },
  serverExternalPackages: ['@electric-sql/pglite'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    return config;
  },
  async headers() {
    return [
      /**
       * CORS for the Companion API.
       *
       * The Chrome side panel calls these routes from a `chrome-extension://` origin and sends an
       * `authorization` header, so every call is a preflighted cross-origin request. Without the
       * headers below, Chrome rejects the response before it is read and the panel reports
       * "Nexus is unreachable" — a CORS failure, not a network one, which is why that message
       * appeared even while the server was running and answering.
       *
       * Declared here rather than in `middleware.ts` deliberately. That file documents the same
       * policy but never executes: Next.js resolves middleware to `src/middleware.ts` when a `src`
       * directory is present, and this app has one, so the root-level `apps/web/middleware.ts` is
       * ignored — `.next/server/middleware-manifest.json` lists no middleware at all. Moving it into
       * `src/` is not sufficient on its own either: Next bundles `src/instrumentation.ts` for the edge
       * middleware runtime, and that file imports `@/lib/db` → `node:path`, which the edge runtime
       * cannot resolve, so the build fails. A static header rule has neither problem.
       *
       * A wildcard is safe for this surface specifically because it is token-authenticated with
       * `Authorization: Bearer` rather than cookies, and the app sets no companion cookie
       * (`set-cookie` is absent from the sign-in response). `*` forbids credentialed requests, so a
       * third-party page cannot borrow an operator's session; it would need the token itself. The
       * cookie-authenticated app routes below are untouched and remain same-origin.
       */
      {
        source: '/api/v1/companion/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'authorization, content-type' },
          { key: 'Access-Control-Max-Age', value: '600' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
