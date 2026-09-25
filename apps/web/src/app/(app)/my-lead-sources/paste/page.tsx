import type { ReactNode } from 'react';

import { Alert, Card, Chip, PageHead, Row, Stack } from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import { buildImportProps } from '@/lib/repo/user-sources';
import { UserImportWizard } from '@/components/user-import';

export const dynamic = 'force-dynamic';

/**
 * U13 — Lead Sources · Paste.
 *
 * Contract: "Paste rows/table; map name/company/title/optional LinkedIn URL; business +
 * ICP."
 *
 * The paste path is the file path with a different input: the same parser splits the
 * table, the same mapper assigns the columns, and the same preview shows duplicates and
 * profile counts. Pasting a block with no header row falls back to the spec's column order
 * (name → company → job title → LinkedIn URL), so a plain copy/paste works.
 */
export default async function MyLeadSourcesPastePage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  const props = await buildImportProps(context.viewer.actor, context.businesses, context.permissions);

  return (
    <>
      <PageHead
        subtitle="Paste a table or a list of rows, then confirm the mapping and the outcome before the import runs."
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href="/my-lead-sources">
              All lead sources
            </a>
            <a className="nx-btn nx-btn--secondary" href="/my-leads">
              My Leads
            </a>
          </Row>
        }
      >
        Lead Sources · Paste
      </PageHead>

      <Card title="Accepted shapes" actions={<Chip accent="indigo">spec lead_sources.paste</Chip>}>
        <Stack size="sm">
          <span className="nx-hint">
            <strong>With a header row:</strong> any order — the header labels are recognised (name / full name,
            company, job title, LinkedIn URL, location, source URL).
          </span>
          <span className="nx-hint">
            <strong>Without a header row:</strong> name, company, job title, LinkedIn URL — the order the spec lists
            the columns in.
          </span>
          <span className="nx-hint">
            Tab, comma and semicolon separated all work; the delimiter is detected from the first line. Quoted fields
            with embedded commas are handled.
          </span>
        </Stack>
      </Card>

      <div style={{ height: 'var(--nx-space-md)' }} />

      {context.businesses.length === 0 && (
        <Alert accent="amber" title="No business access">
          An administrator has not granted you access to a business yet, so there is nowhere to import into.
        </Alert>
      )}

      <UserImportWizard
        mode="paste"
        businesses={props.businesses}
        icps={props.icps}
        canImport={props.canImport}
        defaultBusinessId={props.defaultBusinessId}
      />
    </>
  );
}
