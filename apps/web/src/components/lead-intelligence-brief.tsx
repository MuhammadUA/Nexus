import * as React from 'react';

/**
 * The V1.2 intelligence read model for Lead Detail — labels, the deterministic
 * confidence assessment, and the AI Opportunity Brief (§53) as a pure projection.
 *
 * Three rules shape this module, and all three are spec requirements rather than
 * preferences:
 *
 *   1. **No model call, ever.** §53.2: the brief is a projection of the current AI
 *      Context Pack and the committed `signals` rows. Rendering it must never reach a
 *      provider, so everything here is pure arithmetic over values the caller already
 *      read from the database.
 *   2. **Confidence is derived, not authored.** §53.5 forbids a model-authored
 *      confidence for the same reason §27.1 forbids a model-authored completeness
 *      score: it must be reproducible. `briefConfidence` is the only place a lead's
 *      confidence is computed, and `v1-2-lead-ui.test.ts` pins its output.
 *   3. **An empty brief says it is empty.** §53.4/§69.3: a brief with no Context Pack
 *      offers *refresh context* instead of pretending, and a brief with no signals says
 *      it has no signals. Nothing here invents a reason, a signal, a client name or a
 *      number.
 *
 * The `pack` body schema is an OPEN point in the spec (§59.6 names the column but not
 * the body), so the projection reads a *bounded* list of candidate keys and renders
 * "not stored yet" when none of them is present. That is the honest treatment of an
 * open schema: a projection over known keys, never a fabricated sentence.
 */
import {
  DISCOVERY_SOURCES,
  ENRICHMENT_STATES,
  LEGACY_SOURCE_TO_DISCOVERY,
  type DiscoverySource,
  type EnrichmentState,
  type OutreachChannel,
} from '@nexus/core';
import { Card, Chip, Row, Stack, type AccentName } from '@nexus/ui';

/* ------------------------------------------------------------------ labels -- */

/**
 * Human labels for the nine enrichment states (§14.1).
 *
 * Displayed beside the state, never replaced by colour: §75.2 requires the states to be
 * distinguishable without relying on colour alone.
 */
export const ENRICHMENT_STATE_LABELS: Readonly<Record<EnrichmentState, string>> = {
  MINIMAL: 'Minimal',
  NEEDS_PROFILE: 'Needs profile',
  PROFILE_READY: 'Profile ready',
  COMPANY_RESEARCH_PENDING: 'Company research pending',
  AGENT_RESEARCH_PENDING: 'Agent research pending',
  AI_PROCESSING: 'AI processing',
  READY: 'Ready',
  NEEDS_REVIEW: 'Needs review',
  FAILED: 'Failed',
};

export function enrichmentStateLabel(state: string): string {
  return ENRICHMENT_STATE_LABELS[state as EnrichmentState] ?? String(state).replace(/_/g, ' ');
}

/**
 * Accent per enrichment state, using only the design system's existing semantics:
 * cyan = in progress, green = ready, amber = waiting on a human or an agent, red = failed.
 */
export function enrichmentStateAccent(state: string): AccentName {
  switch (state) {
    case 'READY':
      return 'green';
    case 'NEEDS_REVIEW':
    case 'FAILED':
      return 'red';
    case 'COMPANY_RESEARCH_PENDING':
    case 'AGENT_RESEARCH_PENDING':
      return 'amber';
    case 'MINIMAL':
    case 'NEEDS_PROFILE':
    case 'PROFILE_READY':
    case 'AI_PROCESSING':
      return 'cyan';
    default:
      return 'neutral';
  }
}

/** The states the enrichment workspace is offered for (§69.1 item 4). */
export const INCOMPLETE_ENRICHMENT_STATES: readonly EnrichmentState[] = [
  'MINIMAL',
  'NEEDS_PROFILE',
  'FAILED',
  'NEEDS_REVIEW',
];

export function enrichmentIsIncomplete(state: string): boolean {
  return INCOMPLETE_ENRICHMENT_STATES.includes(state as EnrichmentState);
}

/** True when the value is one of the nine states, so a filter value is never invented. */
export function isEnrichmentState(value: string): value is EnrichmentState {
  return (ENRICHMENT_STATES as readonly string[]).includes(value);
}

