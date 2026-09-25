# Nexus Companion — Extension Acceptance Audit

**Environment.** Chromium **153.0.8010.12**, the build Playwright ships (not branded Chrome, which
refuses `--load-extension` from version 137 on), launched as a **headed persistent context** with the
extension from `apps/extension/dist` loaded via `--load-extension`. A real
`chrome-extension://<id>/` origin, the real service worker, and the real `chrome.*` surface.

**Extension id observed for this run:** `dddhbhgmahamjkkhaodkofeiocjolmnl` (derived from the loaded
path, so it changes with the checkout location — nothing depends on a fixed id).

**How to reproduce.**

```bash
pnpm --filter @nexus/extension run build          # builds dist/, validates the manifest, scans for secrets
pnpm --filter @nexus/extension run e2e            # the 38 E2E cases in apps/extension/e2e
pnpm --filter @nexus/extension run e2e:probe      # boot smoke test on its own
pnpm --filter @nexus/extension run package        # produces dist/nexus-companion.zip
```

**Results: 36 passed, 2 skipped, 0 failed** (`apps/extension/e2e`, 5 spec files).

---

## 1. How the panel was driven, and what that means for the evidence

Chrome renders a side panel inside a browser window with the toolbar, which cannot be driven from
CDP. The panel document is therefore opened as a tab: `chrome-extension://<id>/sidepanel.html`. That
is the **same document the side panel renders**, at the same 420×820 reference size, with the same
`chrome.storage`, `chrome.tabs` and `chrome.runtime` implementations. What it does not exercise is
Chrome's own panel chrome — the toolbar icon, `sidePanel.open()`, and the panel staying pinned beside
a LinkedIn tab. That is called out as `UNVERIFIED` in §12 rather than glossed.

One measured consequence worth recording: **Playwright's locator engine does not resolve elements in
a `chrome-extension://` document.** `page.locator(...)` and `getByRole(...)` reported nothing for a
tab strip that was demonstrably on screen, while `document.querySelector` found it immediately. Every
helper in `e2e/helpers.mjs` therefore queries the DOM through `page.evaluate` / `waitForFunction`. A
test that trusted locators here would have reported the panel as broken when it was working.

---

## 2. Boot

| # | Test | Automated | Real extension | Real Chrome API | LinkedIn | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Boots as a real extension origin, panel mounted | yes | yes | yes | n/a | **VERIFIED** | `e2e:probe`; `boot-and-auth.spec.mjs` |
| 2 | Manifest the browser accepted has the narrow permission set | yes | yes | yes | n/a | **VERIFIED** | read via `chrome.runtime.getManifest()` |
| 3 | Service worker registered; install id generated, stable, not a fingerprint | yes | yes | yes | n/a | **VERIFIED** | `background.js` worker URL; UUID shape asserted |
| 4 | `chrome.alarms` available and the heartbeat alarm is registered at 5 minutes | yes | yes | yes | n/a | **VERIFIED** | `chrome-apis.spec.mjs` |
| 5 | No console errors or unhandled exceptions on boot | yes | yes | yes | n/a | **VERIFIED** | console and `pageerror` listeners, asserted empty |

Boot details: `manifest_version 3`, `name "Nexus Companion"`, `version 1.0.0`, worker
`background.js`, panel `sidepanel.html`, viewport exactly 420×820, `chrome.storage.local`,
`chrome.storage.session`, `chrome.tabs.update`, `chrome.tabs.sendMessage` and `chrome.alarms.create`
all present as real functions.

---

## 3. Authentication

| # | Test | Automated | Real extension | Real Chrome API | LinkedIn | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 6 | Sign-in screen shown when no token is held | yes | yes | yes | n/a | **VERIFIED** | `boot-and-auth.spec.mjs` |
| 7 | Sign in succeeds, token stored in `chrome.storage.session` | yes | yes | yes | n/a | **VERIFIED** | token matches `nxu_…`; absent from `local` |
| 8 | Token never written to disk | yes | yes | yes | n/a | **VERIFIED** | `chrome.storage.local` serialised and asserted |
| 9 | Wrong password is refused and no token is written | yes | yes | yes | n/a | **VERIFIED** | alert shown, still on sign-in |
| 10 | A revoked/unknown token returns the panel to sign-in and is cleared | yes | yes | yes | n/a | **VERIFIED** | 401 from bootstrap; token polled until gone |
| 11 | Sign out clears the session and returns to sign-in | yes | yes | yes | n/a | **VERIFIED** | sign-out button in the shell |
| 12 | Session and binding survive a panel reload (close/reopen) | yes | yes | yes | n/a | **VERIFIED** | reload, then CRM View and a loaded list |
| 13 | Clearing `chrome.storage.session` signs the panel out; binding kept | yes | yes | yes | n/a | **VERIFIED** | models the browser closing |
| 14 | Login request is not blocked by auth middleware | yes | yes | yes | n/a | **VERIFIED** | `POST /companion/session` → 200 from the extension origin |
| 15 | CORS permits the extension origin | yes | yes | yes | n/a | **VERIFIED** | the request above succeeds where it was previously blocked |

