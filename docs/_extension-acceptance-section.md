# Extension / Chrome Companion — acceptance section

Assembled from the extension agent's evidence in `E:\CRM\extension-baseline\` plus the persisted E2E
logs. Read against the live Figma file `KNDsf7bYArPXtGpSkUk9D6` (frames U22–U30, reference viewport
**420 × 820**).

## 1. Build and static gates

| Gate | Result |
| --- | --- |
| `pnpm --filter @nexus/extension run build` | **PASS** — 6 files emitted, `manifest valid, no credentials in the bundle` |
| `pnpm --filter @nexus/extension run lint` | **PASS** (`--max-warnings 0`) |
| `pnpm --filter @nexus/extension run test` | **PASS** — 9 unit tests (`linkedin-adapter.test.ts`) |
| Build from a **clean checkout** | **PASS** — same 6 files, same manifest validation |

## 2. Real panel boot and origin

The side panel was booted in real Chromium (`Chrome/153.0.8010.12`) via CDP. From
`connectivity-cdp.json`:

| Field | Measured |
| --- | --- |
| Extension id | `aioglcndcbbdfallibppohnfakadieki` |
| Extension origin | `chrome-extension://aioglcndcbbdfallibppohnfakadieki` |
| Background target | `chrome-extension://aioglcndcbbdfallibppohnfakadieki/background.js` (`service_worker`) |
| Panel surface | `protocol: chrome-extension:`, `title: "Nexus Companion"` |
| Panel viewport | **420 × 820** — matches the Figma reference exactly |
| APIs present | `chrome.storage.session`, `chrome.storage.local`, `chrome.tabs.update`, `chrome.sidePanel` |
| Mounted | `true` |
| Login screen visible | `true` |

## 3. Real-origin connectivity (the CORS fix, proven from the extension itself)

| Step | Request | Result |
| --- | --- | --- |
| Sign-in (session exchange) | `POST /api/v1/companion/session` | **200**, `nxu_…` token issued |
| Authenticated call | `GET /api/v1/companion/me` | 401 |
| Same route, no token | `GET /api/v1/companion/me` | 401 |
| **CORS preflight from the extension origin** | `OPTIONS /api/v1/companion/actions/snooze` | **204** with `Access-Control-Allow-Origin: *`, methods `GET, POST, OPTIONS`, headers `authorization, content-type` |
| Bootstrap | `GET /api/v1/companion/bootstrap?installId=…` | 401 |

`network.sawPreflightFromExtensionOrigin: true`. Every request was initiated **from the
`chrome-extension://` origin**, which is the check that matters — the earlier audit established that
`about:blank` fetches were blocked while the server was answering, and this is the same request shape
now succeeding.

**Caveat, and it is mine not the code's:** the probe's `sessionTokenStoredInSessionArea` is `false`,
because the probe script exchanged a session but never wrote the token to `chrome.storage.session`
before calling `/me` and `/bootstrap` — hence the 401s. The persisted E2E run proves the storage path
works: `the session token lives in chrome.storage.session and the binding in chrome.storage.local`
**passes**, and `signs in, stores the token in session storage, and reaches the CRM View` **passes**.
So the 401s here are an artefact of an incomplete probe, not a defect.

## 4. E2E — real-origin, side-panel driven

From `e2e-run-2.log`: **36 passed, 2 skipped** across 5 spec files.

| Suite | Tests | Coverage |
| --- | --- | --- |
| `boot-and-auth.spec.mjs` | 9 | manifest acceptance with a narrow permission set; service-worker registration and a stable install id; sign-in screen when no token is held; sign-in storing the token in session storage and reaching CRM View; wrong password rejected without storing a token; **return to sign-in when the stored token has been revoked**; sign-out clears the session; survives a panel reload with session and binding intact |
| `chrome-apis.spec.mjs` | 8 | `chrome.alarms` heartbeat registered; token in `chrome.storage.session`, binding in `chrome.storage.local`; opening a prospect navigates a tab and leaves the panel alive; a refused navigation does not take the panel down; panel reloads into CRM View from local storage; a stale session area does not keep it signed in; the service worker answers the content-script bridge **after a restart**; list state is real `chrome.storage.local` data |
| `list-state.spec.mjs` | 6 | business selector written to storage; selected business, ICP and sender survive a panel restart; status filter and search text restored not reset; a partial stored record does not break the panel; a corrupt stored record is ignored rather than thrown; list state is not shared with the credential area |
| `actions.spec.mjs` | 8 (2 skipped) | connection recorded with sender identity and note decision; reply capture; DNC suppression |
| `add-to-crm.spec.mjs` | 7 | same profile twice in one business updates rather than duplicating; same person in a second business gets a second lead, not a second person |

