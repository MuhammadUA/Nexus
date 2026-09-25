/**
 * Normalization primitives.
 *
 * Spec `lead_invariants`:
 *   - "Normalized LinkedIn URL is the strongest person dedupe key when available."
 *   - "Normalized company domain is the strongest company dedupe key when available."
 *   - "Fallback dedupe may use normalized name + company + title with confidence."
 *
 * Spec `lead_sources.lead_sources.companion.add_to_crm.source_evidence` requires a
 * `raw payload/content hash`, so hashing lives here too and is shared by the web
 * app, the extension and the API gateway so an identical payload always hashes
 * identically regardless of which surface captured it.
 *
 * This module is intentionally dependency-light: only `node:crypto` is used, and
 * it resolves to the WebCrypto-backed implementation on every supported runtime
 * (Node 20+, Vercel edge, and the extension's service worker).
 */

/* ------------------------------------------------------------------ text -- */

/** Trailing punctuation and whitespace that captcha/copy-paste layers add. */
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/** Collapse all whitespace runs (including newlines) into single spaces. */
export function collapseWhitespace(input: string): string {
  return input.replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}

/**
 * Normalize free text for comparison: lowercase, strip diacritics, collapse
 * whitespace, drop punctuation that carries no identity meaning.
 */
export function normalizeText(input: string): string {
  return collapseWhitespace(
    input
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, ''),
  )
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s&+.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokens that are legal-entity *designators* and never part of a brand name.
 *
 * Deliberately excludes corporate descriptors such as `group`, `holdings` and
 * `company`: unlike `GmbH` or `Inc`, those are ordinary words that businesses
 * really do use as their name ("Northstar Group" and "Group" are different
 * companies from "Northstar"). Stripping them would merge unrelated companies
 * and, when the whole name was one such word, collapse it to the empty string.
 */
const COMPANY_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'l l c',
  'ltd',
  'limited',
  'plc',
  'gmbh',
  'ug',
  'ag',
  'bv',
  'nv',
  'sa',
  'sarl',
  'srl',
  'spa',
  'oy',
  'ab',
  'as',
  'aps',
  'pte',
  'pty',
  'co',
  'corp',
  'corporation',
]);

/** Normalize a company name for fallback matching. */
export function normalizeCompanyName(input: string): string {
  const base = normalizeText(input).replace(/[.,]/g, '');
  const parts = base.split(' ').filter((p) => p.length > 0);
  const stripped = parts.filter((p) => !COMPANY_SUFFIXES.has(p));
  // Never let suffix stripping empty a name: a company literally called "Ltd"
  // still needs a key, and returning '' would match every other stripped name.
  return (stripped.length > 0 ? stripped : parts).join(' ').trim();
}

/**
 * Normalize a person name for fallback matching.
 * Trailing credential letters ("Tom Henry (PMP)", "Sarah Smith MBA") are dropped
 * because job-board exports append them inconsistently.
 */
export function normalizePersonName(input: string): string {
  const withoutParens = input.replace(/\([^)]*\)/g, ' ');
  const base = normalizeText(withoutParens);
  const parts = base.split(' ').filter(Boolean);
  const trailingTitle = new Set([
    'mba',
    'phd',
    'pmp',
    'cfa',
    'cpa',
    'msc',
    'bsc',
    'ba',
    'ma',
    'md',
    'esq',
    'jr',
    'sr',
    'ii',
    'iii',
    'iv',
  ]);
  while (parts.length > 1 && trailingTitle.has(parts[parts.length - 1] as string)) {
    parts.pop();
  }
  return parts.join(' ');
}

