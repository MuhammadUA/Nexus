'use client';

import { useActionState, type ReactElement } from 'react';

import { Alert, Button, Field, Select, Stack, TextInput } from '@nexus/ui';

import {
  saveBusinessSettingsAction,
  saveGlobalSettingsAction,
  type ActionResult,
} from '@/app/(app)/settings/actions';

const INITIAL: ActionResult = { ok: false, error: null };

/**
 * The serializable slice of the server-side catalogue that the form needs.
 *
 * A22 requires typed controls, so the kind travels with the definition; the client
 * never decides how a value is encoded, and the server action re-reads the
 * authoritative kind from `admin-access.ts` when it validates.
 */
export interface SettingFieldDef {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly kind: 'boolean' | 'number' | 'number_list';
  readonly help: string;
}

export type SettingFieldValue = string | boolean;
export type SettingFieldValues = Readonly<Record<string, SettingFieldValue | undefined>>;

function groupDefinitions(
  definitions: readonly SettingFieldDef[],
): readonly { readonly group: string; readonly items: readonly SettingFieldDef[] }[] {
  const groups: { group: string; items: SettingFieldDef[] }[] = [];
  for (const definition of definitions) {
    const existing = groups.find((entry) => entry.group === definition.group);
    if (existing === undefined) {
      groups.push({ group: definition.group, items: [definition] });
    } else {
      existing.items.push(definition);
    }
  }
  return groups;
}

function textOf(value: SettingFieldValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function StateAlerts({ state }: { readonly state: ActionResult }): ReactElement {
  return (
    <>
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
    </>
  );
}

/** One editable field, typed by the definition rather than by a free-text blob. */
function SettingField({
  definition,
  namePrefix,
  idPrefix,
  values,
  inheritedHint,
}: {
  readonly definition: SettingFieldDef;
  readonly namePrefix: string;
  readonly idPrefix: string;
  readonly values: SettingFieldValues;
  readonly inheritedHint?: string;
}): ReactElement {
  const id = `${idPrefix}-${definition.key}`;
  const current = values[definition.key];

  if (definition.kind === 'boolean') {
    return (
      <Field label={definition.label} htmlFor={id} hint={inheritedHint ?? definition.help}>
        <label className="nx-row" htmlFor={id}>
          <input id={id} type="checkbox" name={`${namePrefix}${definition.key}`} defaultChecked={current === true} />
          <span className="nx-hint">On</span>
        </label>
      </Field>
    );
  }

  return (
    <Field label={definition.label} htmlFor={id} hint={definition.help}>
      <TextInput
        id={id}
        name={`${namePrefix}${definition.key}`}
        defaultValue={textOf(current)}
        type={definition.kind === 'number' ? 'number' : 'text'}
        placeholder={definition.kind === 'number_list' ? '3, 4, 7' : '30'}
      />
    </Field>
  );
}

/**
 * Global platform defaults (`platform_settings.business_id IS NULL`).
 *
 * One form for the whole screen, because the settings are read as a single coherent
 * policy; the server writes them in one transaction.
 */
export function GlobalSettingsForm({
  definitions,
  values,
}: {
  readonly definitions: readonly SettingFieldDef[];
  readonly values: SettingFieldValues;
}): ReactElement {
  const [state, formAction, pending] = useActionState(saveGlobalSettingsAction, INITIAL);

  return (
    <form action={formAction}>
      <Stack size="lg">
        {groupDefinitions(definitions).map((section) => (
          <div key={section.group} className="nx-stack nx-stack--sm">
            <h3 className="nx-section-title">{section.group}</h3>
            {section.items.map((definition) => (
              <SettingField
                key={definition.key}
                definition={definition}
                namePrefix="g:"
                idPrefix="setting"
                values={values}
              />
            ))}
          </div>
        ))}

        <StateAlerts state={state} />

        <div className="nx-row">
          <Button type="submit" variant="primary" busy={pending}>
            Save global defaults
          </Button>
        </div>
      </Stack>
    </form>
  );
}

/**
 * Business-level overrides.
 *
 * `inherit` removes the business row so the global default applies again; every
 * other choice writes an explicit override. Numbers keep a separate value field, and
 * booleans encode on/off directly in the mode select, so no key is ever edited as
 * raw JSON.
 */
export function BusinessSettingsForm({
  definitions,
  businessId,
  overrides,
  overriddenKeys,
  inherited,
}: {
  readonly definitions: readonly SettingFieldDef[];
  readonly businessId: string;
  readonly overrides: SettingFieldValues;
  readonly overriddenKeys: readonly string[];
  readonly inherited: SettingFieldValues;
}): ReactElement {
  const [state, formAction, pending] = useActionState(saveBusinessSettingsAction, INITIAL);

  return (
    <form action={formAction}>
      <input type="hidden" name="businessId" value={businessId} />
      <Stack size="lg">
        {groupDefinitions(definitions).map((section) => (
          <div key={section.group} className="nx-stack nx-stack--sm">
            <h3 className="nx-section-title">{section.group}</h3>
            {section.items.map((definition) => {
              const id = `override-${definition.key}`;
              const isOverridden = overriddenKeys.includes(definition.key);
              const inheritedText = textOf(inherited[definition.key]);
              const inheritedLabel =
                inherited[definition.key] === true
                  ? 'on'
                  : inherited[definition.key] === false
                    ? 'off'
                    : inheritedText.length > 0
                      ? inheritedText
                      : 'not set';

              if (definition.kind === 'boolean') {
                return (
                  <Field
                    key={definition.key}
                    label={definition.label}
                    htmlFor={id}
                    hint={`Global default: ${inheritedLabel}. ${definition.help}`}
                  >
                    <Select
                      id={id}
                      name={`ovr:${definition.key}`}
                      defaultValue={isOverridden ? (overrides[definition.key] === true ? 'true' : 'false') : 'inherit'}
                      options={[
                        { value: 'inherit', label: 'Use global default' },
                        { value: 'true', label: 'On' },
                        { value: 'false', label: 'Off' },
                      ]}
                    />
                  </Field>
                );
              }

              return (
                <div key={definition.key} className="nx-stack nx-stack--sm">
                  <Field
                    label={definition.label}
                    htmlFor={id}
                    hint={`Global default: ${inheritedLabel}. ${definition.help}`}
                  >
                    <Select
                      id={id}
                      name={`ovr:${definition.key}`}
                      defaultValue={isOverridden ? 'set' : 'inherit'}
                      options={[
                        { value: 'inherit', label: 'Use global default' },
                        { value: 'set', label: 'Override for this business' },
                      ]}
                    />
                  </Field>
                  <Field
                    label={`${definition.label} — override value`}
                    htmlFor={`${id}-value`}
                    hint={definition.kind === 'number_list' ? 'Comma-separated days.' : undefined}
                  >
                    <TextInput
                      id={`${id}-value`}
                      name={`ovrval:${definition.key}`}
                      defaultValue={isOverridden ? textOf(overrides[definition.key]) : ''}
                      type={definition.kind === 'number' ? 'number' : 'text'}
                      placeholder={inheritedText.length > 0 ? inheritedText : 'value'}
                    />
                  </Field>
                </div>
              );
            })}
          </div>
        ))}

        <StateAlerts state={state} />

        <div className="nx-row">
          <Button type="submit" variant="primary" busy={pending}>
            Save business overrides
          </Button>
        </div>
      </Stack>
    </form>
  );
}
