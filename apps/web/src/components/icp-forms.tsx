'use client';

import { useActionState, type ReactElement } from 'react';

import { SIGNAL_KINDS } from '@nexus/core';
import { Alert, Button, Field, Select, Stack, TextArea, TextInput } from '@nexus/ui';

import {
  createIcpAction,
  createScoringRuleAction,
  deleteIcpAction,
  deleteScoringRuleAction,
  updateIcpAction,
  updateScoringRuleAction,
  type ActionResult,
} from '@/app/b/[slug]/setup/icps/actions';
import { ActionShell } from '@/components/lead-forms';
// Types come from the client-safe view module: `lib/repo/*` is server-only.
import type { Icp, ScoringRule } from '@/lib/icp-view';

const INITIAL: ActionResult = { ok: false, error: null };

const YES_NO = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
];

const SIGNAL_OPTIONS = SIGNAL_KINDS.map((kind) => ({ value: kind, label: kind.replace(/_/g, ' ') }));

const POLARITY_OPTIONS = [
  { value: 'positive', label: 'Positive' },
  { value: 'negative', label: 'Negative' },
  { value: 'neutral', label: 'Neutral' },
];

const TARGET_OPTIONS = [
  { value: 'business', label: 'This business' },
  { value: 'icp', label: 'One ICP' },
  { value: 'global', label: 'Global default (all businesses)' },
];

function listValue(values: readonly string[] | null | undefined): string {
  return (values ?? []).join('\n');
}

function numberValue(value: number | null | undefined): string {
  return value == null ? '' : String(value);
}

export interface IcpFormProps {
  readonly mode: 'create' | 'edit';
  readonly businessSlug: string;
  readonly businessId: string;
  readonly sequences: readonly { readonly value: string; readonly label: string }[];
  readonly owners: readonly { readonly value: string; readonly label: string }[];
  readonly identities: readonly { readonly value: string; readonly label: string }[];
  readonly icp?: Icp;
}

/**
 * ICP editor (A12). Every jsonb-backed column is exposed as typed controls — text
 * lists, numbers and selects — and never as a raw JSON textarea.
 */
