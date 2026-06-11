# Review Section: The Servers

**Scope:** `server/server.ts` (2344 lines, the production server), `server/apiRoutes.ts`
(747), `server/oauthRoutes.ts` (88), `server/services/`, and the dead legacy
`server.js` (2180) at the repo root.

**Bottom line:** There are effectively *two* HTTP surfaces living in one process. The
`/api/*` router (used by the Python client) is gated by a Google-token auth
middleware **and** does per-document permission checks. The ~90 "web" routes
mounted directly on `app` (used by the Vue frontend) have **no authentication and
no authorization whatsoever** — the caller asserts their own `userID` in the
request body/query, and the server trusts it. This is the single most important
finding in the whole review. Everything else here is secondary.

---

## How it's wired

`runServer()` in `server.ts:206` connects to Mongo, grabs collection handles, and
then, in order:

1. Mounts `app.use('/api', authMiddleware)` (`server.ts:227`) — requires
   `Authorization: Bearer <google id token>`, verifies it with
   `google-auth-library`, sets `req.user`.
2. Mounts the `/api` router (`apiRoutes.ts`) and the `/oauth` router
   (`oauthRoutes.ts`).
3. Defines ~90 routes **directly on `app`** (not behind any middleware) for the
   web client: `/insertNewTranscription`, `/updateTranscription`,
   `/oneTranscription` (delete), `/updateVisibility`, `/userLoginGoogle`, etc.
4. Serves static dirs (`/audio`, `/spectrograms`, `/spec_data`, `/melographs`,
   `/peaks`) and the built SPA from `dist`.

So the auth middleware at `server.ts:227` only protects paths beginning with
`/api`. None of the web routes start with `/api`, so none of them are protected.

---

## CRITICAL — the web API has no auth or authorization

### C1. No authentication on the entire web route surface
The Vue client never sends an auth token. `src/js/serverCalls.ts` contains zero
`Authorization`/`Bearer` headers; every mutating call simply includes a `userID`
field that the server uses verbatim. Representative examples in `server.ts`:

- `/updateTranscription` (`server.ts:283`) — sets arbitrary fields on any
  transcription by `_id`. No ownership check.
- `/oneTranscription` DELETE (`server.ts:644`) — deletes any transcription by
  `_id`; the `userID` it pulls from is also caller-supplied.
- `/deleteRecording` (`server.ts:667`), `/deleteAudioEvent` (`server.ts:756`) —
  delete any recording/event *and unlink the underlying audio/spectrogram/melograph
  files from disk* (`fs.rm`, `fs.unlink`), no auth.
- `/updateVisibility` (`server.ts:979`), `/updateTranscriptionPermissions`
  (`server.ts:1340`), `/updateTranscriptionOwner` (`server.ts:1352`) — change who
  can see/own a document. Anyone can make any private transcription public, or
  reassign ownership, with a single unauthenticated POST.
- `/cloneTranscription` (`server.ts:1753`) — reads *any* transcription by id
  (including private ones) and clones it to a new owner. This is also a **private-data
  read bypass**: there is no permission filter on the `findOne`.
- `/getOneTranscription` (`server.ts:611`) and `/getAudioDBEntry` (`server.ts:810`)
  return full documents by `_id` with no permission filter at all — private
  transcriptions are readable by anyone who knows (or guesses/enumerates) an id.

The contrast is stark and instructive: the **same operations done right** already
exist in `apiRoutes.ts`. `POST /api/transcription` (`apiRoutes.ts:246`) fetches the
doc first, checks `isOwner || explicitPermissions.edit.includes(user)`, and returns
403 otherwise. `POST /api/visibility` (`apiRoutes.ts:307`) checks ownership. The
web equivalents do none of this. **The remediation is to make the web client send
the same Google token the Python client does, move all mutating/reading web routes
behind the `/api` auth middleware (or an equivalent), and port the permission
checks that already exist in `apiRoutes.ts`.** A lot of the hard work is already
written — it just isn't applied to the surface real users hit.

> Caveat worth stating plainly: I'm reading this statically. It's conceivable
> there's a network-layer protection (firewall, reverse-proxy auth, the box only
> being reachable from certain origins) that I can't see from the code. **Please
> confirm how `137.184.90.119:3000` is exposed.** CORS is `origin: '*'`
> (`server.ts:168`), which strongly suggests the endpoint is meant to be reachable
> from browsers generally, i.e. no proxy auth. If the only thing standing between
> the public internet and `/oneTranscription` is obscurity, that should be treated
> as an active incident, not a backlog item.