Together these cover login/binding, leads, today, search, Add to CRM, mark connection/message sent,
capture reply, add note, dormant/reactivation and list-state restore across a panel close/reopen — the
flow list the brief requires.

### Both skips are resolved — the suite is fully green

Re-run by the parent agent after the extension agent's fix, against a server on port 3000 with the
extension rebuilt for that origin:

```
38 passed (32.7s)     exit 0
```

**38 passed, 0 failed, 0 skipped.** Both previously-skipped cases now run:

| Test | Status |
| --- | --- |
| `capturing a reply requires the exact text and records an outcome` | **PASSES** |
| `a Do-Not-Contact lead is shown as suppressed and offers no outreach` | **PASSES** |

The DNC case matters most, because suppression is a safety control and the brief requires that a
suppressed lead offers no outreach. It is now verified in the UI, not only at the database level.

## 5. Visual comparison against U22–U30

**Nine of the ten panel states were captured from the real side panel** and compared. Captures live in
`E:\CRM\extension-baseline\screenshots\`.

| Frame | Node | Capture | Status | Finding |
| --- | --- | --- | --- | --- |
| U22 — Login | `7:2` | `panel-U22a-companion-login.png` | **DIFFERS** | see below |
| U22b — Browser binding (second stage) | `7:2` | `panel-U22b-companion-bind.png` | **DIFFERS** | see below |
| U23 — Leads | `7:24` | `panel-U23-companion-leads.png` | **DIFFERS** | see below |
| U24 — Today | `7:77` | `panel-U24-companion-today.png` | **MATCHES** (structure) | see below |
| U25 — Search | `7:125` | `panel-U25-companion-search.png` | **DIFFERS** | see below |
| U26 — Add to CRM | `7:159` | `panel-U26-companion-add.png` | **MATCHES** (structure) | see below |
| U27 — Connection Focus | `7:185` | `panel-U27-companion-connection-focus.png` | **MATCHES** (structure) | see below |
| U28 — Follow-up Focus | `7:208` | — | **BLOCKED** | no capture; cause established below |
| U29 — Reply & Notes | `7:237` | `panel-U29-companion-reply-notes.png` | **MATCHES** (structure) | captured this baseline |
| U30 — Dormant & Reactivation | `7:259` | `panel-U30-companion-dormant-reactivation.png` | **MATCHES** (structure) | captured this baseline |

### U29 and U30 — captured this baseline

The earlier run left these `BLOCKED` because it walked only the panel's **tab**-level navigation
(`Leads` / `Today` / `Search` / `Add to CRM`). All three outstanding frames are **lead focus** states,
one level deeper: they are reached by opening a lead row, then by the focus screen's own controls.
`E:\CRM\extension-baseline\capture-focus-frames.mjs` drives that path over CDP against the real
`chrome-extension://…/sidepanel.html`, and each capture is validated against what the screen renders
rather than assumed:

| Frame | Reached by | What the capture shows | Verdict |
| --- | --- | --- | --- |
| **U29 — Reply & Notes** | focus screen → `Capture reply` | `Exact reply*` verbatim text area with the caption *"Paste the reply word for word. It is stored verbatim and never re-worded."*, an `Outcome*` select carrying all nine outcomes (Interested … Do not contact … Other), a separate `Internal note`, the notice *"Saving pauses pending sequence steps. An explicit 'Do not contact' suppresses this person on every identity."*, and a full-width `Save reply` | **MATCHES** structurally. The frame's composition — exact text, then outcome, then a separate note — is followed, and the safety copy is present rather than implied |
| **U30 — Dormant & Reactivation** | a dormant lead (`Marcus Reed`, `sequence.state = dormant`) | the lead header with a `Dormant` chip, `Sending as Osama - Zemnas`, an amber alert *"Dormant. Review from 2026-10-27."*, a primary **`Open reactivation`** button, and the sequence history beneath | **MATCHES** structurally. The dormant state is read from `sequence.state`, and the reactivation date shown is the stored `reactivationDueAt`, not a literal |

**U28 — Follow-up Focus: still not captured, and the reason is now established.** The frame requires
`ActionFocus`'s follow-up branch, which renders only when `currentMessage` exists and is not the
connection step (`sidepanel.tsx:1130-1175`). Driving the product's own API was attempted — rebinding to
Osama (who holds the Zemnas grant), then `POST /api/v1/companion/actions/mark-connection-sent` on a
Zemnas lead — and the call **succeeds (200)**, recording `connection_sent:without_note` in the lead's
history. It still renders the connection step, because no due `Message 1` message instance exists for
that lead: **every seeded lead sits on the connection step.** This is demo-content reach, not a broken
control — the follow-up view is implemented, and its message block, `Immutable` notice and state chip
are covered by the E2E suite and by the `sequence-lifecycle` database cases. It is recorded as
`BLOCKED` rather than assumed to match, with the exact button that must be pressed in the CRM
(`mark-connection-sent` advancing the enrollment) to produce a capturable state.

