# Nexus Companion — Extension Security Audit

**Scope.** The built Chrome/Chromium Manifest V3 extension in `apps/extension/dist`, the source it is
built from, and the `/api/v1/companion/*` surface it talks to. Every finding below was produced by
reading the artefact the browser actually loads, not by reading the source and assuming the build
matches.

**Artefact audited**

| File | Bytes | SHA-256 (first 16) |
| --- | --- | --- |
| `manifest.json` | 849 | `d44dcc749100b236` |
| `background.js` | 42,632 | — |
| `content.js` | 21,043 | — |
| `sidepanel.js` | 3,967,988 | — |
| `styles.css` | 30,328 | — |
| `sidepanel.html` | 347 | — |
| **`dist/nexus-companion.zip`** | 829,134 | `8d5bb465672d2124` |

`pnpm --filter @nexus/extension run build` performs this audit on every build and **fails the build**
if the manifest drifts or any credential pattern appears, so the guarantees below cannot silently rot.
It also reports a per-file SHA-256 so an artefact can be compared against a reviewed one.

---

## 1. Manifest

| Check | Result | Evidence |
| --- | --- | --- |
| `manifest_version: 3` | PASS | build assertion; verified again through `chrome.runtime.getManifest()` in the loaded extension |
| Permissions are exactly the needed four | PASS | `["sidePanel","storage","tabs","alarms"]` |
| No `<all_urls>` or wildcard host | PASS | build fails on `<all_urls>`, `*://*/*`, `http://*/*`, `https://*/*` |
| Host permissions are two origins | PASS | `https://www.linkedin.com/*`, the API origin |
| No `cookies` | PASS | absent, and named as forbidden in the build |
| No `webRequest` | PASS | idem |
| No `debugger` | PASS | idem |
| No `scripting` | PASS | removed in this pass — nothing called `chrome.scripting`; capture is a declared content script |
| No `management`, `proxy`, `declarativeNetRequest` | PASS | absent, and forbidden by name |
| No `externally_connectable` | PASS | asserted absent, so no web page can message the extension |
| Content script limited to LinkedIn | PASS | `matches: ["https://www.linkedin.com/*"]`, asserted to stay in that prefix |
| Content script not in all frames | PASS | `all_frames` is not set, asserted |
| CSP restricts scripts to self | PASS | `script-src 'self'; object-src 'none'`; build fails on `unsafe-eval`/`unsafe-inline` |
| `side_panel.default_path` is the built document | PASS | `sidepanel.html` |
| Service worker is the built worker | PASS | `background.js`, `type: module` |
| `minimum_chrome_version` | PASS | 114, which is where `sidePanel` became available |

**Why `sidePanel`, `storage`, `tabs`, `alarms` and nothing else.** `sidePanel` is the product.
`storage` holds a session token and the list state. `tabs` is required for the documented navigation
("open the prospect's profile in the active browser tab") and for `tabs.sendMessage` to the content
script. `alarms` drives the browser-session heartbeat that makes the concurrent-identity warning
truthful. No other capability is referenced anywhere in `src/`.

---

## 2. Credentials

The build scans every shipped byte for patterns with the *shape* of a credential. A bare `sk-` needle
was tried first and removed: it matched `mask-type` in the bundled stylesheet helper, and a scan that
cries wolf is a scan that gets ignored.

| Pattern | Found |
| --- | --- |
| Supabase service role (`service_role`, `SERVICE_ROLE_KEY`, `SUPABASE_SERVICE_ROLE`) | no |
| Supabase secret key (`sb_secret_…`) | no |
| Database URL carrying credentials (`postgres://user:pass@…`) | no |
| OpenAI-style key (`sk-` + 20 or more alphanumerics) | no |
| Anthropic key (`sk-ant-…`) | no |
| DeepSeek API key assignment | no |
| Apollo API key assignment | no |
| MCP master/service secret assignment | no |
| `NEXUS_SESSION_SECRET` assignment | no |
| PEM private key block | no |
| Nexus user token literal (`nxu_…` with a real body) | no |
| Remote script tag (`<script src="http…">`) | no |

**Result: PASS — no credential is present in the bundle.**

The extension holds no database credential by construction. It authenticates as the signed-in *user*
with a token issued by `/api/v1/companion/session`, and every request then runs through the same
`withActor` path as the web app, so RLS decides what is visible. There is no service-role path in the
extension at all, and `NEXUS_API_ORIGIN` is the only build-time secret-shaped input — and it is a
public URL.

---

## 3. Executable code

| Check | Result | Evidence |
| --- | --- | --- |
| No `eval()` | PASS | build scan; also forbidden by the MV3 CSP |
| No `new Function()` | PASS | idem |
| No `WebAssembly.compile`/`instantiate` | PASS | idem |
| No remote script loading | PASS | every script is a local file; CSP is `script-src 'self'` |
| No source maps in a production build | PASS | `sourcemap: false` when `--production` |
| Bundle is self-contained | PASS | three esbuild entry points bundled offline; no CDN, no dynamic import of a remote URL |

The dynamic `import('./api.js')` in the service worker resolves to a compiled chunk inside the
bundle, not a network fetch.

---

## 4. Session handling