### C2. NoSQL-injection / type-confusion on `_id` and query fields
Many routes pass caller-controlled values straight into `new ObjectId(...)` or into
query objects. `new ObjectId()` on a malformed value throws (caught → 500), so the
classic injection is partly blunted, but several routes interpolate
caller-controlled strings into Mongo *field paths*:

- `/addCountryToDB` (`server.ts:1228`): `{ [`${continent}.${country}`]: [] }`
- `/addCityToDB` (`server.ts:1242`): `$push: { [`${continent}.${country}`]: city }`
- `/updateSaEstimate` (`server.ts:1269`): builds `recordings.${recIdx}.…` paths from
  the body.

A caller who controls `continent`/`country`/`recIdx` can write to arbitrary document
paths. Combined with C1 (no auth), this is a write-anything primitive. Even after
auth is added, these should validate against an allow-list / cast to the expected
type.

### C3. Mongo credentials and OAuth secret handling
Good: `server.ts:25-31` now reads `GOOGLE_CLIENT_ID/SECRET` from env and exits if
missing, and Mongo user/pass come from `process.env` (`server.ts:201`). That's the
right pattern. But note:
- The repo still contains `credentials/client_secret_*.json` (gitignored, but present
  in the working tree and easy to accidentally commit/deploy via the rsync globs).
  Recommend deleting it from disk and rotating that client secret, since it has been
  sitting in a working directory for years (file dated Oct 2023).
- `handleGoogleAuthCode` (`server.ts:1723`) and the `/oauth/token` route return raw
  Google `tokens` (including `refresh_token`) to the client. For the web flow that's
  the legacy pattern; for the Python flow it's by design. Worth documenting which
  tokens live where, because refresh tokens are long-lived bearer credentials.

---

## HIGH

### H1. CORS `origin: '*'` (`server.ts:168`)
Wide-open CORS. With cookie/session auth this would be catastrophic; with the
current "userID in body" model it's merely consistent with the (absent) security
model. Once real auth is added, lock CORS to the known frontend origin(s).

### H2. `bodyParser({ limit: '1000mb' })` + 2GB file uploads (`server.ts:159`, `171`)
The JSON body limit is 1GB and the file-upload limit is 2GB with
`abortOnLimit: false`. A handful of concurrent large requests can exhaust memory/disk.
`abortOnLimit: false` means oversized uploads aren't rejected, just silently
truncated/handled. These limits look like they were bumped to "make the big
transcription save work" rather than chosen deliberately.

### H3. Fire-and-forget responses in spawn handlers
`/makeSpectrograms` (`server.ts:1046`) attaches `res.json()` inside a
`makingSpecs.on('close', …)` but the surrounding `try` has no path that responds on
spawn **error** — if the Python process errors, the request hangs until the 600s
timeout. Same shape in several `spawn` routes. `/excelData` (`server.ts:1781`) and
`/jsonData` (`server.ts:1807`) call `res.download` in the close handler with no error
branch. The `apiRoutes.ts` upload route (`:707`) responds *before* the child finishes
(returns `processing_status.audio_processed: false` immediately), which is the better
pattern but means the client has no completion signal — there's no job/status
endpoint to poll.

### H4. `updateTranscriptionViewed` writes a key per transcription (`server.ts:2268`)
`transcriptionsViewed.${transcriptionID}` creates an ever-growing object keyed by id
on the user document. Over time this is an unbounded sub-document — a known Mongo
anti-pattern (document size, index pressure). Should be a capped array or a separate
collection.

---

## MEDIUM / cleanup

- **Two cron jobs scheduled at the same instant** (`server.ts:148` and `:153`, both
  `0 0 * * *`) — daily audio cleanup and Mongo backup fire simultaneously; fine
  functionally, but the backup competing with a delete job at midnight is worth
  staggering.
- **Massive duplication of the file-deletion block** — the unlink/rm sequence for
  peaks/spectrograms/mp3/wav/opus is copy-pasted in `deleteFiles()` (`server.ts:102`),
  `/deleteRecording` (`server.ts:725`), and `/deleteAudioEvent` (`server.ts:773`).
  `deleteFiles()` already exists but the two routes don't call it. Note also the bug
  at `server.ts:775`: `'spectrograms' + recID` is missing the `/` separator that the
  other copies have (`'spectrograms/' + …`) — so audio-event deletion never removes
  the spectrogram directory. Real bug, flagged for the bug-hunt phase.