/** The ten completeness components, as stable machine keys (§28.2) with their labels. */
export const COMPLETENESS_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'name',
  company: 'company',
  location: 'location',
  job_title: 'job title',
  linkedin: 'LinkedIn URL',
  company_website: 'company website',
  company_research: 'company research',
  signals: 'signals',
  ai_context: 'AI context',
  contacts: 'contact points',
};

/**
 * §29.1 — `Lead intelligence 35%`.
 *
 * §29.2 forbids rendering the score without its missing pieces when it is below 100, so
 * the two are produced together and `missingFieldsText` is always rendered beside it.
 */
export function intelligenceLabel(score: number): string {
  return `Lead intelligence ${String(clampScore(score))}%`;
}

/** §29.1 — `missing: linkedin, company research, signals`. */
export function missingFieldsText(missing: readonly string[]): string | null {
  if (missing.length === 0) return null;
  return `missing: ${missing.map((key) => COMPLETENESS_FIELD_LABELS[key] ?? key).join(', ')}`;
}

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(Math.max(Math.round(score), 0), 100);
}

/** Human labels for the V1.2 discovery sources (§18.1). */
export const DISCOVERY_SOURCE_LABELS: Readonly<Record<DiscoverySource, string>> = {
  linkedin: 'LinkedIn',
  upwork: 'Upwork',
  reddit: 'Reddit',
  job_board: 'Job board',
  youtube: 'YouTube',
  instagram: 'Instagram',
  company_website: 'Company website',
  google: 'Google',
  web: 'Web',
  apollo: 'Apollo',
  csv: 'CSV',
  paste: 'Paste',
  mcp: 'MCP',
  companion: 'Companion',
  manual: 'Manual',
  other: 'Other',
};

export function discoverySourceLabel(source: string): string {
  return DISCOVERY_SOURCE_LABELS[source as DiscoverySource] ?? String(source).replace(/_/g, ' ');
}

/** Human labels for the four outreach channels (§19.1). */
export const OUTREACH_CHANNEL_LABELS: Readonly<Record<OutreachChannel, string>> = {
  linkedin: 'LinkedIn',
  email: 'Email',
  instagram: 'Instagram',
  upwork: 'Upwork',
};

export function outreachChannelLabel(channel: string): string {
  return OUTREACH_CHANNEL_LABELS[channel as OutreachChannel] ?? String(channel);
}

/** Every discovery source, in vocabulary order, for the filter controls. */
export function discoverySourceOptions(): readonly { readonly value: DiscoverySource; readonly label: string }[] {
  return DISCOVERY_SOURCES.map((value) => ({ value, label: DISCOVERY_SOURCE_LABELS[value] }));
}

/**
 * The stored `leads.source_type` values that project onto one V1.2 discovery source.
 *
 * §18.3 leaves the V1.2 storage choice `> OPEN:` and the column still validates against the V1
 * vocabulary, so the source filter accepts **either** vocabulary: a stored `google_search` and
 * a stored `google` both match `?source=google`. That is the one honest way to filter on the
 * V1.2 dimension while the storage decision is unratified, and it keeps the existing Source
 * select — which sends legacy values — working unchanged.
 */
export function storedSourceValuesFor(discovery: DiscoverySource): readonly string[] {
  const values = new Set<string>([discovery]);
  for (const [legacy, mapped] of Object.entries(LEGACY_SOURCE_TO_DISCOVERY)) {
    if (mapped === discovery) values.add(legacy);
  }
  return [...values];
}

/* -------------------------------------------------------------- confidence -- */

export interface ConfidenceComponent {
  readonly key: string;
  readonly label: string;
  readonly points: number;
  readonly max: number;
}

export interface ConfidenceAssessment {
  /** 0–100, an integer. Reproducible from the same stored inputs (§53.5). */
  readonly score: number;
  readonly level: 'high' | 'medium' | 'low';
  /** Why the number is what it is, in component order. Never a model sentence. */
  readonly reasons: readonly string[];
  readonly components: readonly ConfidenceComponent[];
}

export interface ConfidenceInput {
  /** Active signals attached to the lead/person/company. */
  readonly signalCount: number;
  /** Mean strength of the *positive* signals, 0 when there are none. */
  readonly averagePositiveStrength: number;
  /** The lead's best ICP match score, 0–100, or null when nothing is qualified. */
  readonly icpFit: number | null;
  /** `lead_enrichment.completeness_score`, 0–100. */
  readonly completenessScore: number;
  /** Age of the Context Pack in days, or null when there is no pack. */
  readonly packAgeDays: number | null;
}

