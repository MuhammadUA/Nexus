# NEXUS V1.2 — UI Acceptance

What each V1.2 screen must show and do, written as an acceptance checklist so a
reviewer can verify the branch without reading the code. Reference:
`product/NEXUS_V1_2_MASTER_SPEC.md` §30–§39, §52–§54.

## 0. Visual language (unchanged from V1.1)

Light/off-white surfaces, cool gray structure, restrained cyan/indigo accents,
thin borders, compact professional density, clear typographic hierarchy, no gaming
dashboard, no excessive whitespace, desktop-first at 1440×980. V1.2 changes the
information architecture and the intelligence shown, not the palette.

## 1. Navigation and access (spec §38, §53)

- Top-level IA stays compact: **WORK** (Overview, Leads), **CONFIGURE** (Business
  Setup, Team & Accounts, Integrations), **ADMIN** (Insights, Settings).
- Secondary navigation carries Agent Jobs, Channel Accounts, AI, Automations,
  Imports, Access. No 25-item sidebar.
- Secondary links are real tabs: distinguishable, keyboard focusable, with a
  visible active state. The V1.1 defect where two links rendered as one
  concatenated string (`Outreach IdentitiesMy Access`) is gone.
- Admin / Manager / User visibility is preserved, server guards still decide, and a
  hidden business is not disclosed by a link, a count or an error message.

## 2. Leads table V1.2 (spec §30)

Columns: Person, Company, title/location, enrichment status, completeness, source,
ICP, fit/intent, channels, owner, next action, latest signal, AI-context
readiness.

- [ ] Enrichment status and completeness come from `lead_enrichment`; a lead with
      no row reads as `MINIMAL` / 0 rather than as an error or a blank cell.
- [ ] Completeness renders as `Lead intelligence NN%`.
- [ ] Row actions: Open, Find LinkedIn, Enrich, Research Company, Create Agent Job,
      Draft Outreach.
- [ ] Find LinkedIn / Search Person / Search Company / Search Signals open the
      deterministic Google URLs in a new tab. No model call is made to build them.
- [ ] Research Company reports whether it created a job or found an open one.
- [ ] Pagination with a visible total; every row is reachable. Filters include
      enrichment status and keep the existing filters working.

## 3. Lead Detail V1.2 — intelligence first (spec §31, §32)

Order, top to bottom:

1. **Header** — person, title, company, location, sales status, enrichment status,
   `Lead intelligence NN%`, ICP/intent, available channels, and links to the
   LinkedIn profile and the company site.
2. **AI Opportunity Brief** — why this lead, the signals behind it, the recommended
   angle, a confidence figure, a link to the evidence, and a refresh action. When
   no brief exists yet the screen says so and offers the action that would create
   one; it never renders an invented brief.
3. **Person / Company / Contacts** — structured facts, with user-confirmed values
   visually distinguishable from AI-extracted ones, and `person_contact_points`
   listed with their kind and confidence.
4. **Enrichment workspace** — shown while incomplete: known fields, the generated
   Google queries each with an "Open Google Search" action, a LinkedIn URL input, a
   clearly temporary raw-paste textarea, and "Enrich with AI".
   - [ ] After success the textarea is **empty**, the screen states that the raw
         paste was deleted, the structured results and minimal provenance are
         shown, and the enrichment state advanced.
   - [ ] The discarded raw text is never re-displayed, on reload or on any
         subsequent render.
5. **Source / provenance** — source type, source URL, observed time, content hash,
   collector agent, agent job id, prompt version, model, extraction time,
   confidence. No retained raw body.
6. **Outreach** — LinkedIn / Email / Instagram / Upwork with account, state and next
   action. A lead discovered on Reddit can be contacted by email; a lead discovered
   on LinkedIn can be contacted on Upwork. Source never restricts channel.
7. **AI draft** — channel-specific, preserving DYNAMIC / LOCKED / SENT and the
   immutability of sent content exactly as V1.1 did.
8. **Timeline** — human, message, reply, enrichment and agent-job events. No
   research dump.
9. **Tasks** — unchanged behaviour.

Async work never looks instantaneous: a processing indicator shows source captured
→ person resolved → company resolved → profile extraction → company research
pending → qualification pending (spec §39).

## 4. Agent Jobs (spec §33)

- Summary: OPEN, RUNNING, WAITING AI, FAILED, DONE TODAY.
- Rows: priority, type, entity, business, status, agent, lease (with an explicit
  *expired* state), attempts, created/updated.
- Actions: create, retry (FAILED/CANCELLED only), cancel, release stale claim, open
  entity.
- [ ] There is **no** manual "complete" action anywhere on the screen.
- Filters and paging; the total is visible and every job is reachable.

## 5. Overview V1.2 (spec §34)

Active Leads, Needs Enrichment, Agent Jobs Open, Waiting AI, Ready for Outreach,
Replies Today, AI usage today (runs / tokens / estimated cost), Failed enrichments
— plus an enrichment funnel, agent activity and recent signals/activity. Every
number is a real query result; an empty series shows a truthful empty state rather
than a fabricated figure.

## 6. AI settings (spec §26, §27)

Business Setup gains an **AI** tab alongside Overview, ICPs, Sequences, Knowledge
and Signals.

- Provider state: configured / not configured, with model and endpoint. The API key
  is never rendered, not even truncated.
- Per prompt key: active version, model, temperature, max output, status, and the
  version history with an admin-only Activate action.
- AI usage for the business: today's runs, tokens in/out, estimated cost, cache-hit
  ratio.
- A non-admin sees the state but no activate control, and the server refuses a
  forged activation attempt.

## 7. Channel Accounts (spec §10)

The Outreach Identities screens are re-vocabularised as **Channel Accounts**, with
LinkedIn, Email, Instagram and Upwork first-class. The channel is shown per
account, the legacy platform is retained as secondary history, and the existing
per-identity business-access model (and therefore the Companion LinkedIn binding)
is unchanged.

## 8. Companion V1.2 (spec §36)

- Secure MV3 behaviour preserved; no database credential, service-role key or
  provider key anywhere in the bundle.
- Bind UX: the business selector lists only businesses valid for the selected
  channel account, switching the account recalculates the list, a global admin's
  effective visibility is handled, no eligible business disables Bind with a
  specific explanation, and a crafted invalid pair is refused server-side.
- Leads / Today / Search show an enrichment indicator (status + intelligence %).
- Add to CRM accepts a minimal lead (name, company, location, source, optional
  title/headline/snippet) and shows the deterministic Find-LinkedIn search.
- Profile paste can feed the same enrichment pipeline; the server owns the raw
  lifecycle.

## 9. Performance and safety (spec §47, §48)

- No AI call on any normal page render.
- Structured DB reads only; independent reads in parallel; no repeated
  viewer/business query waterfall.
- Long lists paginate; raw content and full history load only on request.
- No `NEXT_PUBLIC_*` secret, no service-role key, nothing key-shaped in a client
  component. RLS, audit, SENT immutability and DNC behaviour are unchanged.
