# NEXUS — Web app conventions (`apps/web`)

Read this before adding a screen. It is the contract that keeps ~60 screens
consistent, and it is derived from `product/Nexus_CRM_Master_Spec_v1.json`.

## Non-negotiables

1. **The JSON spec is behavioural source of truth.** Figma owns visual language
   only. Never invent a business rule; search
   `product/Nexus_CRM_Master_Spec_v1.json` first.
2. **Never bypass `withActor`.** Every read and write goes through a repository
   function that runs inside `withActor(viewer.actor, …)`. Row-level security in
   Postgres is the authorization boundary — not a `where business_id = …` clause
   written by hand.
3. **Do not add mock data.** Screens read the real database. Empty states are
   expected on a fresh deployment and must look intentional.
4. **Do not hard-code demo names/companies.** The only permitted demo values live
   in `packages/db/seed/fixtures.ts`.
5. **Never expose a service-role credential** to client code, and never add
   anything resembling `execute_sql`.
6. **TypeScript strict.** `pnpm --filter @nexus/web run typecheck` must pass.
   No `any`, no `@ts-ignore`.

## Directory shape

```
apps/web/src/
  app/
    layout.tsx                     root
    login/                         A01 / U01 (done)
    (app)/                         authenticated shell, no business slug
      layout.tsx                   resolves viewer + permission-filtered nav
      my-day/                       U02, my-day/upcoming U03, my-day/done U04
      businesses/                   A10, businesses/new A23
      …
    b/[slug]/                      business-scoped shell
      layout.tsx                   resolves the business or 404s
      overview/                     A02 (done)
      leads/                        A03 (done), leads/[id] A04 (done)
      …
  components/                      client components
  lib/
    actor.ts                       withActor / withServiceRole / Viewer
    db.ts, sql.ts, embedded.ts     connection + drivers
    session.ts, password.ts, auth.ts
    viewer-context.ts              loadViewerContext / resolveBusiness
    repo/*.ts                      repositories (server-only)
```

## Screen recipe

A **server component** page resolves context, calls repositories, and renders the
Nexus UI kit. Interactive pieces are small **client components** in
`src/components/` that call **server actions**.

```tsx
// app/(app)/things/page.tsx
import type { ReactNode } from 'react';
import { Card, DataTable, PageHead } from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import { listThings } from '@/lib/repo/things';

export const dynamic = 'force-dynamic';   // all screens: session-scoped data

export default async function ThingsPage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  const things = await listThings(context.viewer.actor);

  return (
    <>
      <PageHead subtitle="What this screen is for.">Things</PageHead>
      <Card>
        <DataTable … />
      </Card>
    </>
  );
}
```

Business-scoped page:

```tsx
export default async function Page({
  params,
}: {
  readonly params: Promise<{ slug: string }>;   // Next 15: params is a Promise
}): Promise<ReactNode> {
  const { slug } = await params;
  const context = await loadViewerContext();
  const business = await resolveBusiness(context, slug);
  if (business === null) notFound();            // hidden == non-existent
  …
}
```

### Rules that are easy to get wrong

- `params` and `searchParams` are **Promises** in Next 15 — always `await`.
- Every page sets `export const dynamic = 'force-dynamic'`.
- A page may export **only** its default component plus `dynamic`, `metadata`,
  `revalidate`. Helpers live in the same file *without* being exported.
- Repository functions live in `lib/repo/` and start with `import 'server-only'`.
- `resolveBusiness` returning `null` ⇒ `notFound()`. Do not render "forbidden":
  that would confirm a hidden business exists.

## Server actions

Live in `actions.ts` next to the page, with `'use server'` at the top.

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { currentViewer } from '@/lib/current-viewer';
import { doThing } from '@/lib/repo/things';

export interface ActionResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly message?: string;
}

export async function doThingAction(
  _previous: ActionResult,      // useActionState passes the previous state first
  formData: FormData,
): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse({ id: formData.get('id') });
  if (!parsed.success) return { ok: false, error: 'That record could not be found.' };

  const viewer = await currentViewer();
  if (viewer === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  const result = await doThing(viewer, parsed.data.id);   // repo returns MutationResult
  if (result.ok) revalidatePath('/things');
  return { ok: result.ok, error: result.error ?? null, message: result.ok ? 'Done.' : undefined };
}
```

**The actor always comes from `currentViewer()`**, never from form data. Validate
every field with Zod. Return `{ ok, error, message }` so the UI can report the
real reason a write was refused.

## Forms (client)

Inputs inside a `<form action={…}>` must be **uncontrolled** so the browser owns
what is submitted: use `defaultValue` and `name`, and omit `value`/`onChange`.
`TextInput`, `TextArea` and `Select` from `@nexus/ui` support both modes.

```tsx
'use client';
const INITIAL: ActionResult = { ok: false, error: null };

