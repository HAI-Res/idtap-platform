# A5 — Web API route authentication (httpOnly session cookie)

Status: **scoped, not started** · Target: CSAIL deployment only · Date: 2026-07-16

## The problem

The legacy web endpoints (everything at the server root, ~91 handlers) trust
client-supplied identity. Concretely:

- Login (`NavBar.vue:134`): `googleOneTap()` yields `res.credential` (a real Google
  ID-token JWT), but the client **decodes it locally** and calls
  `userLoginGoogle(userData)` with the *decoded profile*. The raw credential never
  reaches the server.
- `/userLoginGoogle` (`server.ts:1663`) upserts a user keyed on `req.body.sub` with
  **no verification** — anyone can POST any `sub` and become that account.
- ~56 sites across the handlers read identity straight from the request
  (`JSON.parse(req.query.userID)`, `req.body.userID`, `req.body.sub`) and trust it.
- Net effect: reading/modifying/reassigning anyone's transcriptions is possible over
  plain HTTP with no login. (Confirmed reachable via nginx.)

The `/api/*` routes (Python client) are **already protected** by the
`verifyGoogleToken` Bearer middleware (`server.ts:232`) and are **out of scope** —
nothing here touches them.

## Chosen approach

Server-issued **httpOnly session cookie**. The server verifies the Google credential
once at login, mints its own signed session token, and sets it as an
`HttpOnly; Secure; SameSite=Lax` cookie. Because the app is now same-origin (Node
serves both the SPA and the API), the browser re-sends the cookie automatically on
every request — so the ~56 client call sites need **no** `Authorization` header added.

Two layers of work, and it's important to keep them distinct:

1. **Authentic identity** (mechanical): a middleware sets `req.user` from the verified
   cookie; handlers read `req.user` instead of client input.
2. **Authorization** (the hard part): many handlers currently perform *no* ownership
   check at all — they act on whatever `_id` is passed. Deriving a trustworthy
   identity is necessary but not sufficient; each mutating/private route also needs a
   real "does this user have rights to this object?" check against the permission
   model.

---

## Design

### Session token
- A signed JWT (lib: `jsonwebtoken`) stored in cookie `sid`.
- Payload: `{ sub, uid, email, name }` where `sub` = verified Google subject, `uid` =
  Mongo user `_id` string (handlers use `userID` = `_id` everywhere, so bake it in to
  avoid a DB lookup per request).
- Signed with **`SESSION_SECRET`** (new env var: 32+ random bytes; add to box `.env`
  640 + 1Password). Rotating it invalidates all sessions (acceptable logout-all).