export function IcpForm({
  mode,
  businessSlug,
  businessId,
  sequences,
  owners,
  identities,
  icp,
}: IcpFormProps): ReactElement {
  const isEdit = mode === 'edit' && icp !== undefined;
  const suffix = isEdit ? icp.id.slice(0, 8) : 'new';
  const action = isEdit ? updateIcpAction : createIcpAction;

  const sequenceOptions = [
    { value: '', label: 'No default sequence' },
    ...sequences.map((option) => ({ value: option.value, label: option.label })),
  ];
  const ownerOptions = [
    { value: '', label: 'Unassigned' },
    ...owners.map((option) => ({ value: option.value, label: option.label })),
  ];
  const identityOptions = [
    { value: '', label: 'Not bound' },
    ...identities.map((option) => ({ value: option.value, label: option.label })),
  ];

  return (
    <ActionShell
      action={action}
      submitLabel={isEdit ? 'Save ICP' : 'Create ICP'}
      hidden={{
        businessSlug,
        businessId,
        ...(isEdit ? { icpId: icp.id } : {}),
      }}
    >
      <Field label="Name" htmlFor={`icp-name-${suffix}`} required>
        <TextInput
          id={`icp-name-${suffix}`}
          name="name"
          defaultValue={isEdit ? icp.name : ''}
          required
        />
      </Field>

      <Field label="Description" htmlFor={`icp-description-${suffix}`}>
        <TextArea
          id={`icp-description-${suffix}`}
          name="description"
          defaultValue={isEdit ? (icp.description ?? '') : ''}
          rows={2}
        />
      </Field>

      <div className="nx-grid nx-grid--2">
        <Field
          label="Company types"
          htmlFor={`icp-company-types-${suffix}`}
          hint="One per line, or comma-separated."
        >
          <TextArea
            id={`icp-company-types-${suffix}`}
            name="companyTypes"
            defaultValue={isEdit ? listValue(icp.criteria.companyTypes) : ''}
            rows={3}
          />
        </Field>

        <Field label="Markets / geographies" htmlFor={`icp-markets-${suffix}`} hint="One per line.">
          <TextArea
            id={`icp-markets-${suffix}`}
            name="markets"
            defaultValue={isEdit ? listValue(icp.criteria.markets) : ''}
            rows={3}
          />
        </Field>

        <Field label="Buyer titles" htmlFor={`icp-buyer-titles-${suffix}`} hint="One per line.">
          <TextArea
            id={`icp-buyer-titles-${suffix}`}
            name="buyerTitles"
            defaultValue={isEdit ? listValue(icp.criteria.buyerTitles) : ''}
            rows={3}
          />
        </Field>

        <Field label="Exclusions" htmlFor={`icp-exclusions-${suffix}`} hint="One per line.">
          <TextArea
            id={`icp-exclusions-${suffix}`}
            name="exclusions"
            defaultValue={isEdit ? listValue(icp.criteria.exclusions) : ''}
            rows={3}
          />
        </Field>
      </div>

      <div className="nx-grid nx-grid--2">
        <Field label="Company size — minimum" htmlFor={`icp-size-min-${suffix}`} hint="Headcount.">
          <TextInput
            id={`icp-size-min-${suffix}`}
            name="companySizeMin"
            type="number"
            defaultValue={isEdit ? numberValue(icp.criteria.companySizeMin) : ''}
          />
        </Field>
        <Field label="Company size — maximum" htmlFor={`icp-size-max-${suffix}`} hint="Headcount.">
          <TextInput
            id={`icp-size-max-${suffix}`}
            name="companySizeMax"
            type="number"
            defaultValue={isEdit ? numberValue(icp.criteria.companySizeMax) : ''}
          />
        </Field>
      </div>

      <Field
        label="Signals treated as evidence"
        htmlFor={`icp-signals-${suffix}`}
        hint={`Known signal kinds: ${SIGNAL_KINDS.join(', ')}`}
      >
        <TextArea
          id={`icp-signals-${suffix}`}
          name="requiredSignals"
          defaultValue={isEdit ? listValue(icp.criteria.requiredSignals) : ''}
          rows={2}
        />
      </Field>

      <Field label="ICP notes" htmlFor={`icp-notes-${suffix}`}>
        <TextArea
          id={`icp-notes-${suffix}`}
          name="notes"
          defaultValue={isEdit ? (icp.criteria.notes ?? '') : ''}
          rows={2}
        />
      </Field>

      <div className="nx-grid nx-grid--2">
        <Field label="Business default ICP" htmlFor={`icp-default-${suffix}`}>
          <Select
            id={`icp-default-${suffix}`}
            name="isDefault"
            defaultValue={isEdit && icp.isDefault ? 'true' : 'false'}
            options={YES_NO}
          />
        </Field>
        <Field label="Active" htmlFor={`icp-active-${suffix}`}>
          <Select
            id={`icp-active-${suffix}`}
            name="isActive"
            defaultValue={isEdit && !icp.isActive ? 'false' : 'true'}
            options={YES_NO}
          />
        </Field>
      </div>

      <Field
        label="Default sequence"
        htmlFor={`icp-sequence-${suffix}`}
        hint="Used when a lead matching this ICP is enrolled."
      >
        <Select
          id={`icp-sequence-${suffix}`}
          name="defaultSequenceId"
          defaultValue={isEdit ? (icp.defaultSequenceId ?? '') : ''}
          options={sequenceOptions}
        />
      </Field>

      <Field
        label="Minimum match score"
        htmlFor={`icp-min-score-${suffix}`}
        hint="Scores are configuration, not product constants."
      >
        <TextInput
          id={`icp-min-score-${suffix}`}
          name="minScore"
          type="number"
          defaultValue={isEdit ? numberValue(icp.scoringOverrides.minScore) : ''}
        />
      </Field>

      <div>
        <p className="nx-hint">
          Score overrides per signal kind. Leave a field empty to use the business scoring rule
          unchanged; a number here adds to (or subtracts from) that rule for this ICP only.
        </p>
        <div className="nx-grid nx-grid--2">
          {SIGNAL_KINDS.map((kind) => (
            <Field key={kind} label={kind.replace(/_/g, ' ')} htmlFor={`icp-weight-${kind}-${suffix}`}>
              <TextInput
                id={`icp-weight-${kind}-${suffix}`}
                name={`weight_${kind}`}
                type="number"
                defaultValue={
                  isEdit && icp.scoringOverrides.weights[kind] !== undefined
                    ? String(icp.scoringOverrides.weights[kind])
                    : ''
                }
              />
            </Field>
          ))}
        </div>
      </div>

      <div className="nx-grid nx-grid--2">
        <Field label="Routing owner" htmlFor={`icp-owner-${suffix}`}>
          <Select
            id={`icp-owner-${suffix}`}
            name="ownerUserId"
            defaultValue={isEdit ? (icp.routing.ownerUserId ?? '') : ''}
            options={ownerOptions}
          />
        </Field>
        <Field label="Routing sender identity" htmlFor={`icp-identity-${suffix}`}>
          <Select
            id={`icp-identity-${suffix}`}
            name="outreachIdentityId"
            defaultValue={isEdit ? (icp.routing.outreachIdentityId ?? '') : ''}
            options={identityOptions}
          />
        </Field>
        <Field label="Routing priority" htmlFor={`icp-priority-${suffix}`}>
          <Select
            id={`icp-priority-${suffix}`}
            name="priority"
            defaultValue={isEdit ? (icp.routing.priority ?? 'normal') : 'normal'}
            options={PRIORITY_OPTIONS}
          />
        </Field>
        <Field label="Auto-enroll matches" htmlFor={`icp-auto-enroll-${suffix}`}>
          <Select
            id={`icp-auto-enroll-${suffix}`}
            name="autoEnroll"
            defaultValue={isEdit && icp.routing.autoEnroll ? 'true' : 'false'}
            options={YES_NO}
          />
        </Field>
      </div>
    </ActionShell>
  );
}

