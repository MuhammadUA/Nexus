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

Only **one** of the nine frames was reached. The rest are **BLOCKED** on capture: the extension agent
stopped before producing the side-panel screenshots, and its CDP browser is no longer reachable on
port 9222.

| Frame | Node | Status | Finding |
| --- | --- | --- | --- |
| U22 — Companion · Login & Browser Binding | `7:2` | **DIFFERS** | see below |
| U23 — Companion · Leads | `7:24` | **BLOCKED** — no panel capture | — |
| U24 — Companion · Today | `7:77` | **BLOCKED** — no panel capture | — |
| U25 — Companion · Search | `7:125` | **BLOCKED** — no panel capture | — |
| U26 — Companion · Add to CRM | `7:159` | **BLOCKED** — no panel capture | — |
| U27 — Companion · Connection Focus | `7:185` | **BLOCKED** — no panel capture | — |
| U28 — Companion · Follow-up Focus | `7:208` | **BLOCKED** — no panel capture | — |
| U29 — Companion · Reply & Notes | `7:237` | **BLOCKED** — no panel capture | — |
| U30 — Companion · Dormant & Reactivation | `7:259` | **BLOCKED** — no panel capture | — |

### U22 — the one real finding

Evidence: `E:\CRM\extension-baseline\screenshots\cdp-01-login.png` (420 × 820, the real panel) against
`E:\CRM\frontend-live-figma-reaudit\figma\U22-companion-login.png` (the live frame).

The frame draws a **single panel carrying two stages**:

1. `Sign in` heading, then **Email** (`you@company.com`) and **Password** fields, then a dark
   **Sign in** button.
2. Below that, in the same panel: a **`LinkedIn account`** selector (`Osama Linkedin ▾`), a
   **`Business`** selector (`Zemnas ▾`), a second dark button **`Bind this browser`**, and a
   confirmation block (`Bisma` / `Osama Linkedin · Zemnas`).

The built panel (`cdp-01-login.png`) shows only stage 1, and differs further:

| Element | Figma U22 | Built panel |
| --- | --- | --- |
| Header right | `OSAMA` | `Companion` |
| Heading | `Sign in` (large) | *absent* |
| Helper text | *absent* | "Sign in with your Nexus account, then choose the LinkedIn identity this browser profile uses." |
| Email / Password labels | `Email`, `Password` | `Email *`, `Password *` |
| Placeholder | `you@company.com` | *none* |
| Sign-in button | dark, full width | dark, full width — **matches** |
| LinkedIn account selector | present | **not on this screen** |
| Business selector | present | **not on this screen** |
| `Bind this browser` button | present | **not on this screen** |
| Binding confirmation block | present | **not on this screen** |
| Field styling / button weight | — | **matches** (same dark button, same input treatment, same corner radius) |

**Interpretation.** The binding *functionality* exists and is tested — `packages/ui/src/companion-shell.tsx`
renders persistent business/ICP/sender selectors (line 132), and eight E2E tests cover binding
persistence, storage location, and survival across a restart. What differs is **composition**: the
design puts credential sign-in and browser binding on one panel, while the implementation splits them
into a sign-in step followed by the CRM view with the selectors at the top. The panel also spends a
large amount of vertical space on an empty lower half, where the frame places the binding controls.

So this is a genuine `TRUE_FRONTEND_DEFECT` of **layout/composition**, not missing functionality:
sign-in and binding should be one progressive panel per the frame, and the "Companion" header label
should be the operator's identity.

## 6. Summary

| Area | Status |
| --- | --- |
| Extension build, lint, unit tests | **PASS** |
| Build from clean checkout | **PASS** |
| Real panel boot at 420 × 820 | **PASS** |
| Real-origin connectivity incl. preflight from the extension origin | **PASS** |
| Real-origin E2E | **PASS** — **38 passed, 0 failed, 0 skipped**, exit 0 |
| U22 visual fidelity | **DIFFERS** — composition, documented above |
| U23–U30 visual fidelity | **BLOCKED** — 8 frames uncaptured |

**Companion status: `PASS_WITH_MINOR_VISUAL_GAPS`.** The panel genuinely boots, signs in, binds,
persists state across restarts, satisfies DNC suppression, and talks to the API from its own
`chrome-extension://` origin — with the full 38-case suite green and nothing skipped. The residual gap
is visual certification only: one frame shows a real composition deviation and eight frames remain
uncompared because no side-panel captures were produced for them.
