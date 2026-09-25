'use client';

import { useActionState, type ReactElement } from 'react';

import { KNOWLEDGE_ASSET_TYPES } from '@nexus/core';
import { Alert, Button, Field, Row, Select, Stack, TextArea, TextInput } from '@nexus/ui';

import {
  createAssetAction,
  deleteAssetAction,
  setApprovalStateAction,
  updateAssetAction,
  type ActionResult,
} from '@/app/b/[slug]/setup/knowledge/actions';
import { ActionShell } from '@/components/lead-forms';
// Types come from the client-safe view module: `lib/repo/*` is server-only.
import type { KnowledgeAsset } from '@/lib/knowledge-view';

const INITIAL: ActionResult = { ok: false, error: null };

const YES_NO = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

const TYPE_OPTIONS = KNOWLEDGE_ASSET_TYPES.map((type) => ({ value: type, label: type }));

/** Plain-language labels for the approval pipeline in spec `business_brain_and_knowledge.ingestion`. */
const APPROVAL_LABELS: Readonly<Record<string, string>> = {
  draft: 'Return to draft',
  extracting: 'Mark as extracting',
  needs_review: 'Send to human review',
  approved: 'Approve for outbound AI',
  rejected: 'Reject',
  superseded: 'Mark superseded',
};

function listValue(values: readonly string[]): string {
  return values.join('\n');
}

/**
 * Knowledge asset editor (A14).
 *
 * The asset's `description` is the factual claim the draft may use, which is why it is
 * labelled as such and why the claim policy is restated next to the AI switches.
 */
export function KnowledgeAssetForm({
  mode,
  businessSlug,
  businessId,
  asset,
}: {
  readonly mode: 'create' | 'edit';
  readonly businessSlug: string;
  readonly businessId: string;
  readonly asset?: KnowledgeAsset;
}): ReactElement {
  const isEdit = mode === 'edit' && asset !== undefined;
  const suffix = isEdit ? asset.id.slice(0, 8) : 'new';
  const action = isEdit ? updateAssetAction : createAssetAction;

  return (
    <ActionShell
      action={action}
      submitLabel={isEdit ? 'Save asset' : 'Add asset'}
      hidden={{
        businessSlug,
        businessId,
        ...(isEdit ? { assetId: asset.id } : {}),
      }}
    >
      <div className="nx-grid nx-grid--2">
        <Field label="Type" htmlFor={`asset-type-${suffix}`} required>
          <Select
            id={`asset-type-${suffix}`}
            name="type"
            defaultValue={isEdit ? asset.type : 'Portfolio'}
            options={TYPE_OPTIONS}
          />
        </Field>
        <Field
          label="URL"
          htmlFor={`asset-url-${suffix}`}
          hint="Portfolio page, case study, video or document link."
        >
          <TextInput
            id={`asset-url-${suffix}`}
            name="url"
            type="url"
            defaultValue={isEdit ? (asset.url ?? '') : ''}
            placeholder="https://"
          />
        </Field>
      </div>

      <Field label="Title" htmlFor={`asset-title-${suffix}`}>
        <TextInput
          id={`asset-title-${suffix}`}
          name="title"
          defaultValue={isEdit ? (asset.title ?? '') : ''}
        />
      </Field>

      <Field
        label="Approved fact / description"
        htmlFor={`asset-description-${suffix}`}
        hint="Outbound may use only approved factual claims. Never invent metrics, clients or results."
      >
        <TextArea
          id={`asset-description-${suffix}`}
          name="description"
          defaultValue={isEdit ? (asset.description ?? '') : ''}
          rows={4}
        />
      </Field>

      <Field
        label="Tags"
        htmlFor={`asset-tags-${suffix}`}
        hint="One per line or comma-separated. Retrieval matches these against signals and ICP need."
      >
        <TextArea
          id={`asset-tags-${suffix}`}
          name="tags"
          defaultValue={isEdit ? listValue(asset.tags) : ''}
          rows={3}
        />
      </Field>

      <div className="nx-grid nx-grid--2">
        <Field
          label="AI may use this asset"
          htmlFor={`asset-ai-${suffix}`}
          hint="Retrieval eligibility also requires approval_state = approved."
        >
          <Select
            id={`asset-ai-${suffix}`}
            name="aiUseAllowed"
            defaultValue={isEdit && asset.aiUseAllowed ? 'true' : 'false'}
            options={YES_NO}
          />
        </Field>
        <Field label="May mention client name" htmlFor={`asset-client-${suffix}`}>
          <Select
            id={`asset-client-${suffix}`}
            name="mayMentionClientName"
            defaultValue={isEdit && asset.mayMentionClientName ? 'true' : 'false'}
            options={YES_NO}
          />
        </Field>
        <Field label="May mention numeric results" htmlFor={`asset-numbers-${suffix}`}>
          <Select
            id={`asset-numbers-${suffix}`}
            name="mayMentionNumericResults"
            defaultValue={isEdit && asset.mayMentionNumericResults ? 'true' : 'false'}
            options={YES_NO}
          />
        </Field>
      </div>

      <p className="nx-hint">
        Approval state is {isEdit ? asset.approvalState : 'draft'} and is moved through the workflow
        pipeline rather than typed here, so nothing becomes retrieval-eligible by accident.
      </p>
    </ActionShell>
  );
}

