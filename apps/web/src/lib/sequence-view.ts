/**
 * Client-safe sequence shapes and vocabulary (screen A13).
 *
 * `lib/repo/*` is server-only, so the types a client component needs live here. The
 * vocabularies mirror the CHECK constraints in `0007_sequences.sql` exactly.
 */
import type { DelayBasis, SequenceStepKind } from '@nexus/core';

export const SEQUENCE_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];

export const SEQUENCE_VERSION_STATUSES = ['draft', 'published', 'archived'] as const;
export type SequenceVersionStatus = (typeof SEQUENCE_VERSION_STATUSES)[number];

/** Mirrors `sequence_steps_generation_mode_check`: ai | manual | hybrid. */
export const GENERATION_MODES = ['ai', 'manual', 'hybrid'] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

/** spec `sequence_engine.sequence_step_instruction_fields` (proof_policy). */
export const PROOF_POLICIES = ['approved_only', 'none_required', 'required'] as const;
export type ProofPolicy = (typeof PROOF_POLICIES)[number];

export interface SequenceSummary {
  readonly id: string;
  readonly businessId: string;
  readonly name: string;
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly status: string;
  readonly currentVersionId: string | null;
  readonly currentVersion: number | null;
  readonly currentVersionStatus: string | null;
  readonly versionCount: number;
  readonly publishedVersionCount: number;
  readonly stepCount: number;
  readonly activeEnrollments: number;
  readonly dormantEnrollments: number;
  readonly updatedAt: string | null;
}

export interface SequenceStep {
  readonly id: string;
  readonly sequenceVersionId: string;
  readonly stepOrder: number;
  readonly kind: SequenceStepKind;
  readonly name: string;
  readonly delayDays: number;
  readonly delayBasis: DelayBasis;
  readonly goal: string | null;
  readonly allowedContext: readonly string[];
  readonly wordMax: number | null;
  readonly ctaStyle: string | null;
  readonly prohibitedPhrases: readonly string[];
  readonly proofPolicy: string | null;
  readonly tone: string | null;
  readonly generationMode: string;
  readonly isActive: boolean;
}

/** The subset of `sequence_versions.impact_preview` the publish RPC writes. */
export interface StoredImpactPreview {
  readonly sentUntouched: number | null;
  readonly lockedUntouched: number | null;
  readonly dynamicNeedsRegeneration: number | null;
  readonly enrollmentsMoved: number | null;
  readonly publishedAt: string | null;
}

export interface SequenceVersion {
  readonly id: string;
  readonly sequenceId: string;
  readonly version: number;
  readonly status: string;
  readonly publishedAt: string | null;
  readonly publishedByName: string | null;
  readonly changeSummary: string | null;
  readonly impactPreview: StoredImpactPreview;
  readonly enrollmentCount: number;
  readonly createdAt: string | null;
  readonly steps: readonly SequenceStep[];
}
