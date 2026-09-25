/**
 * The AI provider boundary.
 *
 * One narrow interface, so the prompt construction, retrieval and claim checking that already exist
 * in `@nexus/core` stay exactly as they are and only the *transport* is new. A caller asks for a
 * JSON completion against a Zod schema and gets back either validated data or a typed failure; it
 * never sees an HTTP response, a retry, or a model's raw text.
 *
 * The failure vocabulary is closed and total. An AI call has many ways to go wrong — no key, a
 * timeout, a rate limit, a 5xx, a 4xx, unparseable JSON, valid JSON that violates the schema — and a
 * caller that cannot distinguish them ends up either retrying a permanent failure or discarding a
 * recoverable one. `kind` is what a caller branches on; `retryable` says whether trying again could
 * help at all.
 */
import 'server-only';

import type { z } from 'zod';

export type AiFailureKind =
  | 'provider_not_configured'
  | 'unauthorized'
  | 'rate_limited'
  | 'timeout'
  | 'provider_unavailable'
  | 'invalid_request'
  | 'malformed_json'
  | 'schema_invalid'
  | 'empty_response';

export interface AiFailure {
  readonly ok: false;
  readonly kind: AiFailureKind;
  /** Operator-safe sentence. Never contains a key, and never a raw upstream body. */
  readonly error: string;
  /** Whether another attempt could plausibly succeed. */
  readonly retryable: boolean;
  readonly status: number | null;
  /** Zod issues, when the failure was a schema violation. Field paths only. */
  readonly issues?: readonly string[];
}

export interface AiSuccess<T> {
  readonly ok: true;
  readonly data: T;
  /** Provenance for the row this output will become. */
  readonly provenance: {
    readonly provider: 'deepseek';
    readonly model: string;
    readonly promptVersionId: string | null;
    /** The attempt that succeeded; 1 for a first-try success. */
    readonly attempts: number;
    readonly latencyMs: number;
    /** Token counts when the provider reports them, for cost visibility. */
    readonly usage: { readonly promptTokens: number; readonly completionTokens: number } | null;
  };
}

export type AiResult<T> = AiSuccess<T> | AiFailure;

export interface AiJsonRequest<Schema extends z.ZodTypeAny> {
  /** System instruction. Comes from the prompt builder in `@nexus/core`. */
  readonly system: string;
  /** User content. Untrusted: it may be pasted profile text or scraped page content. */
  readonly user: string;
  /** The answer must satisfy this. Applied before the caller ever sees the value. */
  readonly schema: Schema;
  /** Recorded on the result so a stored message can name the prompt that produced it. */
  readonly promptVersionId?: string | null;
  /** Upper bound on generated tokens. */
  readonly maxTokens?: number;
  /** 0 for extraction tasks, where variety is a defect rather than a feature. */
  readonly temperature?: number;
  /** Free-form label for logs and metrics: `profile_extraction`, `message_draft`, … */
  readonly operation: string;
}

/**
 * What a caller depends on. Kept as an interface so a test can substitute a deterministic provider
 * without touching the network, and so a second provider does not require changing call sites.
 */
export interface AiProvider {
  readonly name: 'deepseek';
  readonly model: string;
  readonly configured: boolean;
  complete<Schema extends z.ZodTypeAny>(request: AiJsonRequest<Schema>): Promise<AiResult<z.infer<Schema>>>;
}