/**
 * Deterministic confidence for the opportunity brief.
 *
 * Five components, summing to at most 100, all read from stored rows:
 * signals 35 · signal strength 15 · ICP fit 20 · completeness 20 · pack recency 10.
 * A model is never asked for this number, and the same rows always produce it.
 */
export function briefConfidence(input: ConfidenceInput): ConfidenceAssessment {
  const components: ConfidenceComponent[] = [
    {
      key: 'signals',
      label: 'active signals',
      points: Math.min(Math.max(Math.trunc(input.signalCount), 0), 5) * 7,
      max: 35,
    },
    {
      key: 'signal_strength',
      label: 'signal strength',
      points:
        input.signalCount > 0 && input.averagePositiveStrength > 0
          ? Math.min(Math.round(input.averagePositiveStrength / 7), 15)
          : 0,
      max: 15,
    },
    {
      key: 'icp_fit',
      label: 'ICP fit',
      points: input.icpFit === null ? 0 : Math.min(Math.round(clampScore(input.icpFit) * 0.2), 20),
      max: 20,
    },
    {
      key: 'completeness',
      label: 'intelligence completeness',
      points: Math.min(Math.round(clampScore(input.completenessScore) * 0.2), 20),
      max: 20,
    },
    {
      key: 'pack_recency',
      label: 'context pack recency',
      points:
        input.packAgeDays === null ? 0 : input.packAgeDays <= 7 ? 10 : input.packAgeDays <= 30 ? 5 : 0,
      max: 10,
    },
  ];

  const score = clampScore(components.reduce((total, component) => total + component.points, 0));
  const level: ConfidenceAssessment['level'] = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low';

  return {
    score,
    level,
    reasons: components.map((component) =>
      component.points === 0 && component.key !== 'completeness'
        ? `no contribution from ${component.label}`
        : `${component.label} ${String(component.points)}/${String(component.max)}`,
    ),
    components,
  };
}

/* ------------------------------------------------------------------- brief -- */

export interface BriefSignal {
  readonly id: string;
  readonly kind: string;
  readonly label: string | null;
  readonly detail: string | null;
  readonly polarity: 'positive' | 'negative' | 'neutral';
  readonly strength: number;
  readonly observedAt: string;
  /** Permanent provenance allow-list (§32.3) — never a retained raw body. */
  readonly sourceUrl: string | null;
  readonly collectorAgent: string | null;
  readonly contentHash: string | null;
}

/** One evidence entry: the §54.2 allow-list, and nothing else. */
export interface EvidenceEntry {
  readonly id: string;
  readonly label: string;
  readonly sourceType: string | null;
  readonly sourceUrl: string | null;
  readonly observedAt: string | null;
  readonly contentHash: string | null;
  readonly collectorAgent: string | null;
  readonly agentJobId: string | null;
  readonly promptVersion: string | null;
  readonly model: string | null;
  readonly extractedAt: string | null;
}

export interface BriefPack {
  readonly version: number;
  readonly createdAt: string;
  readonly model: string | null;
  readonly promptKey: string | null;
  readonly promptVersion: number | null;
  /** The pack's own optional angle/recommendation, when the OPEN body carries one. */
  readonly angle: string | null;
  readonly recommendation: string | null;
  /** Flattened scalar entries from `source_summary` — short structured values only. */
  readonly summary: readonly { readonly key: string; readonly value: string }[];
}

export interface BriefInput {
  readonly leadName: string;
  readonly leadTitle: string | null;
  readonly companyName: string | null;
  readonly primaryIcpName: string | null;
  readonly icpFit: number | null;
  readonly icpReason: string | null;
  readonly completenessScore: number;
  readonly missingFields: readonly string[];
  readonly signals: readonly BriefSignal[];
  readonly pack: BriefPack | null;
  readonly availableChannels: readonly OutreachChannel[];
  readonly now: Date;
}

export interface OpportunityBrief {
  /**
   * `no_context` — no Context Pack exists yet, so the brief offers *refresh context*
   * rather than showing an empty shell.
   * `no_signals` — a pack exists but no active signal justifies contact.
   * `ready` — a pack and at least one signal.
   */
  readonly state: 'no_context' | 'no_signals' | 'ready';
  readonly headline: string;
  readonly why: string;
  readonly angle: string | null;
  readonly confidence: ConfidenceAssessment;
  readonly signals: readonly BriefSignal[];
  readonly pack: BriefPack | null;
}

