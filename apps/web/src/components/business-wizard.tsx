'use client';

import { useActionState, useState, type ReactElement, type ReactNode } from 'react';

import { Alert, Button, Card, Chip, Field, Row, Select, Stack, TextArea, TextInput } from '@nexus/ui';

import { createBusinessAction, type ActionResult } from '@/app/(app)/businesses/new/actions';

const INITIAL: ActionResult = { ok: false, error: null };

/**
 * Turns a business name into a valid URL slug.
 *
 * `businesses.key` is constrained by `businesses_key_slug_check` to
 * `^[a-z0-9][a-z0-9-]*$`, and the server re-validates the same shape. Rather than let
 * an operator discover that by being rejected, the field derives its value from the
 * name as they type — so a valid key is the default rather than a thing to get right.
 */
export function slugifyKey(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export interface WizardSource {
  readonly id: string;
  readonly name: string;
  readonly isTemplate: boolean;
  /** Shown so it is obvious how much operational history stays behind. */
  readonly leadCount: number;
}

const STEPS: readonly { readonly id: string; readonly label: string; readonly hint: string }[] = [
  { id: 'step-identity', label: '1 · Identity', hint: 'Key, name, focus, regions' },
  { id: 'step-mode', label: '2 · Starting point', hint: 'Scratch, copy or template' },
  { id: 'step-offer', label: '3 · Offer', hint: 'What you sell and how you position it' },
  { id: 'step-review', label: '4 · Review & create', hint: 'Confirm, then configure' },
];

/**
 * A23 — Add Business Wizard.
 *
 * Contract: "Business identity, offer, ICPs, knowledge, sequences, team, automations;
 * scratch/clone/template."
 *
 * It is one page and one form: the stepper is a set of section anchors, not a
 * client-side wizard state machine, so nothing the operator typed can be lost by
 * stepping backwards. Inputs stay uncontrolled and the browser owns what is
 * submitted — except the key, which is derived from the name.
 *
 * spec `business_units.clone_behavior` is stated in full on the mode step, because
 * "copy an existing business" is the one control here that people assume copies
 * leads too.
 */
export function BusinessWizard({
  sources,
  templates,
}: {
  readonly sources: readonly WizardSource[];
  readonly templates: readonly WizardSource[];
}): ReactElement {
  const [state, formAction, pending] = useActionState(createBusinessAction, INITIAL);

  // The key is derived, not demanded. `edited` records that the operator has taken
  // control of it, after which typing in the name no longer overwrites their choice.
  const [key, setKey] = useState('');
  const [edited, setEdited] = useState(false);

  return (
    <form action={formAction}>
      <Stack size="lg">
        <nav aria-label="Wizard steps">
          <Row wrap>
            {STEPS.map((step) => (
              <a key={step.id} className="nx-btn nx-btn--ghost nx-btn--sm" href={`#${step.id}`} title={step.hint}>
                {step.label}
              </a>
            ))}
          </Row>
        </nav>

        <Step id="step-identity" title="Step 1 — Business identity" note="The URL slug is fixed for the life of the business.">
          <div className="nx-grid nx-grid--2">
            <Field
              label="Business key (URL slug)"
              htmlFor="wizard-key"
              required
              hint={
                key.length === 0
                  ? 'Filled in from the business name. Lowercase letters, numbers and dashes.'
                  : `Appears as /b/${key}/…`
              }
            >
              <TextInput
                id="wizard-key"
                name="key"
                value={key}
                onChange={(next) => {
                  setEdited(true);
                  setKey(slugifyKey(next));
                }}
                required
                placeholder="zemnas"
                ariaLabel="Business key"
              />
            </Field>
            <Field label="Business name" htmlFor="wizard-name" required>
              <TextInput
                id="wizard-name"
                name="name"
                defaultValue=""
                onChange={(next) => {
                  // Only track the name while the operator has not chosen a key.
                  if (!edited) setKey(slugifyKey(next));
                }}
                required
                placeholder="Zemnas Creative Studio"
              />
            </Field>
          </div>

          <Field label="Focus" htmlFor="wizard-focus" hint="One line: what this business actually does.">
            <TextInput id="wizard-focus" name="focus" defaultValue="" />
          </Field>

          <Field
            label="Regions"
            htmlFor="wizard-regions"
            hint="Comma-separated, for example US, UK, Germany. Used for matching, not for automatic merging."
          >
            <TextInput id="wizard-regions" name="regions" defaultValue="" />
          </Field>

          <Field label="Notes" htmlFor="wizard-notes" hint="Operational context an operator should know.">
            <TextArea id="wizard-notes" name="notes" defaultValue="" />
          </Field>
        </Step>

        <Step
          id="step-mode"
          title="Step 2 — Starting point"
          note="Scratch, copy an existing business, or start from a template."
        >
          <Field label="How should this business start?" htmlFor="wizard-mode-scratch" required>
            <div className="nx-stack nx-stack--sm">
              <label className="nx-row" htmlFor="wizard-mode-scratch">
                <input id="wizard-mode-scratch" type="radio" name="mode" value="scratch" defaultChecked />
                <span>Start from scratch — configuration stays empty</span>
              </label>
              <label className="nx-row" htmlFor="wizard-mode-clone">
                <input id="wizard-mode-clone" type="radio" name="mode" value="clone" />
                <span>Copy an existing business — configuration only</span>
              </label>
              <label className="nx-row" htmlFor="wizard-mode-template">
                <input id="wizard-mode-template" type="radio" name="mode" value="template" />
                <span>Start from a template</span>
              </label>
            </div>
          </Field>

          <Field
            label="Source"
            htmlFor="wizard-source"
            hint="Only used for the copy and template options. Rows marked (template) are the template starts."
          >
            <Select
              id="wizard-source"
              name="sourceBusinessId"
              defaultValue=""
              placeholder="No source — start from scratch"
              options={sources.map((source) => ({
                value: source.id,
                label: `${source.name}${source.isTemplate ? ' (template)' : ''} — ${String(
                  source.leadCount,
                )} leads would stay behind, configuration would be copied`,
              }))}
            />
          </Field>

          <Alert accent="red" title="Copying never moves operational history">
            spec `business_units.clone_behavior`: a copy brings across <strong>ICP structure</strong>,{' '}
            <strong>signal scoring</strong>, <strong>message and sequence rules</strong>,{' '}
            <strong>automation skeletons</strong> and <strong>assignment rules</strong>. It never copies{' '}
            <strong>leads</strong>, <strong>people or company history</strong>,{' '}
            <strong>conversations</strong>, <strong>replies</strong>,{' '}
            <strong>message history</strong> or <strong>agent runs</strong>.{" "}
            {templates.length === 0
              ? 'No business is currently marked as a template.'
              : `${String(templates.length)} template${templates.length === 1 ? '' : 's'} available.`}{' '}
            Services, case studies, value propositions and outreach accounts are optional extras that are also
            not copied automatically.
          </Alert>
        </Step>

        <Step
          id="step-offer"
          title="Step 3 — Offer"
          note="Optional. Recorded as an unapproved offer; approve it on the Business Brain screen once it is accurate."
        >
          <Field label="Offer name" htmlFor="wizard-offer-name">
            <TextInput id="wizard-offer-name" name="offerName" defaultValue="" />
          </Field>
          <Field label="Description" htmlFor="wizard-offer-description">
            <TextArea id="wizard-offer-description" name="offerDescription" defaultValue="" />
          </Field>
          <Field label="Positioning" htmlFor="wizard-offer-positioning">
            <TextArea id="wizard-offer-positioning" name="offerPositioning" defaultValue="" />
          </Field>
          <Field label="CTA style" htmlFor="wizard-offer-cta">
            <TextInput id="wizard-offer-cta" name="offerCtaStyle" defaultValue="" />
          </Field>
        </Step>

        <Step
          id="step-review"
          title="Step 4 — Review & create"
          note="ICPs, knowledge, sequences, team and automations are configured after the business exists."
        >
          <Stack size="sm">
            <Row between>
              <span className="nx-hint">Created here</span>
              <span>Business identity + optional first offer</span>
            </Row>
            <Row between>
              <span className="nx-hint">Configured next</span>
              <span>ICPs · Sequences · Knowledge · Brain · Team access · Automations</span>
            </Row>
            <Row wrap>
              <Chip accent="indigo">ICPs</Chip>
              <Chip accent="indigo">Sequences</Chip>
              <Chip accent="indigo">Knowledge</Chip>
              <Chip accent="indigo">Brain</Chip>
              <Chip accent="indigo">Team</Chip>
              <Chip accent="indigo">Automations</Chip>
            </Row>
            <p className="nx-hint">
              Each of those has its own screen so it can be reviewed on its own; the wizard deliberately does
              not pretend to have configured them.
            </p>
          </Stack>

          {state.error !== null && (
            <Alert accent="red" role="alert">
              {state.error}
            </Alert>
          )}

          {state.ok && state.message !== undefined && (
            <Alert accent="green" role="status" title="Business created">
              {state.message}
              {state.createdKey !== undefined && (
                <>
                  {' '}
                  <a href={`/b/${state.createdKey}/setup/brain`}>Open the Business Brain</a>
                  {' · '}
                  <a href={`/b/${state.createdKey}/overview`}>Open the overview</a>
                </>
              )}
            </Alert>
          )}

          {state.warning !== undefined && (
            <Alert accent="amber" role="alert" title="Partially completed">
              {state.warning}
            </Alert>
          )}

          <div className="nx-row">
            <Button type="submit" variant="primary" busy={pending}>
              Create business
            </Button>
          </div>
        </Step>
      </Stack>
    </form>
  );
}

/** One wizard step: an anchored card so the stepper can jump straight to it. */
function Step({
  id,
  title,
  note,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div id={id}>
      <Card title={title} actions={<span className="nx-hint">{note}</span>}>
        <Stack size="md">{children}</Stack>
      </Card>
    </div>
  );
}
