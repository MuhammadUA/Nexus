/**
 * Presentation for the V1.2 enrichment indicator (spec §36).
 *
 * The *values* are the server's: `enrichmentStatus` is `public.lead_enrichment.status`
 * and `intelligence` is its `completeness_score`. This module only chooses a label and
 * a colour, so the panel never re-derives a score or a pipeline state — a second
 * derivation would disagree with the pipeline that owns them and with the AI context
 * built from them.
 *
 * The vocabulary is `ENRICHMENT_STATES` in `@nexus/core`. It is duplicated here as a
 * *label table* only, deliberately: the extension's only contract with the server is
 * the wire payload, so an unrecognised (future) state renders as itself rather than
 * crashing or being silently remapped.
 */
import type { AccentName } from '@nexus/ui';

interface EnrichmentPresentation {
  readonly label: string;
  readonly accent: AccentName;
}

const ENRICHMENT_PRESENTATION: Readonly<Record<string, EnrichmentPresentation>> = {
  MINIMAL: { label: 'not started', accent: 'neutral' },
  NEEDS_PROFILE: { label: 'needs profile', accent: 'cyan' },
  PROFILE_READY: { label: 'profile ready', accent: 'indigo' },
  COMPANY_RESEARCH_PENDING: { label: 'company research', accent: 'amber' },
  AGENT_RESEARCH_PENDING: { label: 'research queued', accent: 'amber' },
  AI_PROCESSING: { label: 'AI processing', accent: 'indigo' },
  READY: { label: 'ready', accent: 'green' },
  NEEDS_REVIEW: { label: 'needs review', accent: 'amber' },
  FAILED: { label: 'failed', accent: 'red' },
};

/**
 * The chip's label for a state.
 *
 * The parameter is typed `unknown` on purpose: the value arrives from a JSON payload,
 * so a payload that omits it (or a projection that renames it) must degrade to a
 * neutral chip rather than throwing inside render — a throw here unmounts the whole
 * panel, which is exactly what a shape mismatch between two Companion projections did
 * before this was hardened.
 */
export function enrichmentLabel(status: unknown): string {
  if (typeof status !== 'string' || status.length === 0) return ENRICHMENT_PRESENTATION.MINIMAL?.label ?? 'not started';
  return ENRICHMENT_PRESENTATION[status]?.label ?? status.toLowerCase().replace(/_/g, ' ');
}

export function enrichmentAccent(status: unknown): AccentName {
  if (typeof status !== 'string') return 'neutral';
  return ENRICHMENT_PRESENTATION[status]?.accent ?? 'neutral';
}

/** `completeness_score` rendered as a percentage. Clamped for display only. */
export function intelligenceLabel(intelligence: unknown): string {
  const value = typeof intelligence === 'number' ? intelligence : Number(intelligence);
  const bounded = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.trunc(value))) : 0;
  return `${String(bounded)}%`;
}

/**
 * Whether this lead still needs the generated-search fallback.
 *
 * True for a lead with no profile URL — the state a minimal capture lands in. The URL
 * itself is never built here: the server sends it from `searchLinks` in `@nexus/core`,
 * so there is exactly one definition of what "Find LinkedIn" searches for.
 */
export function needsFindLinkedIn(lead: {
  readonly needsProfile?: boolean;
  readonly linkedinUrl?: string | null;
  readonly enrichmentStatus?: string;
  readonly findLinkedInUrl?: string | null;
}): boolean {
  if (typeof lead.findLinkedInUrl !== 'string' || lead.findLinkedInUrl.length === 0) return false;
  if (typeof lead.linkedinUrl === 'string' && lead.linkedinUrl.length > 0) return false;
  return lead.needsProfile === true || lead.enrichmentStatus === 'NEEDS_PROFILE' || lead.enrichmentStatus === 'MINIMAL';
}
