# NEXUS Figma frontend remediation

## Reference set

- `product/figma/Nexus_Admin_Backend_Final.fig` — admin desktop reference at 1440 × 980.
- `product/figma/Nexus_User_CRM_Companion_Final.fig` — user desktop reference at 1440 × 980 and Companion reference at 420 × 820.
- `product/Nexus_CRM_Master_Spec_v1.json` — interaction, permissions, lifecycle, and data-behavior authority.

The implementation preserves the existing repository architecture and backend contracts. This pass changes frontend composition, navigation, styles, and presentation logic; it does not replace persistence, permissions, lifecycle rules, or API behavior.

## Reconstructed surfaces

- Shared admin and user shells: Figma-width sidebars, compact grouped navigation, search, account footer, content bounds, and dense operational layout.
- My Day: Today / Upcoming / Done navigation, summary metrics, Work next behavior, filters, and desktop work queue table.
- My Leads: overview metrics, filters, saved views, lead table, and scoped actions.
- Lead Sources: source cards, import metrics, recent-import table, and links to profile and duplicate review.
- Lead detail: compact action bar, modal action workspaces, prominent history, current action, and structured detail sidebar.
- Admin overview and configuration pages: consistent cards, tables, chips, headings, forms, and business context.

## Shared components and styling

- `AppShell` now presents the seven-item admin information architecture from the final Figma while retaining the permission-filtered route model. The user shell exposes only My Day, My Leads, Lead Sources, and search.
- `MyDayNav`, `TodayList`, and `LeadActionWorkspace` provide reusable Figma-aligned navigation, queue, and contextual-action patterns.
- Shared UI styles define the 238 px admin sidebar, 220 px user sidebar, 1120 px content measure, compact table rhythm, action bars, view tabs, card density, and responsive behavior.
- Corrupted punctuation was normalized across rendered frontend and extension copy.

## Browser acceptance evidence

Chromium checks were performed against the production build using the seeded embedded database.

| Surface | Reference viewport | Result |
| --- | ---: | --- |
| Admin Overview | 1440 × 980 | Shell, summary cards, lead health, sender identities, and table density verified |
| Admin Lead Detail | 1440 × 980 | Action bar, action modal, current action, history, and sidebar verified |
| Admin ICP Manager | 1440 × 980 | Header, metrics, ICP table, configuration form, and scroll behavior verified |
| User My Day | 1440 × 980 | User-only shell, views, metrics, filters, and six-column work queue verified |
| User My Leads | 1440 × 980 | Metrics, filter bar, saved views, and lead table verified |
| User Lead Sources | 1440 × 980 | Metrics, source cards, recent imports, and review links verified |

The checks also verified that admin controls are absent from the user shell and that contextual lead actions open without replacing the detail workspace.

## Intentional remaining differences

- Seed data and counts differ from the static Figma examples; the UI renders live repository data.
- The My Day LinkedIn column can show assignment state when the queue projection does not include the identity display name. No backend projection was broadened for presentation-only parity.
- Long configuration forms continue below the first viewport so all existing behavior remains available; the top-of-page hierarchy and density match the reference.
- The browser extension retains its existing architecture and functional flow; shared typography and copy fixes were applied, but it was not replaced with a standalone mock.

## Backend contracts preserved

- Permission-derived navigation inputs and route guards remain authoritative.
- Business scoping, row-level access, lifecycle transitions, sequence state, import normalization, duplicate review, profile queue behavior, trash semantics, and audit history remain unchanged.
- Lead actions continue to submit through the existing server actions and repositories.
- No database migration, schema change, API contract rewrite, or broad backend modification is part of this remediation.
