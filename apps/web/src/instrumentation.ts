/**
 * Boot-time checks and server-error reporting.
 *
 * Next.js calls `register()` once per server process. This is where a
 * configuration that would silently weaken the security model is turned into a
 * hard startup failure rather than a surprise in production.
 */
export async function register(): Promise<void> {
  // Imported dynamically so the check runs inside the Node runtime rather than
  // being pulled into an edge bundle.
  const { assertRuntimePosture } = await import('@/lib/db');
  assertRuntimePosture();
}

/** The most recent server error, kept in memory so it can be inspected while serving. */
export interface RecordedServerError {
  readonly at: string;
  readonly message: string;
  readonly digest: string | null;
  readonly route: string | null;
  readonly stack: string | null;
}

const recent: RecordedServerError[] = [];

/** Newest last; bounded, and never persisted. */
export function recentServerErrors(): readonly RecordedServerError[] {
  return recent;
}

/**
 * Reports every server-side error caused by a request.
 *
 * A React render failure reaches the browser as a digest and nothing else — by design, so
 * production does not leak internals. That also makes it undiagnosable from outside, so the
 * real message is captured here. This hook only records; it never changes the response, and
 * it holds nothing that is not already in the server log.
 */
export function onRequestError(
  error: unknown,
  request: { path?: string },
  context: { routerKind?: string; routePath?: string; routeType?: string },
): void {
  const digest =
    typeof error === 'object' && error !== null && 'digest' in error
      ? (error as { digest?: unknown }).digest
      : null;
  const record: RecordedServerError = {
    at: new Date().toISOString(),
    message: error instanceof Error ? error.message : String(error),
    digest: typeof digest === 'string' ? digest : null,
    route: context.routePath ?? request.path ?? null,
    stack: error instanceof Error ? (error.stack ?? null) : null,
  };
  recent.push(record);
  if (recent.length > 25) recent.shift();
  console.error(`[nexus] request error on ${record.route ?? 'unknown route'}: ${record.message}`);
}