/** Soft delete, with the number of leads still pointing at this ICP made explicit. */
export function DeleteIcpAction({
  icpId,
  icpName,
  businessSlug,
  primaryLeadCount,
}: {
  readonly icpId: string;
  readonly icpName: string;
  readonly businessSlug: string;
  readonly primaryLeadCount: number;
}): ReactElement {
  const [state, formAction, pending] = useActionState(deleteIcpAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="icpId" value={icpId} />
      <Stack size="sm">
        <p className="nx-hint">
          {primaryLeadCount === 0
            ? `Archiving ${icpName} keeps every historical match but removes it from new lead routing.`
            : `${String(primaryLeadCount)} lead(s) still record ${icpName} as their Primary ICP. Archiving keeps that history; the ICP simply stops matching new leads.`}
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
          Archive ICP
        </Button>
      </Stack>
    </form>
  );
}

/**
 * Scoring rule editor (A12 "scoring").
 *
 * Points are rows, so the numbers are editable without a deploy — spec
 * `signals_and_scoring.rule`: "Scores are configuration, not hard-coded product
 * constants."
 */
export function ScoringRuleForm({
  mode,
  businessSlug,
  businessId,
  icps,
  rule,
}: {
  readonly mode: 'create' | 'edit';
  readonly businessSlug: string;
  readonly businessId: string;
  readonly icps: readonly { readonly value: string; readonly label: string }[];
  readonly rule?: ScoringRule;
}): ReactElement {
  const isEdit = mode === 'edit' && rule !== undefined;
  const suffix = isEdit ? rule.id.slice(0, 8) : 'new';
  const action = isEdit ? updateScoringRuleAction : createScoringRuleAction;

  return (
    <ActionShell
      action={action}
      submitLabel={isEdit ? 'Save rule' : 'Add scoring rule'}
      hidden={{
        businessSlug,
        businessId,
        ...(isEdit ? { ruleId: rule.id } : {}),
      }}
    >
      <div className="nx-grid nx-grid--2">
        <Field label="Applies to" htmlFor={`rule-target-${suffix}`}>
          <Select
            id={`rule-target-${suffix}`}
            name="targetType"
            defaultValue={isEdit ? rule.targetType : 'business'}
            options={TARGET_OPTIONS}
          />
        </Field>
        <Field
          label="ICP"
          htmlFor={`rule-icp-${suffix}`}
          hint="Used when “Applies to” is One ICP."
        >
          <Select
            id={`rule-icp-${suffix}`}
            name="targetIcpId"
            defaultValue={isEdit && rule.targetType === 'icp' ? (rule.targetId ?? '') : ''}
            options={[
              { value: '', label: 'Choose an ICP' },
              ...icps.map((option) => ({ value: option.value, label: option.label })),
            ]}
          />
        </Field>
        <Field label="Signal kind" htmlFor={`rule-signal-${suffix}`}>
          <Select
            id={`rule-signal-${suffix}`}
            name="signalKind"
            defaultValue={isEdit ? rule.signalKind : 'hiring'}
            options={SIGNAL_OPTIONS}
          />
        </Field>
        <Field label="Polarity" htmlFor={`rule-polarity-${suffix}`}>
          <Select
            id={`rule-polarity-${suffix}`}
            name="polarity"
            defaultValue={isEdit ? rule.polarity : 'positive'}
            options={POLARITY_OPTIONS}
          />
        </Field>
        <Field label="Points" htmlFor={`rule-points-${suffix}`} required hint="Negative for penalties.">
          <TextInput
            id={`rule-points-${suffix}`}
            name="points"
            type="number"
            defaultValue={isEdit ? String(rule.points) : ''}
            required
          />
        </Field>
        <Field label="Label" htmlFor={`rule-label-${suffix}`}>
          <TextInput
            id={`rule-label-${suffix}`}
            name="label"
            defaultValue={isEdit ? (rule.label ?? '') : ''}
            placeholder="actively hiring editor"
          />
        </Field>
        <Field label="Active" htmlFor={`rule-active-${suffix}`}>
          <Select
            id={`rule-active-${suffix}`}
            name="isActive"
            defaultValue={isEdit && !rule.isActive ? 'false' : 'true'}
            options={YES_NO}
          />
        </Field>
      </div>
    </ActionShell>
  );
}

export function DeleteScoringRuleAction({
  ruleId,
  businessSlug,
}: {
  readonly ruleId: string;
  readonly businessSlug: string;
}): ReactElement {
  const [state, formAction, pending] = useActionState(deleteScoringRuleAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="ruleId" value={ruleId} />
      {state.error !== null && (
        <Alert accent="red" role="alert">
          {state.error}
        </Alert>
      )}
      <Button type="submit" variant="danger" size="sm" busy={pending}>
        Delete
      </Button>
    </form>
  );
}