/** Positive signals only, for the strength component. */
export function averagePositiveStrength(signals: readonly BriefSignal[]): number {
  const positive = signals.filter((signal) => signal.polarity === 'positive');
  if (positive.length === 0) return 0;
  const total = positive.reduce((sum, signal) => sum + signal.strength, 0);
  return total / positive.length;
}

/**
 * Builds the brief from stored rows.
 *
 * `why` is assembled from committed facts only: the ICP the lead was qualified against and
 * the recorded reason, the person's role and company, and the count of signals. When
 * nothing is recorded the sentence says so.
 */
export function buildOpportunityBrief(input: BriefInput): OpportunityBrief {
  const positive = input.signals.filter((signal) => signal.polarity === 'positive').length;
  const confidence = briefConfidence({
    signalCount: input.signals.length,
    averagePositiveStrength: averagePositiveStrength(input.signals),
    icpFit: input.icpFit,
    completenessScore: input.completenessScore,
    packAgeDays: input.pack === null ? null : ageInDays(input.pack.createdAt, input.now),
  });

  const pieces: string[] = [];
  pieces.push(
    input.companyName === null
      ? `${input.leadName} has no company recorded`
      : `${input.leadName}${input.leadTitle === null ? '' : `, ${input.leadTitle}`} at ${input.companyName}`,
  );
  pieces.push(
    input.primaryIcpName === null
      ? 'no primary ICP is recorded'
      : `primary ICP ${input.primaryIcpName}${input.icpFit === null ? '' : ` at fit ${String(input.icpFit)}`}`,
  );
  if (input.signals.length === 0) {
    pieces.push('no active signals are recorded');
  } else {
    pieces.push(
      `${String(input.signals.length)} active signal${input.signals.length === 1 ? '' : 's'}${
        positive === 0 ? ' (none positive)' : `, ${String(positive)} positive`
      }`,
    );
  }
  pieces.push(`${intelligenceLabel(input.completenessScore)}`);

  const why = `${pieces.join(' · ')}.${input.icpReason === null ? '' : ` Qualification: ${input.icpReason}`}`;

  const state: OpportunityBrief['state'] =
    input.pack === null ? 'no_context' : input.signals.length === 0 ? 'no_signals' : 'ready';

  const headline =
    state === 'no_context'
      ? 'No AI context pack yet'
      : state === 'no_signals'
        ? 'Context ready — no signals recorded'
        : (input.pack?.recommendation ?? `Opportunity for ${input.primaryIcpName ?? input.companyName ?? input.leadName}`);

  // `> OPEN:` §59.6 does not freeze the pack body. Only these two names are projected, and
  // an absent key renders as "not stored yet" rather than an invented recommendation.
  const angle = input.pack?.angle ?? null;

  return { state, headline, why, angle, confidence, signals: input.signals, pack: input.pack };
}

export function ageInDays(iso: string, now: Date): number | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const days = (now.getTime() - at.getTime()) / 86_400_000;
  return days < 0 ? 0 : Math.floor(days);
}

/**
 * A string from the Context Pack body, over a **bounded** list of candidate keys.
 *
 * §59.6 leaves the pack body schema OPEN — the spec names the column and not its shape — so a
 * projection has exactly two honest options: read a key it knows, or say nothing. Nested values are
 * accepted only when they carry an obvious scalar field, and an unrecognised shape yields `null`,
 * which the brief renders as "no recommended angle is stored yet" rather than as an invented
 * sentence. This is deliberately not a general-purpose reader: widening it is how a UI starts
 * presenting a guess as a fact.
 */
export function readPackString(pack: unknown, keys: readonly string[]): string | null {
  if (typeof pack !== 'object' || pack === null) return null;
  const record = pack as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'object' && value !== null) {
      const nested = value as Record<string, unknown>;
      for (const field of ['text', 'label', 'name', 'value', 'summary']) {
        const candidate = nested[field];
        if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
      }
    }
  }
  return null;
}

/**
 * `source_summary` (and any pack body) flattened into short structured values.
 *
 * Scalars are shown, arrays are shown as a count, and nested objects are skipped: a UI cannot
 * summarise an unknown structure without inventing one, and a count is a fact where a paraphrase
 * would not be. Bounded, so a pack can never turn this into a dump.
 */
