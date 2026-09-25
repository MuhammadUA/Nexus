/**
 * Stand-in for the `server-only` marker package.
 *
 * The marker exists to make an accidental client import fail at build time. In a
 * plain Node test there is no client bundle, so it is aliased to this empty module
 * (see `vitest.config.ts`) so application modules stay importable.
 */
export {};
