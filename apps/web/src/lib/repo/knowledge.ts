/**
 * Knowledge library (screen A14).
 *
 * spec `screen_inventory` A14: "Portfolio, case studies, web pages, videos, approved
 * facts/tags, AI retrieval eligibility."
 *
 * Design notes tied to the spec:
 *   - `type` is restricted to `business_brain_and_knowledge.asset_types`, enforced by
 *     the `knowledge_assets_type_check` constraint and mirrored by
 *     `KNOWLEDGE_ASSET_TYPES` in `@nexus/core`.
 *   - spec `business_brain_and_knowledge.ingestion` gives the pipeline
 *     "fetch/parse -> structured extraction -> AI analysis -> tags/relevance ->
 *     human review -> approve -> retrieval eligible", so the approval workflow is a
 *     forward-moving pipeline with explicit back-steps rather than a free select.
 *   - spec `business_brain_and_knowledge.claim_policy`: "Outbound may use only
 *     approved factual claims. Never invent metrics/results." Retrieval eligibility
 *     is therefore exactly `ai_use_allowed and approval_state = 'approved'`, the same
 *     predicate `selectRelevantAssets` applies in `@nexus/core`.
 */
import 'server-only';

import { APPROVAL_STATES, KNOWLEDGE_ASSET_TYPES, type ApprovalState } from '@nexus/core';

import { withActor, type Actor, type Viewer } from '../actor';
import {
  nextApprovalStates,
  type AssetTagWeight,
  type KnowledgeAsset,
} from '../knowledge-view';
import type { Db, Row } from '../sql';
import {
  asBoolean,
  asIso,
  asNumber,
  asString,
  asStringArray,
  asStringOrNull,
  describeDbError,
  read,
  type MutationResult,
} from './common';

// The shapes, the approval pipeline and the claim-policy predicate are shared with the
// client components through `lib/knowledge-view.ts`.
export type { AssetTagWeight, KnowledgeAsset };
export { APPROVAL_TRANSITIONS, isRetrievalEligible, nextApprovalStates } from '../knowledge-view';

/* ------------------------------------------------------------ coercion --- */

function isApprovalState(value: string): value is ApprovalState {
  return (APPROVAL_STATES as readonly string[]).includes(value);
}

function isAssetType(value: string): value is (typeof KNOWLEDGE_ASSET_TYPES)[number] {
  return (KNOWLEDGE_ASSET_TYPES as readonly string[]).includes(value);
}

function mapAsset(row: Row): KnowledgeAsset {
  const state = asString(row.approval_state, 'draft');
  const type = asString(row.type, 'Other proof');
  return {
    id: asString(row.id),
    businessId: asString(row.business_id),
    type: isAssetType(type) ? type : 'Other proof',
    url: asStringOrNull(row.url),
    title: asStringOrNull(row.title),
    description: asStringOrNull(row.description),
    tags: asStringArray(row.tags),
    aiUseAllowed: asBoolean(row.ai_use_allowed),
    mayMentionClientName: asBoolean(row.may_mention_client_name),
    mayMentionNumericResults: asBoolean(row.may_mention_numeric_results),
    approvalState: isApprovalState(state) ? state : 'draft',
    currentVersionId: asStringOrNull(row.current_version_id),
    versionCount: asNumber(row.version_count),
    extractionCount: asNumber(row.extraction_count),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

const ASSET_SELECT = `
  select a.id, a.business_id, a.type, a.url, a.title, a.description, a.tags,
         a.ai_use_allowed, a.may_mention_client_name, a.may_mention_numeric_results,
         a.approval_state, a.current_version_id, a.created_at, a.updated_at,
         (select count(*) from public.knowledge_asset_versions v
           where v.asset_id = a.id) as version_count,
         (select count(*) from public.asset_extractions x
            join public.knowledge_asset_versions v2 on v2.id = x.asset_version_id
           where v2.asset_id = a.id) as extraction_count
    from public.knowledge_assets a
`;

/* ----------------------------------------------------------------- reads -- */

export async function listKnowledgeAssets(
  actor: Actor,
  businessId: string,
): Promise<readonly KnowledgeAsset[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `${ASSET_SELECT}
        where a.business_id = $1 and a.deleted_at is null
        order by a.approval_state, a.type, a.title nulls last, a.created_at desc`,
      [businessId],
    );
    return result.rows.map(mapAsset);
  });
}

export async function getKnowledgeAsset(
  actor: Actor,
  assetId: string,
): Promise<KnowledgeAsset | null> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `${ASSET_SELECT} where a.id = $1 and a.deleted_at is null`,
      [assetId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapAsset(row);
  });
}

/**
 * The weighted retrieval tags produced by extraction, shown read-only alongside the
 * operator-maintained `tags` list on the asset itself.
 */