export function flattenPackSummary(
  summary: unknown,
  limit = 12,
): readonly { readonly key: string; readonly value: string }[] {
  if (typeof summary !== 'object' || summary === null) return [];
  const out: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(summary as Record<string, unknown>)) {
    if (out.length >= limit) break;
    if (typeof value === 'string') {
      out.push({ key, value: value.length > 200 ? `${value.slice(0, 200)}…` : value });
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out.push({ key, value: String(value) });
    } else if (Array.isArray(value)) {
      out.push({ key, value: `${String(value.length)} entries` });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- rendering -- */

/** §29.1/§29.2 — the score always travels with the missing pieces named. */
export function IntelligenceMeter({
  score,
  missingFields,
}: {
  readonly score: number;
  readonly missingFields: readonly string[];
}): React.ReactElement {
  const missing = missingFieldsText(missingFields);
  return (
    <div className="nx-intel-meter">
      <div
        className="nx-intel-meter__track"
        role="img"
        aria-label={`${intelligenceLabel(score)}${missing === null ? '' : `, ${missing}`}`}
      >
        <span className="nx-intel-meter__fill" style={{ width: `${String(clampScore(score))}%` }} />
      </div>
      <span className="nx-intel-meter__value">{intelligenceLabel(score)}</span>
      {missing !== null && <span className="nx-hint">{missing}</span>}
      {missing === null && <span className="nx-hint">every component present</span>}
    </div>
  );
}

function SignalRow({ signal }: { readonly signal: BriefSignal }): React.ReactElement {
  return (
    <li className="nx-brief__signal">
      <Row wrap between>
        <Row wrap>
          <Chip
            accent={signal.polarity === 'positive' ? 'green' : signal.polarity === 'negative' ? 'red' : 'neutral'}
            dataState={signal.polarity}
          >
            {signal.kind.replace(/_/g, ' ')}
          </Chip>
          <span>{signal.label ?? signal.detail ?? 'Signal recorded'}</span>
        </Row>
        <Row wrap>
          <span className="nx-hint">strength {String(signal.strength)}</span>
          <span className="nx-hint nx-table__mono">{signal.observedAt.slice(0, 10)}</span>
          {signal.sourceUrl !== null && (
            <a
              className="nx-hint"
              href={signal.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              source
            </a>
          )}
        </Row>
      </Row>
    </li>
  );
}

/** The evidence list: the permanent allow-list, never a raw body (§54.2/§54.3). */
export function EvidenceDisclosure({ entries }: { readonly entries: readonly EvidenceEntry[] }): React.ReactElement {
  return (
    <details className="nx-evidence">
      <summary className="nx-evidence__summary">View evidence ({String(entries.length)})</summary>
      {entries.length === 0 ? (
        <p className="nx-hint">
          No evidence rows are recorded for this lead yet. A claim with no evidence is unproven.
        </p>
      ) : (
        <ul className="nx-evidence__list">
          {entries.map((entry) => (
            <li key={entry.id} className="nx-evidence__item">
              <Row wrap>
                <strong>{entry.label}</strong>
                {entry.sourceType !== null && <Chip accent="indigo">{entry.sourceType}</Chip>}
                {entry.model !== null && <Chip>{entry.model}</Chip>}
                {entry.promptVersion !== null && <Chip>prompt {entry.promptVersion}</Chip>}
              </Row>
              <dl className="nx-evidence__meta">
                <div>
                  <dt>source URL</dt>
                  <dd>
                    {entry.sourceUrl === null ? (
                      'not recorded'
                    ) : (
                      <a href={entry.sourceUrl} target="_blank" rel="noopener noreferrer">
                        {entry.sourceUrl}
                      </a>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>observed</dt>
                  <dd className="nx-table__mono">{entry.observedAt?.slice(0, 19).replace('T', ' ') ?? '—'}</dd>
                </div>
                <div>
                  <dt>content hash</dt>
                  <dd className="nx-table__mono">{entry.contentHash ?? '—'}</dd>
                </div>
                <div>
                  <dt>collector agent</dt>
                  <dd>{entry.collectorAgent ?? '—'}</dd>
                </div>
                <div>
                  <dt>agent job</dt>
                  <dd className="nx-table__mono">{entry.agentJobId ?? '—'}</dd>
                </div>
                <div>
                  <dt>extracted</dt>
                  <dd className="nx-table__mono">{entry.extractedAt?.slice(0, 19).replace('T', ' ') ?? '—'}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
      <p className="nx-hint">
        Raw bodies are deleted after the structured commit; only this metadata remains.
      </p>
    </details>
  );
}

export interface LeadIntelligenceBriefProps {
  readonly brief: OpportunityBrief;
  readonly evidence: readonly EvidenceEntry[];
  /** Slot for *refresh context* — a client control, so it stays out of this module. */
  readonly refreshAction?: React.ReactNode;
}

/**
 * §69.1 item 2 / §53 — the AI Opportunity Brief.
 *
 * It is rendered below nothing except the header, and it never asserts more than the rows
 * behind it support: with no pack it offers the action that would produce one, and with no
 * signals it says there are none.
 */
export function LeadIntelligenceBrief({
  brief,
  evidence,
  refreshAction,
}: LeadIntelligenceBriefProps): React.ReactElement {
  return (
    <Card
      title="AI opportunity brief"
      actions={
        <Row wrap>
          <Chip accent={confidenceAccent(brief.confidence.level)} dataState={brief.confidence.level}>
            confidence {brief.confidence.level} · {String(brief.confidence.score)}
          </Chip>
          {brief.pack !== null && <Chip accent="neutral">pack v{String(brief.pack.version)}</Chip>}
          {refreshAction}
        </Row>
      }
    >
      <Stack>
        <div className="nx-brief__headline">
          <strong>{brief.headline}</strong>
          {brief.pack !== null && (
            <span className="nx-hint">
              built {brief.pack.createdAt.slice(0, 16).replace('T', ' ')}
              {brief.pack.model === null ? '' : ` · ${brief.pack.model}`}
              {brief.pack.promptKey === null
                ? ''
                : ` · ${brief.pack.promptKey}${brief.pack.promptVersion === null ? '' : ` v${String(brief.pack.promptVersion)}`}`}
            </span>
          )}
        </div>

        <div>
          <span className="nx-overline">Why this lead</span>
          <p className="nx-brief__why">{brief.why}</p>
        </div>

        {brief.state === 'no_context' ? (
          <p className="nx-hint">
            No Context Pack version exists for this lead, so there is no brief to show. Building one
            reads the committed facts and signals — it never runs on page render.
          </p>
        ) : null}

        <div>
          <span className="nx-overline">Signals</span>
          {brief.signals.length === 0 ? (
            <p className="nx-hint">
              No active signals are recorded for this lead. This brief shows no reason because none
              is stored.
            </p>
          ) : (
            <ul className="nx-brief__signals">
              {brief.signals.map((signal) => (
                <SignalRow key={signal.id} signal={signal} />
              ))}
            </ul>
          )}
        </div>

        <div>
          <span className="nx-overline">Recommended angle</span>
          {brief.angle === null ? (
            <p className="nx-hint">
              No recommended angle is stored yet. The Context Pack body does not name one, and this
              screen will not invent one.
            </p>
          ) : (
            <p>{brief.angle}</p>
          )}
        </div>

        {brief.pack !== null && brief.pack.summary.length > 0 && (
          <div>
            <span className="nx-overline">Context summary</span>
            <dl className="nx-brief__summary">
              {brief.pack.summary.map((entry) => (
                <div key={entry.key}>
                  <dt>{entry.key.replace(/_/g, ' ')}</dt>
                  <dd>{entry.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <div>
          <span className="nx-overline">Confidence</span>
          <Row wrap>
            <Chip accent={confidenceAccent(brief.confidence.level)}>
              {brief.confidence.level} · {String(brief.confidence.score)}/100
            </Chip>
            <span className="nx-hint">derived from stored facts, never authored by a model</span>
          </Row>
          <ul className="nx-brief__reasons">
            {brief.confidence.reasons.map((reason) => (
              <li key={reason} className="nx-hint">
                {reason}
              </li>
            ))}
          </ul>
        </div>

        <EvidenceDisclosure entries={evidence} />
      </Stack>
    </Card>
  );
}

function confidenceAccent(level: ConfidenceAssessment['level']): AccentName {
  return level === 'high' ? 'green' : level === 'medium' ? 'amber' : 'neutral';
}
