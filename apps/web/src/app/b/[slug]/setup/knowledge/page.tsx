import type { ReactNode } from 'react';

import { APPROVAL_STATES, KNOWLEDGE_ASSET_TYPES } from '@nexus/core';
import {
  Alert,
  Card,
  Chip,
  DataTable,
  Grid,
  PageHead,
  Row,
  Stack,
  Stat,
  type Column,
} from '@nexus/ui';
import { notFound } from 'next/navigation';

import {
  AssetApprovalActions,
  DeleteAssetAction,
  KnowledgeAssetForm,
} from '@/components/knowledge-forms';
import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import {
  getKnowledgeAsset,
  isRetrievalEligible,
  listAssetTagWeights,
  listKnowledgeAssets,
  nextApprovalStates,
  type AssetTagWeight,
  type KnowledgeAsset,
} from '@/lib/repo/knowledge';

export const dynamic = 'force-dynamic';

/**
 * A14 — Knowledge Library.
 *
 * Contract: "Portfolio, case studies, web pages, videos, approved facts/tags, AI
 * retrieval eligibility."
 *
 * The screen is built around one rule from spec
 * `business_brain_and_knowledge.claim_policy`: outbound may use only approved factual
 * claims and must never invent metrics, clients or results. Retrieval eligibility is
 * therefore shown explicitly as `ai_use_allowed and approval_state = 'approved'`.
 */