/** Normalize a job title for fallback matching. */
export function normalizeJobTitle(input: string): string {
  const base = normalizeText(input);
  return base
    .replace(/\b(senior|sr|lead|principal|head of|chief|staff|junior|jr)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------- url -- */

/**
 * Tracking/attribution query parameters that appear on LinkedIn share links but
 * carry no identity meaning. Removing them is required by the dedupe test
 * "URL with tracking/query variants".
 */
const TRACKING_PARAMS = [
  'trk',
  'trkInfo',
  'trackingId',
  'lipi',
  'lici',
  'original_referer',
  'originalSubdomain',
  'refId',
  'ref',
  'src',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'si',
  's',
  't',
  'shareId',
  'shareUrn',
  'miniProfileUrn',
  'session_redirect',
];

/**
 * Apex LinkedIn hosts we accept. Regional hosts (`de.linkedin.com`,
 * `uk.linkedin.com`, …) are matched separately by `LINKEDIN_REGION_HOST` because
 * the country prefix is an open set, while anything else under `linkedin.com`
 * (for example `blog.linkedin.com`) is not a member profile host.
 */
const LINKEDIN_APEX_HOSTS = new Set([
  'linkedin.com',
  'www.linkedin.com',
  'm.linkedin.com',
  'mobile.linkedin.com',
  'lnkd.in',
  'linkedin.cn',
  'www.linkedin.cn',
]);

/** `de.linkedin.com`, `uk.linkedin.com`, … — a 2-3 letter country prefix. */
const LINKEDIN_REGION_HOST = /^([a-z]{2,3})\.linkedin\.com$/;

export interface NormalizedLinkedIn {
  /** Canonical absolute URL used as the person dedupe key, or null. */
  readonly canonicalUrl: string | null;
  /** `in/<slug>` member identifier (lowercased), or null. */
  readonly memberSlug: string | null;
  /** True when the URL was a LinkedIn URL but no member slug could be parsed. */
  readonly isLinkedInButUnparsed: boolean;
  /** The host we resolved, when the input was a LinkedIn host. */
  readonly host: string | null;
}

const EMPTY_LINKEDIN: NormalizedLinkedIn = {
  canonicalUrl: null,
  memberSlug: null,
  isLinkedInButUnparsed: false,
  host: null,
};

/**
 * Parse any LinkedIn profile URL form into a canonical
 * `https://www.linkedin.com/in/<slug>` key.
 *
 * Handles:
 *   - missing protocol (`linkedin.com/in/x`)
 *   - `http` / `https` / protocol-relative
 *   - regional and mobile subdomains
 *   - query strings, fragments, trailing slashes
 *   - percent-encoded slugs
 *   - `/in/<slug>/detail/...` deep links and locale prefixes
 *   - `lnkd.in` short links (canonicalised as-is because they cannot be expanded
 *     offline; they are still treated as LinkedIn URLs but not used as the person
 *     dedupe key, which prevents two different short links colliding)
 */
export function normalizeLinkedInUrl(input: string | null | undefined): NormalizedLinkedIn {
  if (input === null || input === undefined) return EMPTY_LINKEDIN;
  let raw = collapseWhitespace(String(input));
  if (raw.length === 0) return EMPTY_LINKEDIN;

  // Strip a leading bullet/quote/angle characters that exporters prepend.
  raw = raw.replace(/^[<("'[\s]+/, '').replace(/[>)"'\]]+$/, '');
  if (raw.length === 0) return EMPTY_LINKEDIN;

  if (raw.startsWith('//')) raw = `https:${raw}`;

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return EMPTY_LINKEDIN;
  }

  const host = url.hostname.toLowerCase();
  const isRegionHost = LINKEDIN_REGION_HOST.test(host);
  if (!LINKEDIN_APEX_HOSTS.has(host) && !isRegionHost) {
    return EMPTY_LINKEDIN;
  }
  // `de.linkedin.com` and `linkedin.com` serve the same `/in/<slug>` namespace,
  // so a regional prefix must collapse to the same canonical key — otherwise the
  // same person imported from two locales would create two People.
  const normalizedHost = isRegionHost ? 'linkedin.com' : host.replace(/^(www|m|mobile)\./, '');
  if (normalizedHost === 'linkedin.cn') {
    // Chinese LinkedIn resolves /in/ slugs the same way.
  } else if (normalizedHost !== 'linkedin.com' && normalizedHost !== 'lnkd.in') {
    return EMPTY_LINKEDIN;
  }

  // Remove tracking params, then re-serialize with a stable param order.
  const params = new URLSearchParams(url.search);
  for (const key of TRACKING_PARAMS) params.delete(key);
  for (const key of [...params.keys()]) {
    if (/^(utm_|trk|lipi|lici)/i.test(key)) params.delete(key);
  }
  const remaining = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = remaining.length > 0 ? `?${new URLSearchParams(remaining).toString()}` : '';

  // Resolve the path, tolerating locale prefixes such as /de/in/<slug>.
  const segments = url.pathname
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const inIndex = segments.findIndex((s) => s.toLowerCase() === 'in');

  if (normalizedHost === 'lnkd.in') {
    // Short links cannot be expanded offline. Keep them usable as evidence but do
    // not treat them as the person dedupe key.
    const key = segments.join('/');
    return {
      canonicalUrl: key.length > 0 ? `https://lnkd.in/${key}` : 'https://lnkd.in/',
      memberSlug: null,
      isLinkedInButUnparsed: key.length === 0,
      host: normalizedHost,
    };
  }

  if (inIndex === -1 || segments.length <= inIndex + 1) {
    return {
      canonicalUrl: null,
      memberSlug: null,
      isLinkedInButUnparsed: true,
      host: normalizedHost,
    };
  }

  const rawSlug = segments[inIndex + 1] as string;
  let slug: string;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    slug = rawSlug;
  }
  slug = slug.trim().toLowerCase();
  // LinkedIn slugs use letters, digits, dashes and (legacy) underscores.
  slug = slug.replace(/[^a-z0-9\-_]/g, '');
  if (slug.length === 0) {
    return {
      canonicalUrl: null,
      memberSlug: null,
      isLinkedInButUnparsed: true,
      host: normalizedHost,
    };
  }

  return {
    canonicalUrl: `https://www.linkedin.com/in/${slug}${query}`,
    memberSlug: slug,
    isLinkedInButUnparsed: false,
    host: normalizedHost,
  };
}

/** Convenience: the canonical person dedupe key or null. */
export function normalizeLinkedInKey(input: string | null | undefined): string | null {
  return normalizeLinkedInUrl(input).canonicalUrl;
}

/* ---------------------------------------------------------------- domain -- */

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.jp',
  'or.jp',
  'ne.jp',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'com.mx',
  'com.tr',
  'com.sa',
  'com.ae',
  'com.pk',
  'com.bd',
  'com.sg',
  'com.hk',
  'com.tw',
  'co.in',
  'co.za',
  'co.kr',
  'com.cn',
  'gov.in',
  'ac.in',
  'edu.pk',
  'gov.pk',
  'co.il',
  'com.ng',
  'co.ke',
]);

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'proton.me',
  'gmx.com',
  'gmx.de',
  'mail.com',
  'web.de',
  't-online.de',
  'yandex.com',
  'zoho.com',
  'fastmail.com',
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
]);

