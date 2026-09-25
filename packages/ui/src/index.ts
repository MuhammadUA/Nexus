/**
 * `@nexus/ui` public surface.
 *
 * Consumed by the Next.js app (admin + user) and the Chrome MV3 Companion, which
 * is what makes "one shared extension codebase with role-aware permissions" and
 * a single design language structurally true rather than aspirational.
 *
 * `styles.css` is imported once by each host entry point.
 */
export * from './tokens.js';
export * from './primitives.js';
export * from './app-shell.js';
export * from './companion-shell.js';
export * from './domain.js';