- Expiry: **OPEN DECISION** — proposed 30 days, sliding (re-issued on activity).
- Cookie flags: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<expiry>`.

### New deps / config
- `jsonwebtoken`, `cookie-parser` → `server/package.json`.
- `SESSION_SECRET` → box `.env` + 1Password.

### CSRF
`SameSite=Lax` + same-origin blocks the common CSRF vectors. Belt-and-suspenders:
require a custom header (e.g. `X-IDTAP-Client: web`) on all **state-changing** routes,
checked by middleware. A cross-origin attacker can't set a custom header without a
CORS preflight the server won't grant, so this closes the residual gap cheaply. The
SPA adds the header in one shared request wrapper.

---

## Server changes

### 1. Login rewrite (`/userLoginGoogle` or a new `/session/login`)
- Accept `{ credential }` (the raw Google ID token) instead of a decoded profile.
- `verifyGoogleToken(credential)` → verified `{ sub, email, name, ... }`.
- Upsert the user keyed on the **verified** sub (not client input).
- Mint the session JWT; `res.cookie('sid', jwt, {flags})`.
- Return the profile (for display) as today, so the client UI is unchanged.

### 2. Logout (`/session/logout`)
- `res.clearCookie('sid', {flags})`. Client clears its display state.

### 3. Middleware (added before the route handlers, `server.ts:~231`)
- `attachUser` (all routes, non-blocking): if a valid `sid` cookie is present, set
  `req.user = { sub, uid, email, name }`; otherwise leave it undefined. Never 401s, so
  public routes still work logged-out.
- `requireSession` (guard): 401 if `req.user` is absent. Applied to authed/mutating
  routes.
- `requireCsrfHeader` (guard): 403 if the `X-IDTAP-Client` header is missing on
  state-changing routes.

### 4. Authorization helper (new `shared/authz.ts`)
Centralize the permission logic instead of inlining it at 56 sites — and put it in
`shared/` so the **same functions** run client-side (UI menu disabling) and server-side
(enforcement). The permission model has **two shapes** that both must be handled:
- legacy `permissions: 'Public' | 'Publicly Editable' | ...`
- current `explicitPermissions: { edit: string[], view: string[], publicView: bool }`

Export: `isOwner(user, doc)`, `canView(user, doc)`, `canEdit(user, doc)`. Every route's
authz decision goes through these, and the ~15 components that currently inline
permission logic get migrated to import them too (one source of truth, no drift).

### 5. The handler sweep (the bulk of the effort)
Classify each of the ~91 routes / 56 identity sites into buckets and apply the pattern:

| Bucket | Example routes | Change |
|---|---|---|
| Truly public (no per-user behavior) | `getRagaNames`, `pieceExists` | none |
| Public read w/ "yours" mixed in | `getAllTranscriptions` | drop trusted `query.userID`; use `req.user?.uid` for the private slice; logged-out ⇒ public-only |
| Private read | user-scoped listings | `requireSession` + filter by `req.user.uid` + `canView` |
| Mutation | `updateTranscription`, `cloneTranscription`, delete | `requireSession` + `requireCsrfHeader` + `canEdit(req.user, target)` |
| Owner-only | `updateTranscriptionPermissions`, `updateTranscriptionOwner` | `requireSession` + `requireCsrfHeader` + `isOwner(req.user, target)` |

The mutation/owner buckets are where the real security lift is — most of those
handlers do no ownership check today, so this is *adding* authz, not just swapping the
identity source.

---

## Client changes (small, thanks to same-origin cookies)

- **Login** (`NavBar.vue` `loggedIn`): send `res.credential` (raw) to the login
  endpoint; let the server set the cookie and return the profile. Stop treating the
  locally-decoded `sub` as authoritative.
- **Requests**: no change needed for the cookie to ride along — same-origin `fetch`
  (default `credentials: 'same-origin'`) and same-origin `axios` both send cookies
  automatically. The 56 call sites can keep passing `userID` during transition; the
  server ignores it.
- **CSRF header**: add `X-IDTAP-Client: web` in one shared request wrapper (a light
  refactor of the ad-hoc `fetch` calls in `serverCalls.ts`, or a small helper).
- **Logout**: call `/session/logout` and clear display state / Vuex.
- The existing JS-readable `$cookies.set('userID', ...)` stays only as a display
  convenience — it is no longer a trust anchor.

---

## Rollout & safety

- **CSAIL only.** DO prod (`137.184.90.119`) is untouched and dies at DNS cutover.
- **Python `/api` untouched.** Separate auth path.
- **Deploy together.** Frontend + server ship in one CI deploy (already automated), so
  the login-flow change lands atomically.
- **Phased enforcement (de-risk):**
  1. Ship `attachUser` + login cookie minting in **log-only** mode — `req.user`
     populated, nothing 401s. Verify real sessions resolve for live users.
  2. Flip on `requireSession` / `requireCsrfHeader` / authz checks per bucket, in
     batches (transcriptions → audio → collections → users), watching for breakage.
- **One-time re-login:** existing users have Vuex identity but no `sid` cookie; first
  guarded action 401s → they log in once → cookie set. Acceptable.
- **Dev-mode note:** `vite dev` points at a cross-origin API (`swara.studio`), where
  the cookie won't attach. For local dev either run the Node server locally (same
  origin) or set `SameSite=None; Secure` + CORS-with-credentials for the dev origin.

## Testing
- Unit: `authz.ts` (`isOwner`/`canView`/`canEdit`) across legacy + explicit-permission
  fixtures.
- Middleware: valid/expired/absent cookie → `req.user` / 401; missing CSRF header → 403.
- Integration (supertest): representative routes per bucket — unauth'd 401, wrong-owner
  403, owner 200. A regression test that `getAllTranscriptions` no longer leaks another
  user's private docs when `userID` is spoofed.

## Sequence & rough effort
1. Infra: deps, `SESSION_SECRET`, login rewrite, `/session/logout`, middleware — ~0.5 day.
2. Client login change + end-to-end login/logout verified — ~0.5 day.
3. `authz.ts` + handler sweep in batches — the bulk, iterative (~2–4 days).
4. CSRF header wrapper + guards — ~0.5 day.
5. Tests + phased enforcement flip — ~1 day.

## Decisions (locked 2026-07-16)
1. **Session length** — **7-day sliding** (re-issued on activity). Matches the current
   effective session (`main.ts` sets vue-cookies `expires: '7d'`); no UX change.
2. **CSRF** — **custom-header check** (`X-IDTAP-Client`) on write routes, on top of
   `SameSite=Lax`.
3. **Rollout** — **enforce immediately** (few/no active users; rollback is one revert).
   No log-only window. Note: the intermediate PRs are still non-breaking — cookie
   minting + `attachUser` add behavior without blocking; only the final handler-sweep
   PR flips guards on, so deploys stay safe until the sweep lands.
4. **authz lives in `shared/`** — `canView/canEdit/isOwner` go in the shared module so
   the **same functions** power client-side menu disabling (UI, no round trips) and
   server-side enforcement (the actual lock). Consolidates the permission logic
   currently inlined across ~15 components.

## Related
- Python client hourly re-auth is a **separate** issue (this work doesn't touch the
  `/api` path): jon-myers/Python-API#2 (client never uses its stored `refresh_token`;
  server `/oauth/token` also lacks a refresh grant).