export async function listAssetTagWeights(
  actor: Actor,
  businessId: string,
): Promise<readonly AssetTagWeight[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select t.asset_id, t.tag, t.weight
         from public.asset_tags t
         join public.knowledge_assets a on a.id = t.asset_id
        where a.business_id = $1 and a.deleted_at is null
        order by t.asset_id, t.weight desc, t.tag`,
      [businessId],
    );
    return result.rows.map((row: Row) => ({
      assetId: asString(row.asset_id),
      tag: asString(row.tag),
      weight: asNumber(row.weight, 1),
    }));
  });
}

/* ------------------------------------------------------------- mutations -- */

export interface KnowledgeAssetInput {
  readonly type: string;
  readonly url: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly aiUseAllowed: boolean;
  readonly mayMentionClientName: boolean;
  readonly mayMentionNumericResults: boolean;
}

/**
 * Keeps `asset_tags` in step with the asset's `tags` list.
 *
 * `asset_tags` is what retrieval actually weights, and `tags` is what the operator
 * edits, so the two must not be allowed to drift apart.
 */
async function syncAssetTags(sql: Db, assetId: string, tags: readonly string[]): Promise<void> {
  const clean = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
  await sql.query(`delete from public.asset_tags where asset_id = $1 and not (tag = any($2::text[]))`, [
    assetId,
    clean,
  ]);
  if (clean.length === 0) return;
  await sql.query(
    `insert into public.asset_tags (asset_id, tag, weight)
     select $1, t, 1 from unnest($2::text[]) as t
     on conflict (asset_id, tag) do nothing`,
    [assetId, clean],
  );
}

export async function createKnowledgeAsset(
  viewer: Viewer,
  businessId: string,
  input: KnowledgeAssetInput,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      // A new asset always starts as `draft`: nothing may be retrieval-eligible until
      // a human has approved it (spec `business_brain_and_knowledge.claim_policy`).
      const created = await sql.query<{ id: string }>(
        `insert into public.knowledge_assets
           (business_id, type, url, title, description, tags, ai_use_allowed,
            may_mention_client_name, may_mention_numeric_results, approval_state, created_by)
         values ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, 'draft', $10)
         returning id`,
        [
          businessId,
          input.type,
          input.url,
          input.title,
          input.description,
          [...input.tags],
          input.aiUseAllowed,
          input.mayMentionClientName,
          input.mayMentionNumericResults,
          viewer.userId,
        ],
      );
      const id = created.rows[0]?.id;
      if (id === undefined) return { ok: false, error: 'The asset was not saved.' };
      await syncAssetTags(sql, id, input.tags);
      return { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function updateKnowledgeAsset(
  viewer: Viewer,
  assetId: string,
  businessId: string,
  input: KnowledgeAssetInput,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `update public.knowledge_assets
            set type = $3,
                url = $4,
                title = $5,
                description = $6,
                tags = $7::text[],
                ai_use_allowed = $8,
                may_mention_client_name = $9,
                may_mention_numeric_results = $10,
                updated_at = now()
          where id = $1 and business_id = $2 and deleted_at is null`,
        [
          assetId,
          businessId,
          input.type,
          input.url,
          input.title,
          input.description,
          [...input.tags],
          input.aiUseAllowed,
          input.mayMentionClientName,
          input.mayMentionNumericResults,
        ],
      );
      if (result.affectedRows === 0) return { ok: false, error: 'That asset no longer exists.' };
      await syncAssetTags(sql, assetId, input.tags);
      return { ok: true, id: assetId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/**
 * Moves an asset along the approval pipeline.
 *
 * The transition table is checked here *and* the value is a parameter, so an
 * unrecognised state cannot reach the column even if the UI were bypassed.
 */
export async function setApprovalState(
  viewer: Viewer,
  assetId: string,
  next: ApprovalState,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const current = await sql.query<Row>(
        `select approval_state from public.knowledge_assets
          where id = $1 and deleted_at is null`,
        [assetId],
      );
      const row = current.rows[0];
      if (row === undefined) return { ok: false, error: 'That asset no longer exists.' };
      const state = asString(row.approval_state, 'draft');
      const from: ApprovalState = isApprovalState(state) ? state : 'draft';
      if (!nextApprovalStates(from).includes(next)) {
        return { ok: false, error: `An asset cannot move from ${from} to ${next}.` };
      }
      await sql.query(
        `update public.knowledge_assets
            set approval_state = $2, updated_at = now()
          where id = $1`,
        [assetId, next],
      );
      return { ok: true, id: assetId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/**
 * Soft delete. A rejected or superseded asset is normally kept so that the history of
 * what outbound was allowed to claim stays inspectable.
 */
export async function deleteKnowledgeAsset(viewer: Viewer, assetId: string): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `update public.knowledge_assets
            set deleted_at = now(), ai_use_allowed = false, updated_at = now()
          where id = $1 and deleted_at is null`,
        [assetId],
      );
      if (result.affectedRows === 0) return { ok: false, error: 'That asset no longer exists.' };
      return { ok: true, id: assetId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}