**Two blocking defects were found and fixed here.**

1. **The panel never mounted.** `sidepanel.tsx` exported the component; nothing called `createRoot`.
   The bundle loaded, exported a component, and rendered nothing. Added `src/mount.tsx` as the build
   entry.
2. **Sign-in could never succeed.** `api.signIn` went through the same request wrapper as every
   authenticated call, and that wrapper returns `'Sign in to Nexus Companion.'` when no token exists —
   so the button reported an error without ever reaching the server. The wrapper now takes
   `authenticated: false` for the session exchange.

---

## 4. Browser binding

| # | Test | Automated | Real extension | Real Chrome API | LinkedIn | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 16 | First bind creates a session for this profile | yes | yes | yes | n/a | **VERIFIED** | `companion-binding.test.ts` + E2E |
| 17 | Reopening the same browser keeps the binding | yes | yes | yes | n/a | **VERIFIED** | `nexus.binding` compared across a reload |
| 18 | Changing the default business persists | yes | yes | yes | n/a | **VERIFIED** | binding row updated |
| 19 | Switching to another permitted identity re-points the profile's own row | yes | yes | yes | n/a | **VERIFIED** | one active session, not two |
| 20 | Identity in use elsewhere shows a warning naming the holder and last-active time | yes | yes | yes | n/a | **VERIFIED** | 409 with `conflicts[]`; panel renders both facts |
| 21 | Cancel leaves the existing holder untouched | yes | yes | yes | n/a | **VERIFIED** | holder row still `active`; no new session |
| 22 | Transfer revokes the holder and activates this profile | yes | yes | yes | n/a | **VERIFIED** | holder `revoked` with `revoked_at`; audit row written |
| 23 | An operator without transfer permission is refused (403) | yes | yes | yes | n/a | **VERIFIED** | `transfer_not_permitted`; nothing written |
| 24 | An administrator may transfer | yes | yes | yes | n/a | **VERIFIED** | `companion-binding.test.ts` |
| 25 | Sign out then rebind | yes | yes | yes | n/a | **VERIFIED** | E2E sign-out then sign-in and bind |
| 26 | Revoked browser session is no longer active | yes | yes | yes | n/a | **VERIFIED** | `status = 'revoked'` |
| 27 | Install id is stable and not a device fingerprint | yes | yes | yes | n/a | **VERIFIED** | generated UUID, survives reload |

**The concurrent-identity gap is closed.** The previous implementation revoked an existing session as
a side effect of any bind. It is now two explicit steps: a bind that would take a live identity
returns `409` **with the holder's name and last-active time** and writes nothing; the panel offers
*Cancel* / *Transfer to this browser*; only an explicit `transfer: true` revokes, and the revocation
happens **in the same transaction as the bind**, so there is no window where the identity is released
but not yet taken. The transfer is audited in `audit_events` as `identity_transfer` with the ids it
revoked. Permitted for an administrator or an admin-level grant; refused with `403` otherwise.

Two further defects were fixed on this path: `browser_sessions_active_identity_key` refused a
*re-bind by the same profile* (the row is now reassigned rather than inserted), and
`validate_browser_session_identity` required a globally-managed identity so a business-level
administrator was refused a bind they were entitled to.

---

## 5. Chrome API behaviour

| # | Test | Automated | Real extension | Real Chrome API | LinkedIn | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 28 | `chrome.tabs.update(...)` navigates a tab and the panel survives | yes | yes | yes | n/a | **VERIFIED** | `chrome-apis.spec.mjs`; navigation is local, the assertion is the panel staying mounted |
| 29 | A refused navigation does not take the panel down | yes | yes | yes | n/a | **VERIFIED** | idem |
| 30 | `chrome.tabs.query`/`sendMessage` reachable from the panel | yes | yes | yes | n/a | **VERIFIED** | idem |
| 31 | The service worker answers the message bridge after a restart | yes | yes | yes | n/a | **VERIFIED** | worker URL + round trip |
| 32 | Heartbeat alarm registered, 5-minute period | yes | yes | yes | n/a | **VERIFIED** | `chrome.alarms.getAll()` |
| 33 | `chrome.storage.session` cleared when Chrome discards it → sign-in again, binding kept | yes | yes | yes | n/a | **VERIFIED** | idem |