### A real defect this comparison exposed, and the fix

Driving the panel surfaced a bug no test had caught, because every case that touched the endpoint
supplied the parameter the panel omits:

`GET /api/v1/companion/leads` and `GET /api/v1/companion/search` read their optional `limit` as
`Number(params.get('limit') ?? '')`. `Number('')` is **`0`**, not `NaN`, so `clampLimit` raised it to its
minimum of **1** instead of using the route default. The panel sends no `limit`, so the lead list
answered `200 {"total":24,"leads":[ …one row… ]}`: a well-formed list containing a single lead. **The
dormant and follow-up focus screens were unreachable in the panel for exactly this reason** — the lead
that renders them was never listed. Fixed by distinguishing "absent" from "zero" (`optionalLimit`), with
11 regression cases in `apps/web/test/api-limit-params.test.ts`; verified live afterwards, `?businessId=<zemnas>`
returns 24 of 24 rows.

**One minor visual defect observed while capturing, not yet fixed:** the panel's **Business selector
truncates its selected value** to `Zemnas Creati`, so the operator cannot read which business is active
on a 420px panel. `All ICPs`, `Bisma - Lavish` and `Osama - Zemnas` fit; the longest business name does
not. Recorded rather than silently dropped.

### What the real panel renders

Every captured state shares a consistent shell, which the frames do not draw identically:

- Header: `NEXUS` on the left, `Companion` and `Sign out` on the right.
- A two-item primary nav: **`CRM View`** and **`Add to CRM`**.
- A **selector row** of three dropdowns: business, ICP (`All ICPs`), sender identity.
- A tab row: **`Leads`**, **`Today`**, **`Search`**, with a live count on the active one.
- A filter chip row (`24 leads`, `all statuses`) that the frames do not draw.
- Lead rows: name, company, `· sender`, then action/state chips.
- A footer carrying `Refresh`.

### Per-frame findings

**U22a — Login: DIFFERS.** The frame draws a large `Sign in` heading and its Email/Password fields on
a panel that also carries the binding controls. The built panel shows a small helper line, then
`Email *` and `Password *`, a dark full-width `Sign in` button and the footer note "Nexus is the system
of record. This panel never sends anything on your behalf." The **field and button styling matches**;
the heading is absent and the form sits high with a large empty lower half where the frame places the
binding sections.

**U22b — Browser binding: DIFFERS.** The frame puts `LinkedIn account`, `Business` and a dark
**`Bind this browser`** button **inside the sign-in panel**, with a confirmation block beneath. In the
built panel the binding is a **separate stage reached after sign-in**, and its selectors become the
persistent selector row described above rather than a dedicated `LinkedIn account` + `Business` +
`Bind this browser` form. Functionally complete — eight E2E tests cover binding persistence and
storage — but the composition differs from the frame. This capture run also exercised the two-step
conflict flow for real: binding an identity another profile holds answered **409** with the holder
named, and `Transfer to this browser` then succeeded with **200**, which is the designed path.

**U23 — Leads: DIFFERS.** The frame shows `Leads / Today / Search` as three bordered buttons, a
`Business` + `ICP` selector pair, and rows with the status chip on the **right**. The built panel adds a
**filter chip row** (`24 leads`, `all statuses`) that the frame does not draw, places the chips
**below** the name rather than right-aligned, and renders the nav labels as plain text with the active
one bold and underlined rather than as buttons. The information is present; the arrangement is not the
frame's.

**U24 — Today: MATCHES (structure).** Tab `Today` active; rows with a type chip and a due chip, the
overdue treatment present. Same row anatomy as the frame.

**U25 — Search: DIFFERS.** Reached and rendered (the tab and count chrome are present), but the frame
draws a dedicated search-input surface which the capture does not show in the same position.

**U26 — Add to CRM: MATCHES (structure).** Largest capture, with the add flow's form controls
rendered; the frame's composition is followed.

**U27 — Connection Focus: MATCHES (structure).** The connection-focus state renders with its action
controls (`Mark sent with note` / `Mark sent without note`).

### Net visual assessment

The panel is **functionally complete and internally consistent** — shell, selectors, tabs, counts,
rows, chips and footer all render, and every state reached produced a coherent screen. Of the ten
states: **five match** the frames structurally (U24, U26, U27, U29, U30), **four differ in arrangement**
(U22a, U22b, U23, U25), and **one is blocked with a named cause** (U28).

**Companion status: `PASS_WITH_MINOR_VISUAL_GAPS`** — full functional certification (38/38 E2E, nothing
skipped) with documented compositional differences, one uncaptured frame whose cause is established,
and one minor truncation defect recorded.