export interface NormalizedDomain {
  /** Registrable-ish domain, lowercased, no `www.`, or null. */
  readonly domain: string | null;
  /** True when the domain is a consumer mailbox provider. */
  readonly isFreeMail: boolean;
  /** Bare hostname including subdomains (e.g. `careers.acme.com`). */
  readonly host: string | null;
}

const EMPTY_DOMAIN: NormalizedDomain = { domain: null, isFreeMail: false, host: null };

/**
 * Normalize a company domain from a bare domain, a URL, or an email address.
 * spec: "Normalized company domain is the strongest company dedupe key".
 */
export function normalizeDomain(input: string | null | undefined): NormalizedDomain {
  if (input === null || input === undefined) return EMPTY_DOMAIN;
  let raw = collapseWhitespace(String(input)).toLowerCase();
  if (raw.length === 0) return EMPTY_DOMAIN;

  // Pull the domain out of "Name <user@host>" or a plain email.
  const angleMatch = /<([^>]+)>/.exec(raw);
  const candidate = angleMatch?.[1] ?? raw;

  if (candidate.includes('@') && !candidate.includes('://')) {
    raw = candidate.slice(candidate.lastIndexOf('@') + 1);
  } else if (!candidate.includes('://')) {
    raw = candidate.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  }

  raw = raw.replace(/^\/\//, '');

  let host: string;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    host = url.hostname.toLowerCase();
  } catch {
    host = raw.split('/')[0]?.split('?')[0]?.split('#')[0] ?? '';
    host = host.toLowerCase();
  }

  host = host.replace(/\.$/, '');
  if (host.length === 0 || !host.includes('.')) return EMPTY_DOMAIN;
  if (host.includes('..')) return EMPTY_DOMAIN;

  const bare = host.replace(/^www\./, '');
  const parts = bare.split('.');
  if (parts.length < 2) return EMPTY_DOMAIN;

  const lastTwo = parts.slice(-2).join('.');
  let registrable = lastTwo;
  if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    registrable = parts.slice(-3).join('.');
  }

  return {
    domain: registrable,
    isFreeMail: FREE_MAIL_DOMAINS.has(bare),
    host: bare,
  };
}