function ApprovalTransition({
  businessSlug,
  assetId,
  next,
  variant,
}: {
  readonly businessSlug: string;
  readonly assetId: string;
  readonly next: string;
  readonly variant: 'primary' | 'secondary' | 'danger';
}): ReactElement {
  const [state, formAction, pending] = useActionState(setApprovalStateAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="assetId" value={assetId} />
      <input type="hidden" name="approvalState" value={next} />
      <Stack size="sm">
        <Button
          type="submit"
          variant={variant}
          size="sm"
          busy={pending}
          title={state.error ?? APPROVAL_LABELS[next] ?? next}
        >
          {APPROVAL_LABELS[next] ?? next}
        </Button>
        {state.error !== null && (
          <Alert accent="red" role="alert">
            {state.error}
          </Alert>
        )}
        {state.error === null && state.message !== undefined && (
          <Alert accent="green" role="status">
            {state.message}
          </Alert>
        )}
      </Stack>
    </form>
  );
}

/**
 * The approval workflow: draft -> extracting -> needs_review -> approved, with explicit
 * back-steps. Only transitions the pipeline allows are rendered, and the server action
 * re-checks the same table.
 */
export function AssetApprovalActions({
  businessSlug,
  assetId,
  currentState,
  nextStates,
}: {
  readonly businessSlug: string;
  readonly assetId: string;
  readonly currentState: string;
  readonly nextStates: readonly string[];
}): ReactElement {
  return (
    <Stack size="sm">
      <p className="nx-hint">
        Current state: {currentState.replace(/_/g, ' ')}. Only approved assets with AI use allowed
        are retrieval-eligible.
      </p>
      <Row wrap>
        {nextStates.map((next) => (
          <ApprovalTransition
            key={next}
            businessSlug={businessSlug}
            assetId={assetId}
            next={next}
            variant={next === 'approved' ? 'primary' : next === 'rejected' ? 'danger' : 'secondary'}
          />
        ))}
      </Row>
      <p className="nx-hint">
        Pipeline: draft → extracting → needs_review → approved. Terminal states: rejected and
        superseded — an approved-but-replaced asset is superseded rather than deleted, so the history
        of what outbound was allowed to claim stays inspectable.
      </p>
    </Stack>
  );
}

export function DeleteAssetAction({
  businessSlug,
  assetId,
  assetLabel,
}: {
  readonly businessSlug: string;
  readonly assetId: string;
  readonly assetLabel: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(deleteAssetAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="assetId" value={assetId} />
      <Stack size="sm">
        <p className="nx-hint">
          Removing {assetLabel} takes it out of retrieval and clears its AI use flag. Prefer
          superseding an approved asset when its claims were already used in sent messages.
        </p>
        {state.error !== null && (
          <Alert accent="red" role="alert">
            {state.error}
          </Alert>
        )}
        {state.error === null && state.message !== undefined && (
          <Alert accent="green" role="status">
            {state.message}
          </Alert>
        )}
        <Button type="submit" variant="danger" busy={pending}>
          Remove asset
        </Button>
      </Stack>
    </form>
  );
}