- **`updateInstrumentation` references `sectionStartsGrid`** (`server.ts:2149`,
  `2218`) which `updateTranscription` is simultaneously `$unset`-ing as a legacy
  field (`server.ts:295`). The truncation logic operates on a field the rest of the
  code is trying to delete — likely stale, verify against the current data model.
- **`req.user!.id` vs Mongo `_id` confusion.** `apiRoutes.ts` is careful to translate
  the Google `sub` to the Mongo user `_id` (`apiRoutes.ts:49`), but
  `/transcription/:id/json` and `/excel` (`apiRoutes.ts:138`, `192`) build the
  permission query using `req.user!.id` (the Google sub) directly against
  `explicitPermissions.edit` (which stores Mongo `_id`s). These two API routes'
  permission checks therefore **never match on edit/view** and only succeed via
  `publicView`. Inconsistent and probably a latent bug.
- **`make_excel.py` is invoked for BOTH json and excel** (`server.ts:1807`,
  `apiRoutes.ts:165`) — `/jsonData` runs the excel-making script then downloads the
  `.json` it happens to also produce. Tightly coupled; worth splitting.
- `server/utils.ts` and `server/analysis.ts` are **1-line stub files** — dead.
- `server/services/dbStats.js` (107) and `testServices.js` (37) — check whether
  these are wired in; they aren't imported by `server.ts`.

---

## The legacy `server.js` (repo root, 2180 lines) — DEAD, delete it

Production runs `server/server.ts` (confirmed: `server/package.json:3` →
`nodemon … ts-node server/server.ts`; the `deployTSServer` script rsyncs
`server/server.ts` and friends). The root `server.js` is **not** started or deployed
by anything.

Route-by-route diff (legacy vs TS):
- **89 routes in legacy, 91 in TS.** Every legacy route exists in the TS server.
- **Only in legacy:** `/makeVisualizationData` (already commented out in TS at
  `server.ts:921`) and `/upload-avatar` (entirely commented out in `server.js`
  itself, and unreferenced anywhere in `src/`). So *nothing* of value lives only in
  the legacy server.
- **Only in TS (i.e. added after the port):** `/DNExtractExcel`,
  `/getTranscriptionInstrumentationAndTitles`, `/updateInstrumentationAndTitles`,
  `/handleGoogleAuthCodePythonAPI`.

**Recommendation:** delete `server.js` from the repo. Keeping a 2180-line stale
duplicate of the server invites confusion and the occasional "fix" landing in the
wrong file. It's in git history if ever needed. (The same applies to the
webpack/vue-config legacy build files — see the `infra` section.)

> Important nuance for the security write-up: the auth gap (C1) is **not** a legacy
> artifact. It exists in the *live* `server/server.ts`. Deleting `server.js` does not
> fix it.

---

## Leads handed to later phases

**Security phase:**
- Confirm network exposure of `:3000` (the C1 caveat). This determines whether C1 is
  "incident" or "hardening."
- Field-path injection in `/addCountryToDB`, `/addCityToDB`, `/updateSaEstimate` (C2).
- Token handling: what's stored client-side after `handleGoogleAuthCode`, and is the
  Google id-token verified on the web side at all? (It is verified for `/api`, not for
  web routes.)
- `credentials/client_secret_*.json` on disk → rotate + delete.

**Bug-hunt phase:**
- `server.ts:775` missing `/` in spectrogram path on audio-event delete (orphans
  spectrogram dirs forever — also a disk-leak).
- `apiRoutes.ts:138/192` permission query uses Google `sub` against `_id` fields →
  edit/view never matches.
- `updateInstrumentation` operating on `sectionStartsGrid` while it's being unset
  elsewhere.
- `/updateVisibility` audioEvent branch (`server.ts:1023`) uses `findOneAndUpdate`
  without `returnDocument`, then reads `result.value` — verify the driver version
  returns the doc by default (Mongo driver v5+ changed this).

**Performance phase:**
- `getAllTranscriptions` / `getAllAudioRecordingMetadata` do unindexed full-collection
  scans with projection; check indexes on `explicitPermissions.*`, `userID`,
  `parentID`.
- `updateTranscriptionViewed` unbounded sub-document (H4).

**Modernization / shared-backend phase:**
- The `/api` router is *already* a clean, authenticated, permission-checked REST
  surface. The path to a unified backend is: (1) make the web client authenticate
  like the Python client, (2) migrate web routes onto the `/api` router semantics, (3)
  retire the unauthenticated web routes. The data-model and serialization sections
  will determine how much the two clients can truly share.