export default async function KnowledgeLibraryPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { slug } = await params;
  const query = await searchParams;

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  // Business-scoped configuration: judged against this business's grant alone.
  requireRouteAccess(context, { route: '/b/:businessSlug/setup/knowledge', businessId: business.id });

  const actor = context.viewer.actor;
  const basePath = `/b/${business.key}/setup/knowledge`;
  const selectedAssetId = firstParam(query.asset);
  const stateFilter = firstParam(query.state);

  const [assets, tagWeights, selectedAsset] = await Promise.all([
    listKnowledgeAssets(actor, business.id),
    listAssetTagWeights(actor, business.id),
    selectedAssetId === null ? Promise.resolve(null) : getKnowledgeAsset(actor, selectedAssetId),
  ]);

  const canManage = context.permissions.has('knowledge.manage');

  const eligible = assets.filter((asset) => isRetrievalEligible(asset));
  const awaitingReview = assets.filter(
    (asset) => asset.approvalState === 'needs_review' || asset.approvalState === 'extracting',
  );
  const approvedButNotAllowed = assets.filter(
    (asset) => asset.approvalState === 'approved' && !asset.aiUseAllowed,
  );

  const filtered =
    stateFilter === null ? assets : assets.filter((asset) => asset.approvalState === stateFilter);

  const countFor = (state: string): number =>
    assets.filter((asset) => asset.approvalState === state).length;

  const assetColumns: readonly Column<KnowledgeAsset>[] = [
    {
      key: 'title',
      header: 'Asset',
      cell: (asset) => (
        <Stack size="sm">
          <Row wrap>
            <span>{asset.title ?? asset.url ?? 'Untitled asset'}</span>
            {isRetrievalEligible(asset) && <Chip accent="green">retrieval-eligible</Chip>}
          </Row>
          {asset.url !== null && (
            <a className="nx-hint" href={asset.url} target="_blank" rel="noreferrer noopener">
              {asset.url}
            </a>
          )}
          {asset.description !== null && <span className="nx-hint">{asset.description}</span>}
        </Stack>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      cell: (asset) => <Chip accent="indigo">{asset.type}</Chip>,
    },
    {
      key: 'approval',
      header: 'Approval',
      cell: (asset) => (
        <Chip accent={approvalAccent(asset.approvalState)}>{asset.approvalState.replace(/_/g, ' ')}</Chip>
      ),
    },
    {
      key: 'ai',
      header: 'AI use · client · numbers',
      cell: (asset) => (
        <Row wrap>
          <Chip accent={asset.aiUseAllowed ? 'cyan' : 'neutral'}>
            {asset.aiUseAllowed ? 'AI may use' : 'AI off'}
          </Chip>
          <Chip accent={asset.mayMentionClientName ? 'green' : 'neutral'}>
            {asset.mayMentionClientName ? 'client name ok' : 'no client name'}
          </Chip>
          <Chip accent={asset.mayMentionNumericResults ? 'green' : 'neutral'}>
            {asset.mayMentionNumericResults ? 'numbers ok' : 'no numbers'}
          </Chip>
        </Row>
      ),
    },
    {
      key: 'tags',
      header: 'Tags',
      cell: (asset) =>
        asset.tags.length === 0 ? (
          <span className="nx-hint">no tags</span>
        ) : (
          <Row wrap>
            {asset.tags.slice(0, 4).map((tag) => (
              <Chip key={tag}>{tag}</Chip>
            ))}
            {asset.tags.length > 4 && (
              <Chip accent="neutral">{`+${String(asset.tags.length - 4)}`}</Chip>
            )}
          </Row>
        ),
    },
    {
      key: 'versions',
      header: 'Versions',
      numeric: true,
      cell: (asset) => asset.versionCount,
    },
    {
      key: 'extractions',
      header: 'Extractions',
      numeric: true,
      cell: (asset) => asset.extractionCount,
    },
    {
      key: 'actions',
      header: '',
      cell: (asset) => (
        <a className="nx-btn nx-btn--secondary nx-btn--sm" href={`${basePath}?asset=${asset.id}`}>
          Open
        </a>
      ),
    },
  ];

  const tagColumns: readonly Column<AssetTagWeight>[] = [
    { key: 'tag', header: 'Tag', cell: (row) => <Chip accent="cyan">{row.tag}</Chip> },
    { key: 'weight', header: 'Retrieval weight', numeric: true, cell: (row) => row.weight },
    {
      key: 'asset',
      header: 'Asset',
      cell: (row) => (
        <span className="nx-hint">
          {assets.find((asset) => asset.id === row.assetId)?.title ?? row.assetId.slice(0, 8)}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHead
        subtitle={`${business.name} · portfolio, case studies, web pages, videos and approved claims`}
        actions={
          <Row wrap>
            <Chip accent="indigo">configuration</Chip>
            <Chip accent="green">{`${String(eligible.length)} retrieval-eligible`}</Chip>
          </Row>
        }
      >
        Knowledge Library
      </PageHead>

      <Alert accent="indigo" title="Claim policy">
        Outbound AI may use only approved factual claims, and must never invent metrics, clients or
        results. An asset is retrieval-eligible only when <span className="nx-table__mono">
          ai_use_allowed
        </span>{' '}
        is on <em>and</em> its approval state is <strong>approved</strong>; everything else is context
        for a human, not material for a draft. Approval is a human step: a new asset starts as a draft
        and is never eligible on the way in.
      </Alert>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid cols={4}>
        <Stat value={assets.length} label="Assets" meta={`${String(eligible.length)} eligible`} />
        <Stat
          value={awaitingReview.length}
          label="Awaiting review"
          meta="extracting or needs review"
        />
        <Stat
          value={countFor('approved')}
          label="Approved"
          meta={
            approvedButNotAllowed.length === 0
              ? 'all approved assets may be used'
              : `${String(approvedButNotAllowed.length)} with AI use switched off`
          }
        />
        <Stat
          value={countFor('rejected') + countFor('superseded')}
          label="Rejected or superseded"
          meta="kept for audit"
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card
        title="Assets"
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--ghost nx-btn--sm" href={basePath}>
              All ({assets.length})
            </a>
            {APPROVAL_STATES.map((state) => (
              <a
                key={state}
                className="nx-btn nx-btn--ghost nx-btn--sm"
                href={`${basePath}?state=${state}`}
              >
                {`${state.replace(/_/g, ' ')} (${String(countFor(state))})`}
              </a>
            ))}
          </Row>
        }
      >
        <Stack size="sm">
          <p className="nx-hint">
            Asset types come from the spec: {KNOWLEDGE_ASSET_TYPES.join(' · ')}.
            {stateFilter === null ? '' : ` Showing only ${stateFilter.replace(/_/g, ' ')} assets.`}
          </p>
          <DataTable
            columns={assetColumns}
            rows={filtered}
            rowKey={(asset) => asset.id}
            caption="Knowledge assets for this business"
            empty={
              <span className="nx-hint">
                No assets in this view. Add portfolio pages, case studies, videos or approved claims so
                retrieval has something factual to work with.
              </span>
            }
          />
        </Stack>
      </Card>

      {awaitingReview.length > 0 && (
        <>
          <div style={{ height: 'var(--nx-space-xl)' }} />
          <Card
            title="Awaiting human review"
            actions={<Chip accent="amber">{awaitingReview.length}</Chip>}
          >
            <Stack size="lg">
              {awaitingReview.map((asset) => (
                <Stack key={asset.id} size="sm">
                  <Row wrap>
                    <span>{asset.title ?? asset.url ?? 'Untitled asset'}</span>
                    <Chip accent="indigo">{asset.type}</Chip>
                    <Chip accent={approvalAccent(asset.approvalState)}>
                      {asset.approvalState.replace(/_/g, ' ')}
                    </Chip>
                  </Row>
                  {asset.description !== null && <span className="nx-hint">{asset.description}</span>}
                  {canManage ? (
                    <AssetApprovalActions
                      businessSlug={business.key}
                      assetId={asset.id}
                      currentState={asset.approvalState}
                      nextStates={nextApprovalStates(asset.approvalState)}
                    />
                  ) : (
                    <span className="nx-hint">
                      You do not have the knowledge.manage permission, so approval is read-only for you.
                    </span>
                  )}
                </Stack>
              ))}
            </Stack>
          </Card>
        </>
      )}

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid split>
        <Stack size="lg">
          {selectedAsset !== null ? (
            <Card
              title={selectedAsset.title ?? 'Asset'}
              actions={
                <Row wrap>
                  <Chip accent={approvalAccent(selectedAsset.approvalState)}>
                    {selectedAsset.approvalState.replace(/_/g, ' ')}
                  </Chip>
                  {isRetrievalEligible(selectedAsset) ? (
                    <Chip accent="green">retrieval-eligible</Chip>
                  ) : (
                    <Chip accent="neutral">not retrieval-eligible</Chip>
                  )}
                </Row>
              }
            >
              {canManage ? (
                <>
                  <KnowledgeAssetForm
                    mode="edit"
                    businessSlug={business.key}
                    businessId={business.id}
                    asset={selectedAsset}
                  />
                  <div style={{ height: 'var(--nx-space-lg)' }} />
                  <Stack size="sm">
                    <h3 className="nx-section-title">Approval workflow</h3>
                    <AssetApprovalActions
                      businessSlug={business.key}
                      assetId={selectedAsset.id}
                      currentState={selectedAsset.approvalState}
                      nextStates={nextApprovalStates(selectedAsset.approvalState)}
                    />
                  </Stack>
                  <div style={{ height: 'var(--nx-space-lg)' }} />
                  <DeleteAssetAction
                    businessSlug={business.key}
                    assetId={selectedAsset.id}
                    assetLabel={selectedAsset.title ?? selectedAsset.url ?? 'this asset'}
                  />
                </>
              ) : (
                <Stack size="sm">
                  <p className="nx-hint">{selectedAsset.description ?? 'No description recorded.'}</p>
                  <p className="nx-hint">
                    {`Type ${selectedAsset.type} · approval ${selectedAsset.approvalState} · AI use ${
                      selectedAsset.aiUseAllowed ? 'allowed' : 'off'
                    }`}
                  </p>
                  <p className="nx-hint">
                    You do not have the knowledge.manage permission, so this asset is read-only for
                    you.
                  </p>
                </Stack>
              )}
            </Card>
          ) : (
            <Card title="Add asset" actions={<Chip accent="indigo">knowledge</Chip>}>
              {canManage ? (
                <KnowledgeAssetForm
                  mode="create"
                  businessSlug={business.key}
                  businessId={business.id}
                />
              ) : (
                <span className="nx-hint">
                  You do not have the knowledge.manage permission, so you cannot add an asset.
                </span>
              )}
            </Card>
          )}
        </Stack>

        <Stack size="lg">
          <Card title="Ingestion pipeline" actions={<Chip accent="cyan">guidance</Chip>}>
            <Stack size="sm">
              <p className="nx-hint">
                Fetch/parse → structured extraction → AI analysis → tags and relevance → human review →
                approve → retrieval eligible.
              </p>
              <p className="nx-hint">
                Case-study extraction covers the public title and client (where supported), industry,
                problem, solution, deliverables, services, explicit results only, the relevant ICP,
                approved claims, the source URL and a confidence score. Videos record the URL, title
                and channel, format where supportable, service category, best-fit ICP and provenance.
              </p>
              <p className="nx-hint">
                Retrieval is selective: prospect, company, signal and ICP need select the top relevant
                approved value proposition and proof. The whole library is never dumped into a prompt —
                only items marked eligible here are candidates.
              </p>
              <p className="nx-hint">
                Sent messages keep the asset versions they referenced; dynamic unsent messages may use
                the newest approved versions.
              </p>
            </Stack>
          </Card>

          <Card title="Retrieval-eligible now" actions={<Chip accent="green">{eligible.length}</Chip>}>
            <DataTable
              columns={[
                { key: 'title', header: 'Asset', cell: (asset: KnowledgeAsset) => asset.title ?? asset.url ?? 'Untitled' },
                { key: 'type', header: 'Type', cell: (asset: KnowledgeAsset) => asset.type },
                {
                  key: 'tags',
                  header: 'Tags',
                  cell: (asset: KnowledgeAsset) => asset.tags.join(', ') || '—',
                },
              ]}
              rows={eligible}
              rowKey={(asset) => asset.id}
              caption="Assets outbound AI may currently use"
              empty={
                <span className="nx-hint">
                  Nothing is retrieval-eligible yet. Approve an asset and allow AI use to make it
                  available to drafting.
                </span>
              }
            />
          </Card>

          <Card title="Weighted retrieval tags" actions={<Chip accent="indigo">{tagWeights.length}</Chip>}>
            <Stack size="sm">
              <p className="nx-hint">
                Extraction weights tags for relevance. The tag list on an asset is kept in step with
                these rows so the two can never disagree about what an asset is about.
              </p>
              <DataTable
                columns={tagColumns}
                rows={tagWeights}
                rowKey={(row) => `${row.assetId}:${row.tag}`}
                caption="Weighted tags produced for retrieval"
                empty={<span className="nx-hint">No weighted tags recorded yet.</span>}
              />
            </Stack>
          </Card>
        </Stack>
      </Grid>
    </>
  );
}

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  return null;
}

function approvalAccent(state: string): 'green' | 'amber' | 'red' | 'neutral' {
  if (state === 'approved') return 'green';
  if (state === 'needs_review' || state === 'extracting') return 'amber';
  if (state === 'rejected' || state === 'superseded') return 'red';
  return 'neutral';
}
