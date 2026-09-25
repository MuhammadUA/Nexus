import type { ReactNode } from 'react';

import { Alert, Button, Card, Chip, DataTable, Grid, PageHead, Row, Select, Stack, Stat, type Column } from '@nexus/ui';

import {
  BusinessSettingsForm,
  GlobalSettingsForm,
  type SettingFieldDef,
  type SettingFieldValues,
} from '@/components/settings-forms';
import { loadViewerContext } from '@/lib/viewer-context';
import { PLATFORM_SETTING_DEFS } from '@/lib/repo/admin-access';
import { listPlatformSettings, type PlatformSetting } from '@/lib/repo/businesses';

export const dynamic = 'force-dynamic';

/** The local-credential switch is a deployment decision, shown read-only (see below). */
const READ_ONLY_KEY = 'security.local_auth_enabled';

interface SearchParams {
  readonly business?: string;
}

/**
 * A22 — Settings.
 *
 * Contract: "Security, retention, soft-delete, DNC suppression, uniqueness defaults,
 * reply pause, dormant defaults."
 *
 * Two layers, exactly as the table models them: global rows (`business_id IS NULL`)
 * are the platform defaults, and a business row overrides the default for that
 * business only. Every value is edited through a typed control — a checkbox, a number
 * field or a days list — never a raw JSON textarea, because a hand-edited blob is how
 * a boolean silently becomes the string "false".
 */
export default async function SettingsPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const context = await loadViewerContext();

  const editableDefs: readonly SettingFieldDef[] = PLATFORM_SETTING_DEFS.map((definition) => ({
    key: definition.key,
    label: definition.label,
    group: definition.group,
    kind: definition.kind,
    help: definition.help,
  }));

  const selectedBusiness =
    query.business === undefined || query.business.length === 0
      ? null
      : context.businesses.find((business) => business.id === query.business) ?? null;

  const [globalRows, businessRows] = await Promise.all([
    listPlatformSettings(context.viewer.actor),
    selectedBusiness === null
      ? Promise.resolve<readonly PlatformSetting[]>([])
      : listPlatformSettings(context.viewer.actor, selectedBusiness.id),
  ]);

  const canManage = context.permissions.has('settings.manage');
  const globalValues = toFieldValues(editableDefs, globalRows, true);
  const overrideValues = toFieldValues(editableDefs, businessRows, false);
  const overriddenKeys = businessRows
    .map((row) => row.key)
    .filter((key) => editableDefs.some((definition) => definition.key === key));

  const localAuth = globalRows.find((row) => row.key === READ_ONLY_KEY);
  const knownKeys = new Set<string>([...editableDefs.map((definition) => definition.key), READ_ONLY_KEY]);
  const unknownGlobalRows = globalRows.filter((row) => !knownKeys.has(row.key));
  const unknownBusinessRows = businessRows.filter((row) => !knownKeys.has(row.key));

  return (
    <>
      <PageHead
        subtitle="Platform defaults, and per-business overrides where a business needs to differ."
        actions={
          <Row wrap>
            <Chip accent="indigo">{globalRows.length} global keys</Chip>
            <Chip accent="neutral">
              {selectedBusiness === null ? 'no business scope' : `${String(businessRows.length)} overrides`}
            </Chip>
          </Row>
        }
      >
        Settings
      </PageHead>

      {!canManage && (
        <>
          <Alert accent="amber" role="alert">
            These settings are read-only for you. Changing them needs the <code>settings.manage</code>{' '}
            permission, which is admin-only, and the database refuses the write regardless.
          </Alert>
          <div style={{ height: 'var(--nx-space-lg)' }} />
        </>
      )}

      <Grid cols={4}>
        <Stat
          value={globalRows.filter((row) => row.value === true).length}
          label="Defaults switched on"
          meta={`${globalRows.length} global rows`}
        />
        <Stat value={PLATFORM_SETTING_DEFS.length} label="Editable settings" meta="typed controls only" />
        <Stat
          value={selectedBusiness === null ? 0 : businessRows.length}
          label="Business overrides"
          meta={selectedBusiness === null ? 'no business selected' : selectedBusiness.name}
        />
        <Stat
          value={readLocalAuth(localAuth?.value) ? 'on' : 'off'}
          label="Local sign-in path"
          meta="read-only"
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card title="Security · local credential path" actions={<Chip accent="amber">read-only</Chip>}>
        <Stack size="sm">
          <Row between>
            <span className="nx-hint">security.local_auth_enabled</span>
            <Chip accent={readLocalAuth(localAuth?.value) ? 'green' : 'neutral'}>
              {readLocalAuth(localAuth?.value) ? 'enabled' : 'disabled'}
            </Chip>
          </Row>
          <p className="nx-hint">
            {localAuthNote(localAuth?.value) ??
              'This key records whether the local email/password path may authenticate at all.'}
          </p>
          <p className="nx-hint">
            The screen cannot change it on purpose. The local credential path exists only so a self-hosted
            instance can be signed into before an identity provider is wired up; turning it on is a deployment
            decision made in configuration (<code>NEXUS_LOCAL_AUTH</code>), not a runtime preference an
            operator can flip. Leaving it read-only means a compromised admin session cannot open a second,
            weaker way into the platform.
          </p>
        </Stack>
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {canManage ? (
        <Card title="Global defaults" actions={<Chip accent="indigo">business_id IS NULL</Chip>}>
          <GlobalSettingsForm definitions={editableDefs} values={globalValues} />
        </Card>
      ) : (
        <Card title="Global defaults" actions={<Chip accent="neutral">read-only</Chip>}>
          <DataTable
            columns={valueColumns}
            rows={globalRows}
            rowKey={(row) => row.key}
            caption="Global platform settings"
            empty={<span className="nx-hint">No global settings are configured.</span>}
          />
        </Card>
      )}

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card
        title="Business override"
        actions={
          context.businesses.length === 0 ? (
            <Chip accent="neutral">no businesses</Chip>
          ) : (
            <Chip accent="indigo">{selectedBusiness?.name ?? 'choose a business'}</Chip>
          )
        }
      >
        <Stack size="lg">
          <form method="get">
            <Row>
              <Select
                id="settings-scope"
                name="business"
                ariaLabel="Business scope"
                defaultValue={selectedBusiness?.id ?? ''}
                options={[
                  { value: '', label: 'Global defaults only' },
                  ...context.businesses.map((business) => ({ value: business.id, label: business.name })),
                ]}
              />
              <Button type="submit" variant="secondary">
                Switch scope
              </Button>
            </Row>
          </form>

          {selectedBusiness === null ? (
            <span className="nx-hint">
              Pick a business to see and change its overrides. Nothing is written until you save, and any key
              left on <strong>Use global default</strong> keeps its platform value.
            </span>
          ) : canManage ? (
            <BusinessSettingsForm
              definitions={editableDefs}
              businessId={selectedBusiness.id}
              overrides={overrideValues}
              overriddenKeys={overriddenKeys}
              inherited={globalValues}
            />
          ) : (
            <DataTable
              columns={valueColumns}
              rows={businessRows}
              rowKey={(row) => row.key}
              caption={`Settings overrides for ${selectedBusiness.name}`}
              empty={
                <span className="nx-hint">
                  {selectedBusiness.name} has no overrides, so every global default applies.
                </span>
              }
            />
          )}

          {(unknownGlobalRows.length > 0 || unknownBusinessRows.length > 0) && (
            <Alert accent="neutral" title="Settings written by another component">
              Some keys in <code>platform_settings</code> are not part of this screen&apos;s catalogue, so they
              are shown read-only rather than guessed at:{' '}
              {[...unknownGlobalRows, ...unknownBusinessRows].map((row) => row.key).join(', ')}.
            </Alert>
          )}
        </Stack>
      </Card>
    </>
  );
}