| Property | Implementation | Verified |
| --- | --- | --- |
| Token stored in memory only | `chrome.storage.session` | E2E: the token is present in `session`, absent from `local` |
| Never written to disk | asserted in E2E against `chrome.storage.local` | E2E `boot-and-auth` |
| Raw token is single-use on the wire | returned once by the session route; only its SHA-256 is stored | server route review |
| Token is revocable | `DELETE /companion/session` revokes by hash; possession is the proof | `apps/web/test` + E2E sign-out |
| Revoked token returns to sign-in | E2E stores an unknown-but-well-formed token and asserts the panel clears it and offers sign-in | E2E `boot-and-auth` |
| Sign-out clears the session | E2E clicks Sign out and asserts the token is gone | E2E `boot-and-auth` |
| Token is scoped to the user | `resolve_user_token` resolves to a `user_id`, then RLS applies | `apps/web/src/lib/gateway.ts` |
| Install id is not a fingerprint | `crypto.randomUUID()`, persisted per profile | E2E asserts the UUID shape and that it survives a reload |

The install id exists only so a browser profile is distinguishable, which the spec requires for
"each browser profile can bind the same Nexus user but a different assigned outreach identity". No
device characteristic is read.

---

## 5. Cross-origin access

The Companion calls the API from a `chrome-extension://` origin, so `Authorization` makes every call
a preflighted request. Before this pass the API sent no CORS headers and the browser blocked all of
them.

`apps/web/middleware.ts` now handles `/api/v1/companion/:path*`:

* an `OPTIONS` preflight returns 204 with `Access-Control-Allow-Methods: GET, POST, OPTIONS` and
  `Access-Control-Allow-Headers: authorization, content-type`, cached for 600 s;
* `Access-Control-Allow-Origin` echoes the caller **only** when it starts with `chrome-extension://`,
  and `Vary: Origin` is set;
* every other origin gets no CORS header at all, so the browser refuses the response.

**Why an echoed extension origin is safe here and `*` would not be.** This surface is
bearer-token authenticated, never cookie authenticated: a browser does not attach the Companion's
token to a request it did not originate, so a hostile page cannot borrow a signed-in session by
being allowed to read a response. The cookie-authenticated app routes are untouched and remain
same-origin.

**Production origin configuration.** `NEXUS_API_ORIGIN` is baked in at build time and becomes a host
permission. A production build refuses a loopback or non-HTTPS origin:

```
NEXUS_API_ORIGIN=http://127.0.0.1:3000 pnpm --filter @nexus/extension run build:production
→ Error: NEXUS_API_ORIGIN is http://127.0.0.1:3000: refusing to build a production artefact
  against a loopback origin. Set NEXUS_API_ORIGIN to the deployed Nexus URL.
```

A development build defaults to `http://127.0.0.1:3000` and the manifest says so. The extension id is
therefore not hard-coded anywhere on the server: the CORS rule keys off the `chrome-extension://`
scheme, so a Web Store id, an unpacked id and a locally loaded id all work without a server change,
and a deployment does not have to be reconfigured when the id is assigned.

---

## 6. What the extension can reach

* **LinkedIn.** The content script runs on `https://www.linkedin.com/*` only. It reads the profile
  region and posts two message types back; it never clicks, never types, never submits, and never
  sends anything to LinkedIn. `isProfileUrl` restricts extraction to `/in/<slug>` pages, so a feed or
  a company page is refused rather than captured.
* **Nexus.** Only the origin in `host_permissions`.
* **Nothing else.** No wildcard host, no `cookies`, no `webRequest`, so page content cannot be
  exfiltrated through a header rewrite and no other site's cookies are reachable.

**Page content is treated as untrusted input.** The content-script reply is narrowed field by field
before use; capture text is stored bounded (60,000 characters in the adapter, 200,000 at the API) and
is rendered as text everywhere, never as markup. The message bridge from a page returns at most one
lead id, so a compromised page cannot use it to read CRM data.

---

## 7. Deliberate limitations

1. **No subresource integrity for the bundle.** Not applicable — nothing is loaded remotely; the CSP
   forbids it.
2. **The CORS origin check is scheme-based, not id-based.** Any extension origin may *receive* a
   response. It still needs a valid bearer token, so this is not an access-control gap, but a
   deployment that wants to allow-list one exact id would add a check in `middleware.ts`.
3. **`chrome.storage.session` is in-process memory.** Chrome clears it when the browser closes, which
   is the intent; it is not protected against a compromised profile or a running debugger.
4. **The audited artefact is a development build by default.** The ZIP produced by
   `pnpm --filter @nexus/extension run package` is whatever is currently in `dist/`, so a release
   must run `build:production` first. The ZIP reports the origin it was built against.
5. **No automated check that `dist/` matches `src/`.** The build is the only writer of `dist/`, and
   `package.mjs` refuses to include itself, but a stale `dist/` is possible. Rebuilding before
   packaging is the mitigation.

---

## 8. Result

| Area | Status |
| --- | --- |
| Manifest V3, minimal permissions, narrow hosts | **VERIFIED** |
| No credentials, keys or secrets in the artefact | **VERIFIED** (automated scan, build fails on a finding) |
| No `eval`, no remote code, CSP-compatible | **VERIFIED** (automated scan) |
| Token in session storage only, revocable, cleared on sign-out | **VERIFIED** (E2E against real `chrome.storage`) |
| No device fingerprinting | **VERIFIED** (generated UUID, asserted shape) |
| CORS restricted to extension origins, no wildcard | **VERIFIED** |
| Production build cannot target loopback or plain HTTP | **VERIFIED** (build refuses) |
| Content script limited to LinkedIn profiles | **VERIFIED** (manifest + adapter tests) |
| LinkedIn DOM extraction isolated and degradable | **VERIFIED** (adapter unit tests; paste fallback) |
| Chrome Web Store policy review | **UNVERIFIED** — not performed; requires submission |

**No blocking security finding.**