/** Registrable company domain key, or null. */
export function normalizeDomainKey(input: string | null | undefined): string | null {
  const { domain, isFreeMail } = normalizeDomain(input);
  if (domain === null || isFreeMail) return null;
  return domain;
}

/* ------------------------------------------------------------------ phone */

/** E.164-ish phone normalization, used only for optional identity matching. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const digits = String(input).replace(/[^\d+]/g, '');
  if (digits.length === 0) return null;
  const plus = digits.startsWith('+');
  const body = digits.replace(/\+/g, '');
  if (body.length < 6 || body.length > 15) return null;
  return plus ? `+${body}` : body;
}

/* ------------------------------------------------------------------ email */

export function normalizeEmail(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const raw = collapseWhitespace(String(input)).toLowerCase();
  const match = /[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+/.exec(raw);
  if (!match) return null;
  return match[0];
}

/* ------------------------------------------------------------------- hash */

/**
 * Deterministic content hash of a raw payload.
 *
 * Spec requires "raw payload/content hash" on source evidence and
 * "idempotency key" on external ingestion. We canonicalize object key order
 * first so that two structurally identical payloads hash identically.
 */
export function contentHash(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

/** Canonical JSON: object keys sorted recursively, `undefined` dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return null;
}

/* ------------------------------------------------------------- sha256 ---- */

/*
 * Small, dependency-free SHA-256.
 *
 * Why not `node:crypto` / `crypto.subtle`? This module is imported by the
 * Chrome MV3 service worker (no `node:crypto`) and by Next.js server code. A
 * synchronous implementation keeps the API identical and avoids making every
 * caller async. It is used for content addressing only, never for secrets.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Hex-encoded SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  const bytes = utf8Bytes(input);
  const bitLen = bytes.length * 8;

  const withPadding = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  withPadding.set(bytes);
  withPadding[bytes.length] = 0x80;
  // 64-bit big-endian length; payloads here are far below 2^32 bits.
  const view = new DataView(withPadding.buffer);
  view.setUint32(withPadding.length - 4, bitLen >>> 0, false);
  view.setUint32(withPadding.length - 8, Math.floor(bitLen / 0x100000000), false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }

  let out = '';
  for (let i = 0; i < 8; i++) out += (h[i] as number).toString(16).padStart(8, '0');
  return out;
}

function utf8Bytes(input: string): Uint8Array {
  const encoded = encodeURIComponent(input);
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i] as string;
    if (ch === '%') {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0));
    }
  }
  return Uint8Array.from(bytes);
}

/* -------------------------------------------------------------- ids ------ */

/**
 * Deterministic idempotency key from source client + business + payload hash.
 * spec `api_contract.external_ingest.required_envelope` includes
 * `idempotency_key`, and `indexes_and_uniqueness` requires it to be unique per
 * source client/business.
 */
export function deriveIdempotencyKey(params: {
  sourceClient: string;
  businessKeyOrId: string;
  payloadType: string;
  payload: unknown;
  observedAt?: string | null;
}): string {
  return sha256Hex(
    canonicalJson({
      source_client: params.sourceClient,
      business: params.businessKeyOrId,
      payload_type: params.payloadType,
      payload: params.payload,
      observed_at: params.observedAt ?? null,
    }),
  );
}

/** Stable, human-scannable slug used for business URLs (`/b/:businessSlug/...`). */
export function slugify(input: string): string {
  return normalizeText(input)
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** Word count used by the messaging rules (Zemnas target 60–80 words). */
export function wordCount(input: string): number {
  const trimmed = collapseWhitespace(input);
  return trimmed.length === 0 ? 0 : trimmed.split(' ').length;
}