export function ThingForm({ id }: { readonly id: string }): ReactElement {
  const [state, formAction, pending] = useActionState(doThingAction, INITIAL);
  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      <Stack>
        <Field label="Name" htmlFor="thing-name" required>
          <TextInput id="thing-name" name="name" defaultValue="" required />
        </Field>
        {state.error !== null && <Alert accent="red" role="alert">{state.error}</Alert>}
        {state.error === null && state.message !== undefined && (
          <Alert accent="green" role="status">{state.message}</Alert>
        )}
        <Button type="submit" variant="primary" busy={pending}>Save</Button>
      </Stack>
    </form>
  );
}
```

## UI kit (`@nexus/ui`)

Import from `@nexus/ui`; do **not** write new CSS. The classes in
`packages/ui/src/styles.css` are the design language and already cover every
pattern below.

| Component | Use |
| --- | --- |
| `PageHead` | screen title + subtitle + actions |
| `Card`, `Card` `title`/`actions`/`footer` | every panel |
| `Stat` | metric tiles |
| `Grid` `cols={2..4}` / `split` | layout |
| `Stack`, `Row` | vertical / horizontal grouping |
| `Button` variants `primary` `secondary` `ghost` `danger`, sizes `sm`/`md`, `busy` | actions |
| `Field`, `TextInput`, `TextArea`, `Select` | forms |
| `DataTable` with `Column<Row>[]` | every table (`empty` prop for empty state) |
| `Tabs` | in-page sections |
| `Chip`, `LeadStatusChip`, `MessageStateChip`, `DncChip`, `DueChip`, `EnrichmentOffChip` | status |
| `Alert`, `ErrorState`, `EmptyState`, `LoadingState`, `Skeleton` | states |
| `Timeline`, `TimelineItem`, `MessageBlock` | history |
| `Modal` | dialogs |
| `CompanionShell`, `CompanionLeadRow`, `WorkNextBar` | extension only |

Accent semantics are fixed (spec `design_system.layout_notes.status_accents`):
`cyan` new/connection/profile · `green` ready/sent/replied/active · `amber`
follow-up/due/cooldown · `red` overdue/DNC/destructive · `indigo`
business/ICP/configuration. **Always render a label with a colour** — status must
never be conveyed by colour alone.

## Repositories

`apps/web/src/lib/repo/*.ts`, all starting with `import 'server-only'`.

Existing: `common.ts` (paging, coercion, `describeDbError`), `businesses.ts`,
`leads.ts`, `today.ts`, `sequence.ts`, `insights.ts`, `activity.ts`.

Two shapes:

```ts
// list/read — takes an Actor, returns typed rows
export async function listThings(actor: Actor, filter: ThingFilter = {}): Promise<readonly Thing[]> {
  return read(actor, async (sql) => { … });
}

// mutate — takes a Viewer, returns { ok, error }
export async function createThing(viewer: Viewer, input: ThingInput): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => { … return { ok: true, id }; });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}
```

Every query is **parameterised** (`$1`, `$2`); caller text is never interpolated.
Wrap thrown Postgres errors with `describeDbError` so raw SQL never reaches the UI.

## Permissions

`loadViewerContext()` returns `permissions: ReadonlySet<Permission>` (union across
the viewer's business grants; admins get the full set). Gate controls on it:

```tsx
const canManage = context.permissions.has('icp.manage');
```

This only decides what is *rendered*. The database still refuses the write if the
grant does not cover that business — which is the point.

## Accessibility

- Real `<button>`/`<a>` for anything interactive; never a clickable `<div>`.
- Every input has a `<label htmlFor>` (use the `Field` component).
- Errors use `role="alert"`; success uses `role="status"`.
- Do not remove focus outlines; `styles.css` handles focus-visible.

## Verify before you finish

```bash
pnpm --filter @nexus/web run typecheck
pnpm --filter @nexus/web exec next build      # catches route/export mistakes
```

`next build` must list every route you added.

## State of the build

Done: `A01` login · `A02` overview · `A03` leads · `A04` lead detail ·
`U01` login · `U02`–`U04` My Day · `A10` businesses hub.
Everything else in the spec's `screen_inventory` is still to build.

Route prefixes already fixed by `ADMIN_NAV` / `USER_NAV` in
`packages/core/src/permissions.ts` — read those before inventing a route.
