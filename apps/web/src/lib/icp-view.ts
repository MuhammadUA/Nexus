/**
 * Client-safe ICP and scoring shapes (screen A12).
 *
 * `lib/repo/*` is server-only, so the types and vocabulary that a client component
 * needs live here instead. Keeping them in one module means the repository, the server
 * actions and the forms all describe the same records.
 */

export const ICP_PRIORITIES = ['low', 'normal', 'high'] as const;
export type IcpPriority = (typeof ICP_PRIORITIES)[number];

/** The typed view of `icps.criteria`. */
/**
 * The typed view of `icps.criteria`.
 *
 * Nullable fields accept `undefined` as well as `null`, deliberately: this shape is
 * stored as `jsonb` and read back with absent keys as often as explicit nulls, and a form
 * that omits an optional field produces `undefined`. Treating the two as the same absence
 * avoids every call site having to normalise one into the other.
 */
export interface IcpCriteria {
  readonly companyTypes?: readonly string[] | null;
  readonly markets?: readonly string[] | null;
  readonly companySizeMin?: number | null;
  readonly companySizeMax?: number | null;
  readonly buyerTitles?: readonly string[] | null;
  /** Signal kinds this ICP treats as evidence (spec `signals_and_scoring`). */
  readonly requiredSignals?: readonly string[] | null;
  readonly exclusions?: readonly string[] | null;
  readonly notes?: string | null;
}

/** The typed view of `icps.scoring_overrides`. */
export interface IcpScoringOverrides {
  /** Points added on top of the configured `scoring_rules` for this ICP. */
  readonly weights: Readonly<Record<string, number>>;
  /** Score at or above which a lead is considered a match. */
  readonly minScore?: number | null;
}

/** The typed view of `icps.routing`. */
export interface IcpRouting {
  readonly ownerUserId?: string | null;
  readonly outreachIdentityId?: string | null;
  readonly priority?: IcpPriority | null;
  readonly autoEnroll?: boolean | null;
}

export interface Icp {
  readonly id: string;
  readonly businessId: string;
  readonly name: string;
  readonly description: string | null;
  readonly criteria: IcpCriteria;
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly scoringOverrides: IcpScoringOverrides;
  readonly defaultSequenceId: string | null;
  readonly defaultSequenceName: string | null;
  readonly routing: IcpRouting;
  readonly primaryLeadCount: number;
  readonly secondaryMatchCount: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface ScoringRule {
  readonly id: string;
  readonly targetType: 'icp' | 'business' | 'global';
  readonly targetId: string | null;
  readonly targetLabel: string;
  readonly signalKind: string;
  readonly polarity: string;
  readonly points: number;
  readonly label: string | null;
  readonly isActive: boolean;
}
