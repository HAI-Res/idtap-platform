# Review Section: Frontend Outside the Editor

**Scope:** `src/js/serverCalls.ts` (2286, the entire client API surface), `src/router/`,
`src/main.ts`, `src/comps/NavBar.vue` (auth), `src/comps/analysis/` (~7k lines),
`src/comps/files/`, `collections/`, `audioRecordings/`.

**Bottom line:** `serverCalls.ts` is 88 hand-rolled endpoint wrappers with **zero
authentication** — confirming `servers.md` from the client side: no call ever attaches a
token/bearer/cookie; identity is a plaintext `userID` in the body/query that the server
trusts. The only access gate is a client-side router guard reading a self-set,
non-HttpOnly `userID` cookie — UX gating, no security. The analysis tools do almost
everything client-side on the main thread (duplicating server logic), and the
files/collections area has the same god-object/ref-reach coupling as the editor plus a
crop of concrete bugs (including a wrong-method-name runtime crash and a `debugger;`
left in production).

---

## 1. serverCalls.ts — the client API surface

- **Shape:** ~85 standalone async arrow functions, **88 unique endpoints**, one flat
  module, no shared request helper, no base-URL config — `const url = 'https://swara.studio/'`
  (`:1`) is string-concatenated into every call. The production host is hardcoded; no env
  indirection.
- **Pattern:** raw `fetch` (cross-fetch) everywhere except the 3 multipart upload branches
  in `newUploadFile` (axios, for progress). The `{method, headers:{'Content-Type'},
  body: JSON.stringify}` literal is duplicated ~85× verbatim. Query-param encoding is
  erratic — some endpoints **double-JSON-encode** (`userID: JSON.stringify(userID)` inside
  `URLSearchParams`, `:155`), so the server must `JSON.parse` some params and not others.
- **Error handling — swallowed.** Dominant pattern: `try { if(res.ok) result = await
  res.json() } catch(err){ console.error(err) } return result`. Failures log to console and
  return `undefined`; **nothing surfaces to the user**. A non-2xx silently yields
  `undefined`. Only a couple throw.
- **AUTH — confirmed fully unauthenticated.** `grep -niE "authorization|bearer|token|
  credentials|cookie"` over the file → **zero matches**. `savePiece` (`:114`) POSTs the
  entire Piece with no credential; `userID` is shipped as plain data in bodies/query/form
  fields. Even login POSTs the **client-decoded Google profile** (`userLoginGoogle`, `:1404`)
  — the client decodes the Google credential itself and hands the server an already-decoded
  identity. (`handleGoogleAuthCode`, `:1475`, is the one real server-side code exchange.)
- **Dead exports** (0 external consumers): `nameFromUserID` (`:1455`), `cleanEmptyDoc`,
  `getVerifiedStatus`. `any` count: 0.

---

## 2. Routing & client auth

- **Router** (`src/router/index.ts`, 10 routes) has **one global `beforeEach`** (`:70-84`)
  that reads `window.$cookies.get('userID')` and redirects to `/logIn` for gated routes if
  absent. `/editor` and `/analyzer` are gated — **but the gate is purely client-side and
  trivially bypassable**: the cookie is a plain, non-HttpOnly value the client sets itself
  (`NavBar.vue:149`); any `userID` cookie satisfies it. Combined with §1, this is UX gating
  with zero security value.
- **Client auth** lives in `NavBar.vue`, not `LogIn.vue`. Identity is persisted **both** in
  vue-cookies **and** mirrored into Vuex — no single source of truth. Logout sets cookies to
  the string `"undefined"` rather than deleting (hence the `if (x === 'undefined')` sentinel
  convention everywhere). **No token, no session, no refresh** — just a `userID` cookie with
  7-day expiry. `loggedIn()` (`:144`) **trusts the server response blindly**: `result.value._id`
  dereferenced with no null-check → a failed `userLoginGoogle` throws `TypeError` (`:147`).

---

## 3. Analysis tools (`src/comps/analysis/`, ~7k lines)

`AnalyzerComponent.vue` (2161) fetches the Piece once, then runs **everything client-side**
(queries via `Query.multiple()` over the loaded Piece, no server round-trips).
`PitchPrevalence.vue` (1976) computes time-on-pitch proportions client-side and hand-builds
SVG with d3 (no enter/update/exit). This **duplicates the server's extractor logic** and does
heavy synchronous work on the main thread (large SVG-append loops; `getHeatmapColor` rebuilds
a 100-stop gradient on every call).

Concrete bugs (→ bug-hunt): **`debugger;` left in production** (`AnalyzerComponent.vue:1733`);
`proportions` not reset before `.push` → stale duplicates (`:1750`); query race with no
request-id guard (`:797`); `PitchPrevalence` renders only in `mounted` with no watchers
(`:134`) so prop changes don't re-render; empty-segment div-by-zero → `NaN`/`Infinity`
(`:449`); unscoped `d3.selectAll('.wideLine')` collides across instances (`:1922`).
`AssemblageDisplay.vue` drives playback with `setTimeout(durTot*1000)` instead of the audio
clock (`:351`) → accumulating drift, no cleanup on stop.

---

## 4. Files / collections / recordings (~10k lines)

Browse flows use a generic `<FilterableTable>`; sorting is client-side (the server
`sortKey`/`sortDir` args are vestigial — `FileManager` always passes `'title'`/`'1'`,
`:348`). Selection/playing state is tracked via **DOM class toggles + `querySelectorAll`**,
not reactive state. `NewPieceRegistrar.vue` (1407) gathers form state and emits upward (parent
calls the serverCall). State coupling is **worse than the editor's** in places:
`CollectionViewer` reaches into child internals and reconstructs indices by **parsing DOM
element ids** (`:254`, `:355`); `UploadRecording.vue` (1377) is a true god-object (50+ fields,
18 serverCalls imported).

Concrete bugs (→ bug-hunt): **`CollectionViewer.vue:344` calls `miniAE.updateAEs()` but the
method is `updateAudioEvents`** → "remove audio event from collection" throws at runtime.
`UploadRecording.vue:751` does `forEach(async …)` un-awaited then fires `updateAudioRecording`
while musician inserts are in flight → race, new musicians may not persist. `SaTuner.vue` is
registered but **never rendered** (`UploadRecording.vue:558`) → Sa-verification unreachable
from the edit flow. Multiple leaked `resize`/`keydown` listeners (anonymous add/remove
mismatch) across `FileManager`, `CollectionsComponent`, `UploadRecording`, `CollectionViewer`.
Hardcoded `Https://` (capital H) URLs (`AudioRecordings.vue:407`).

---

## Leads handed to later phases

**Security:** entire 88-endpoint surface unauthenticated (corroborates `servers.md`);
client-side-only router guard on a self-set cookie.
**Bug-hunt:** `CollectionViewer.vue:344` (runtime crash), `AnalyzerComponent.vue:1733`
(`debugger`), `UploadRecording.vue:751` (async race), `serverCalls.ts:147` (blind deref on
failed login), the listener leaks, `PitchPrevalence` no-reactivity + div-by-zero.
**Modernization:** replace the 85× duplicated fetch boilerplate with one typed client
(auth-aware — this is where the bearer token gets added when auth is fixed); move heavy
analysis compute off the main thread or reuse the server extractor; normalize identity to a
single source of truth.
