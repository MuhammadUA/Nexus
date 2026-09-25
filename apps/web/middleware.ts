import { NextResponse, type NextRequest } from 'next/server';

/**
 * CORS for the Companion API.
 *
 * The Chrome extension calls these routes from a `chrome-extension://` origin, which is
 * cross-origin to the app. Without the preflight response below, Chrome blocks every companion
 * request before it is sent — including the sign-in — and the panel looks like it simply does
 * nothing, which is exactly how the side panel failed in the browser first pass.
 *
 * Only `/api/v1/companion/*` is opened up. That surface is token-authenticated with
 * `Authorization: Bearer` rather than cookies, so allowing a wildcard origin does not let a
 * third-party page act as a signed-in operator: a browser does not attach the companion token
 * to a request it did not originate. The cookie-authenticated app routes stay same-origin only.
 */
const COMPANION_PREFIX = '/api/v1/companion';

const ALLOWED_HEADERS = 'authorization, content-type';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

function withCors(response: NextResponse, origin: string | null): NextResponse {
  // An extension origin is opaque (`chrome-extension://<id>`), so it is echoed rather than
  // allow-listed. Any other origin is refused.
  if (origin !== null && origin.startsWith('chrome-extension://')) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
  }
  return response;
}

export function middleware(request: NextRequest): NextResponse {
  const origin = request.headers.get('origin');

  if (request.method === 'OPTIONS') {
    const preflight = new NextResponse(null, { status: 204 });
    preflight.headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
    preflight.headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    preflight.headers.set('Access-Control-Max-Age', '600');
    return withCors(preflight, origin);
  }

  return withCors(NextResponse.next(), origin);
}

export const config = {
  matcher: [`${COMPANION_PREFIX}/:path*`],
};