const valueColumns: readonly Column<PlatformSetting>[] = [
  { key: 'key', header: 'Setting', cell: (row) => <span className="nx-table__mono">{row.key}</span> },
  { key: 'value', header: 'Value', cell: (row) => describeValue(row.value) },
];

/** Renders any jsonb value as text; used only for read-only display. */
function describeValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return <span className="nx-hint">not set</span>;
  if (typeof value === 'boolean') return <Chip accent={value ? 'green' : 'neutral'}>{value ? 'on' : 'off'}</Chip>;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  if (typeof value === 'string') return value;
  return <span className="nx-hint">{JSON.stringify(value)}</span>;
}

/**
 * Maps stored jsonb back onto typed form values.
 *
 * `editableOnly` decides whether a missing boolean key defaults to off (the global
 * form always posts every key, so unchecked really means off) or to "not overridden"
 * (a business row only exists when it was deliberately set).
 */
function toFieldValues(
  definitions: readonly SettingFieldDef[],
  rows: readonly PlatformSetting[],
  editableOnly: boolean,
): SettingFieldValues {
  const byKey = new Map(rows.map((row) => [row.key, row.value] as const));
  const values: Record<string, string | boolean> = {};

  for (const definition of definitions) {
    const value = byKey.get(definition.key);
    if (definition.kind === 'boolean') {
      if (value === undefined && !editableOnly) continue;
      values[definition.key] = value === true;
      continue;
    }
    if (value === undefined) continue;
    values[definition.key] = formatSettingValue(value);
  }

  return values;
}

function formatSettingValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is number => typeof entry === 'number').join(', ');
  }
  return '';
}

function readLocalAuth(value: unknown): boolean {
  if (typeof value === 'object' && value !== null) {
    return (value as { enabled?: unknown }).enabled === true;
  }
  return value === true;
}

function localAuthNote(value: unknown): string | null {
  if (typeof value === 'object' && value !== null) {
    const note = (value as { note?: unknown }).note;
    if (typeof note === 'string' && note.length > 0) return note;
  }
  return null;
}