**Panel lifecycle.** "Side Panel closed and reopened" is modelled as a document reload with the same
profile (§3 #12, #13): memory is gone, `chrome.storage` is not. **Browser restarted** is modelled as
clearing `chrome.storage.session` while keeping `local` (§3 #13), which is what Chrome does.

**Heartbeat.** The alarm fires every 5 minutes and calls `heartbeat` + `bootstrap` only when a
binding exists, so an unbound panel produces no traffic. A session that stops heartbeating stops
counting as live after 15 minutes (`STALE_SESSION_MINUTES`), which is what keeps the concurrency
warning truthful and stops a closed profile locking an identity out for ever. **Whether the alarm
actually fires on schedule in a long-lived browser is `UNVERIFIED`** — the test asserts the
registration and the period, not a 5-minute wall-clock firing.

---

## 6. CRM View

| # | Surface | Automated | Result | Evidence |
| --- | --- | --- | --- | --- |
| 34 | `#/leads` — list loads real leads, opening one shows its context | yes | **VERIFIED** | `actions.spec.mjs`; screenshot shows the focus screen |
| 35 | `#/today` — due work, or a stated empty state | yes | **VERIFIED** | idem |
| 36 | `#/search` | yes | **VERIFIED** | `add-to-crm.spec.mjs` uses it to observe what was created |
| 37 | `#/add` — Add to CRM | yes | **VERIFIED** | §7 |
| 38 | `#/focus/:leadId` | yes | **VERIFIED** | `actions.spec.mjs` |
| 39 | `#/reply/:leadId` — reply capture requires the exact text | yes | **VERIFIED** | idem |
| 40 | `#/reactivate/:leadId` — reachable; previous sequence shown | partial | **PARTIALLY VERIFIED** | the screen and its "Open reactivation" action render; the dormant→reactivation transition is not driven end to end |
| 41 | One implementation for admin and user, role only widens the selectors | yes | **VERIFIED** | one `SidePanel`; the shell is identical, and `/companion/bootstrap` intersects business access with each identity's access |

---

## 7. Add to CRM — canonicalization and dedupe

| # | Case | Automated | Result | Evidence |
| --- | --- | --- | --- | --- |
| 42 | New prospect → person + company + lead, immediately searchable | yes | **VERIFIED** | `add-to-crm.spec.mjs` |
| 43 | Same profile offered twice in one business → updates, no duplicate lead | yes | **VERIFIED** | `created: false`, `deduped: true`, same `leadId`, one lead |
| 44 | URL with tracking parameters → same person | yes | **VERIFIED** | same `leadId` |
| 45 | Existing person, second business → second lead, **not** a second person | yes | **VERIFIED** | `created: true` for a new business; the global unique key would have refused a fork |
| 46 | Person already in the same business → existing lead updated | yes | **VERIFIED** | #43 |
| 47 | Profile-queue lead → existing partial lead updated, capture completed | partial | **PARTIALLY VERIFIED** | the capture path is exercised; the queue→capture→completed transition is asserted at the repository level, not through the panel |
| 48 | Source evidence preserved | yes | **VERIFIED** | `ingest_requests` row written with content hash per capture |

**Two blocking defects were found here.**

1. **Add to CRM always failed.** The route wrote `status = 'completed'` to `ingest_requests`, but
   `ingest_requests_status_check` allows `received`, `processed`, `failed`, `duplicate`. The log row is
   in the same transaction as the lead, so the check violation rolled the whole capture back — every
   Companion capture returned "The capture could not be saved." and created nothing. Now writes
   `processed` (or `duplicate`).
2. **The person dedupe lookup could not see its own record.** The lookup ran under `people`'s RLS
   policy, `person_visible(id)`, which is false for a Person whose Lead is not in a business the actor
   can reach — so the second capture found nothing and the insert hit
   `people_normalized_linkedin_key`. Added `find_person_id_by_linkedin_url(text)`: a `security
   definer` helper that normalizes through the same `normalize_linkedin_url` the write trigger uses and
   returns an id and nothing else.

Also fixed while testing: a non-LinkedIn URL was accepted, because the database normalizer strips any
scheme and leading `www.`, so `https://example.com/in/x` produced a non-null key. The route now
requires the parsed host to be `linkedin.com` and a member slug to exist.

---

## 8. Action flows

| # | Flow | Automated | Result | Evidence |
| --- | --- | --- | --- | --- |
| 49 | Connection Focus → *Mark sent with note* / *without note* | yes | **VERIFIED** | `actions.spec.mjs`; buttons present on a `connection_due` lead |
| 50 | Follow-up Focus → *Edit* / *Copy* / *Mark sent* | partial | **PARTIALLY VERIFIED** | the focus screen and *Mark sent* render and are driven; *Edit*/*Copy* are present but their clipboard and edit paths are not asserted |
| 51 | Sent message version frozen; next step scheduled | partial | **PARTIALLY VERIFIED** | the API is called and returns success; immutability and next-step scheduling are asserted in `packages/db/test/immutability.test.ts` and `sequence-lifecycle.test.ts`, not re-asserted through the panel |
| 52 | Reply capture: exact text, outcome, internal note, sequence pauses | yes | **VERIFIED** (negative path) | saving with no text is refused; the accepted path is covered by the repository tests |
| 53 | Reply outcomes: Interested / No current need / Not interested / Wrong person / Do not contact | partial | **PARTIALLY VERIFIED** | the full vocabulary renders; each outcome is stored through `captureReply`, whose behaviour is covered by `packages/db/test/dnc-and-replies.test.ts` |
| 54 | DNC suppresses across every sender identity; switching cannot bypass it | partial | **PARTIALLY VERIFIED** | the panel shows DNC and the suppression is global per person in the database and enforced by `block_dnc_message`; the E2E case skipped because the seeded DNC lead is not in the first page of the list |
| 55 | Snooze presets move the lead out of the due list | yes | **VERIFIED** | `actions.spec.mjs`, after a production defect was fixed (§10) |
| 56 | Dormant → Reactivation with previous sequence and a fresh angle | partial | **PARTIALLY VERIFIED** | the screen renders and offers *Open reactivation*; the transition is not driven end to end |

---

## 9. List-state restoration

`spec companion_extension.list_state_preservation` — business, ICP, sender, status filter, search,
pagination, scroll and selected row surviving a lead open and a return. Persisted to
`chrome.storage.local`, which is what makes it survive Chrome reclaiming the panel.

| # | Test | Automated | Result | Evidence |
| --- | --- | --- | --- | --- |
| 57 | Changing the business selector is written to `chrome.storage.local` | yes | **VERIFIED** | `list-state.spec.mjs` |
| 58 | Selected business survives a panel restart | yes | **VERIFIED** | selector shows the stored value, not the default |
| 59 | Status filter and search restored, not reset | yes | **VERIFIED** | idem |
| 60 | A partial stored record falls back field by field | yes | **VERIFIED** | unknown field kept, absent ones empty |
| 61 | A corrupt stored record is ignored rather than thrown | yes | **VERIFIED** | panel alive and usable |
| 62 | List state is not shared with the credential area | yes | **VERIFIED** | `listState` in `local`, token in `session` only |
| 63 | Scroll position restored to the same row | partial | **PARTIALLY VERIFIED** | a real defect was fixed (§10) and the ratio is persisted; the visual landing position is not asserted, because a 1-lead list has no scroll range |

---

## 10. Defects found and fixed in this pass

| # | Defect | Where | Verified by |
| --- | --- | --- | --- |
| 1 | The panel never mounted — nothing called `createRoot` | `src/mount.tsx`, `scripts/build.mjs` | boot probe, boot spec |
| 2 | Sign-in always failed without contacting the server | `src/api.ts` (`authenticated: false`) | auth spec |
| 3 | The companion API had no CORS headers | `apps/web/middleware.ts` | auth spec |
| 4 | Binding an in-use identity failed with "That record already exists." | `lib/repo/companion.ts` (reassign the profile's row) | binding tests |
| 5 | A business-level administrator was refused a bind they were entitled to | migration 0017 (policy and trigger share `manages_outreach_identity`) | binding tests |
| 6 | **Snooze always failed** — wrote `interactions.type = 'snooze'`, which `interactions_type_check` forbids | migration 0018 | actions spec |
| 7 | **Add to CRM always failed** — wrote `ingest_requests.status = 'completed'`, which the check forbids, rolling back the capture | `api/v1/companion/add/route.ts` | add-to-crm spec |
| 8 | Person dedupe could not see its own record under RLS | migration 0019 (`find_person_id_by_linkedin_url`) | add-to-crm spec |
| 9 | A non-LinkedIn URL was accepted and stored as a person | `api/v1/companion/add/route.ts` | add-to-crm spec |
| 10 | Scroll restoration always returned the list to the top (the restored ratio was read from state that had not loaded) | `src/use-list-state.ts` | list-state spec |
| 11 | The content script captured `main`'s innerText, sweeping in the feed rail; selectors were inline and brittle | `src/linkedin-adapter.ts`, `src/content.ts` | 9 adapter unit tests |
| 12 | A message-bridge reply was read by position and the shape was assumed | `src/background.ts` | code review + bridge test |

Defects 6 and 7 are the significant ones: **two of the Companion's primary write paths had never
worked**, and both failed in a way that looked like a generic error rather than a missing feature.

---

## 11. Unit and integration totals

| Suite | Tests | Result |
| --- | --- | --- |
| `@nexus/core` (incl. 7 new concurrency-policy tests) | 52 | pass |
| `@nexus/db` | 82 | pass |
| `@nexus/extension` (LinkedIn adapter) | 9 | pass |
| `@nexus/web` (incl. 6 new binding tests) | 57 | pass |
| **Total** | **200** | **pass** |
| `@nexus/extension` E2E (real extension) | 38 (36 pass, 2 skipped) | pass |
| `db:verify` | 19 migrations, 63 tables, 179 policies, 97 triggers, 88 functions, 173 indexes | pass |

The 2 skips are cases whose fixture is not in the seeded data (a DNC lead and a replied lead beyond
the first list page). They are reported as skips, not passes.

---

## 12. Not verified

Each of these is stated with the specific reason it could not be established here.

1. **Chrome's own side-panel chrome.** `chrome.sidePanel.open()` from the toolbar icon, the panel
   staying pinned beside LinkedIn, and the action click handler. A side panel only exists inside a
   browser window with the toolbar and cannot be driven over CDP. The panel *document* is fully
   exercised (§1); the panel *host* is not.
2. **`chrome.alarms` firing on schedule.** Registration and the 5-minute period are asserted; a
   wall-clock firing is not, because that is a 5-minute wait per run and the handler's behaviour is
   covered by the API tests it calls.
3. **LinkedIn itself.** No request was made to linkedin.com: the machine is behind a sandbox, and
   driving a real logged-in LinkedIn session is not something an automated test should do. The
   adapter's extraction is covered by 9 unit tests against representative markup, including the
   degraded cases. **The live DOM has never been exercised.**
4. **The LinkedIn content script inside a real LinkedIn page.** Its message handlers, its URL guard
   and its reply shape are unit-tested and its manifest registration is asserted; Chrome injecting it
   into an actual linkedin.com document is not tested.
5. **Unpacked-extension installation through `chrome://extensions`.** The extension is loaded by
   command line with `--load-extension`, which is the same loading path Developer Mode uses, but the
   UI flow itself was not performed.
6. **Browser-restart persistence of `chrome.storage.session`.** Modelled by clearing the area; a real
   browser restart is not performed.
7. **Follow-up *Edit* / *Copy* and the clipboard.** The controls render; their behaviour is not
   asserted.
8. **DNC across identities, end to end.** The global suppression and `block_dnc_message` are covered
   by database tests; the E2E case skipped on fixture placement.
9. **Dormant → reactivation transition** through the panel.
10. **Chrome Web Store submission and review.**
11. **The `People`/`Companies`/`Leads` counts after a long re-import.** Dedupe is verified for the four
    cases in §7, not for concurrent imports.

---

## 13. Distribution

```
apps/extension/dist/                 # unpacked MV3 extension, manifest at the root
dist/nexus-companion.zip             # 829,134 bytes, sha256 8d5bb465672d2124
```

The ZIP holds the extension **root** — `manifest.json` at the top level, not inside a folder — because
that is what both consumers need: extract it and point *Load unpacked* at the extracted directory, or
upload it to the Chrome Web Store. Verified by expanding it with the operating system's own unzipper:
six files, `manifest_version 3`.

To install: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the
extracted folder. With Nexus running, the panel signs in with the Nexus account and binds a LinkedIn
sender identity.

For a release build, set the API origin first — a production build refuses a loopback or non-HTTPS
origin:

```bash
NEXUS_API_ORIGIN=https://nexus.example.com pnpm --filter @nexus/extension run build:production
pnpm --filter @nexus/extension run package
```
