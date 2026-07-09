# IDTAP Migration & Modernization Plan (2026)

**Status:** planning · **Started:** 2026-07-08 · **Owner:** Jon Myers

Moving IDTAP off DigitalOcean onto MIT CSAIL's OpenStack (free, now that Jon has
access), and using the move to centralize/modernize the repo structure. This doc
is the source of truth for the decisions and the execution sequence.

---

## 1. Goals

1. **Get off DigitalOcean** onto CSAIL OpenStack (`137.184.90.119` → `128.52.136.161`).
2. **Self-host MongoDB** on the box (replacing MongoDB Atlas).
3. **Move media to object storage** (audio, spectrograms, peaks, spec_data, melographs).
4. **Restructure repos** for a clean break from UCSC and a maintainable long-term layout.
5. **Kill the TS↔Python model divergence** — the highest-priority correctness risk.
6. Do all of this **without touching the live DigitalOcean deploy** until cutover.

---

## 2. Current state

### Repos (both under `github.com/UCSC-IDTAP/`)
- **`idtap`** — a sprawling polyglot mono-repo:
  - `src/` — Vue 3 frontend (31 MB)
  - `server/` — Node/TS Express server (3 MB)
  - `src/ts/model/` — canonical TS domain model (frontend + server)
  - `shared/` — `enums.ts` + `types.ts`
  - `python/` — server-side Python processing (602 MB, mostly data/research; prod
    scripts = `process_audio.py`, `visualization_scripts/`, `visualization_tools/`,
    `cleanJson/make_excel.py`, `backup_scripts/`, `mass_upload/`)
- **`Python-API`** — public PyPI client `idtap-api`, with its own hand-written Python
  copy of the domain model in `idtap/classes/`.

### Known debt to clean up during restructure
- **Dead code:** `src/js/classes.ts` (4,165 lines) is dead **except** the legacy Excel
  extractor `server/extract.ts` (`DN_Extractor`) still imports it via the
  `server/classes.ts` shim. → port `extract.ts` onto `src/ts/model/`, delete the rest.
- **Duplicated endpoints:** `server.ts` has ~91 verbose web routes (`/getAllMusicians`,
  `/getAllTranscriptions`, `/getRagaNames`…); `apiRoutes.ts` has 18 REST routes for the
  Python client (`/api/musicians`, `/api/transcriptions`, `/api/ragas`…) hitting the same
  collections. → consolidate onto a shared data-access layer.
- **Model drift (the dangerous one):** the Python client's model is a separate
  implementation that silently drifts from TS. Verified bug: Yaman fundamental 246 Hz
  loads as 261.63 Hz in the Python client for stripped/non-12-TET data.

### Old prod box (DigitalOcean, to be decommissioned)
- 4 vCPU / 8 GB / 155 GB (80 GB used), Ubuntu 20.04, Python 3.8, no swap, idle load.
- Disk: `/root/backups` 37 GB, `/root/audio` 25 GB, spec_data 3.4 GB, spectrograms 1.3 GB,
  peaks 435 MB, uploads 391 MB. App itself is tiny (`/var/www` 5.8 MB).

### New box (CSAIL OpenStack) — see memory `csail-openstack-server`
- `idtap_server`, `lg.8core` (8 vCPU / 16 GB / 32 GB), Ubuntu 26.04, Python 3.14.4.
- `128.52.136.161`, reachable only via GlobalProtect VPN. `ssh idtap-csail`.
- Boot-from-image, ephemeral root, **no Cinder volume yet**.

---

## 3. Target architecture

### Repos: 2 code repos + 1 contract

| Repo | Contents | Visibility |
|---|---|---|
| **`idtap`** (monorepo, pnpm workspace) | `apps/web`, `apps/server`, `packages/model` (TS), `packages/shared`, `services/audio` (Python) | private / lab |
| **`idtap-api`** | public Python client (PyPI) + the ONE Python model impl | public |
| **`idtap-contract`** | JSON schemas + golden serialization fixtures + schema version | public, tiny |

**Why web + server stay together (not split):** they share compiled TypeScript
(`packages/model` + `@shared/types`) — that's *build-time* coupling → one monorepo.
The Python client shares only the HTTP/JSON contract — *runtime* coupling across a
network boundary → separate repo. Repo boundaries follow code-coupling, not the call
graph. They still deploy independently via path-filtered CI.

**Reversibility:** keep `packages/model` behind a clean `index.ts` public API so a
future split (e.g. when an iPad app appears) is a mechanical `git filter-repo` extract,
not a rewrite. Monorepo→polyrepo is the cheap direction; we're betting on it.

### The model contract (kills TS↔Python drift)

You cannot share an *implementation* across languages — so instead share a
**language-neutral contract** both implementations are provably tested against:

1. **`idtap-contract`** = versioned JSON Schema per serialized entity (Pitch, Trajectory,
   Phrase, Piece, Raga…) **+ golden fixtures**: canonical `.json` examples that
   deliberately include the dangerous cases — **non-12-TET tunings, stripped fields,
   dual-string**.
2. **Conformance tests in both repos:** TS and Python must each round-trip every fixture
   to *semantically identical* results. Runs in CI on every PR, both languages.
3. **Optional codegen** of field/type stubs from the schema (catches *shape* drift for
   free); hand-write behavior; fixtures catch *behavior* drift (the Yaman bug class).
4. **Version the schema**; both sides assert compatibility on load.

Two implementations total (one TS shared by web+server, one Python shared by client +
`services/audio`), both conforming to one contract.

### ⭐ STORAGE ARCHITECTURE — REVISED 2026-07-09 (NFS-based, Swift likely DROPPED)
Discovery: the CSAIL-Ubuntu image **auto-mounts CSAIL scratch NFS** via autofs at
`/data/scratch*` — **already accessible, writable as `ubuntu`, no credential/Kerberos/TIG
ask** (~150–350 MB/s, 1 TiB/user). BUT scratch is **explicitly NOT backed up + purgeable**
("subject to deletion as space is needed... ONLY for transient data"). Geography: use the
scratch co-located with the VM — **VM is in Holyoke → use `/data/scratch-fast`** (Stata
`/data/scratch` is cross-DC = slow per the READMEs). Per TIG data-storage page, ALL other
TIG network storage IS backed up by default (nightly 1wk / weekly 1mo / monthly forever);
scratch is the exception. Backed-up options: **requestable NFS filesystem** (best) or AFS
(20→200GB, Kerberos, clunkier for a server).

**Final tiers:**
| Data | Home | Backed up? |
|---|---|---|
| MongoDB data | Cinder volume (done) | No → mongodump to backed-up NFS |
| Working + regenerable (wav-in-process, spectrograms, peaks, spec_data, melographs, mp3/opus) | **scratch NFS `/data/scratch-fast`** (autofs, drop-in file I/O) | No — OK, regenerable |
| Precious masters (wav + original uploads, ~25GB) | **backed-up NFS filesystem — REQUEST from TIG** | ✅ Yes |

**Consequence: Swift is likely DROPPED entirely** → eliminates the object-storage access
layer, signed/temp URLs, the RadosGW+Keystone quirks, AND the Swift service-credential ask.
Existing filesystem-based code becomes near drop-in (just change base paths). The `idtap-media`
/`idtap-derived` Swift containers can be deleted or kept as a secondary backup leg.
**TIG email now = 2 asks: (1) open firewall for public web, (2) provision a backed-up NFS
filesystem for the `idtap` project.** (Swift service-credential ask removed.)

### (superseded) Original Swift-based storage plan

| Tier | Holds | Notes |
|---|---|---|
| Ephemeral root (32 GB) | OS, code, node, python | Rebuildable, nothing precious |
| **Cinder volume** (30 GB, type **Production**) | self-hosted MongoDB `/var/lib/mongodb` | Mandatory — root is ephemeral. DB tiny (67 MB dumps). Backups go to object storage, NOT this volume. |
| **Ceph object storage** | 2 buckets: `idtap-media` (wav masters — precious) + `idtap-derived` (mp3/opus + spectrograms/peaks/spec_data/melographs — regenerable) | **Confirm S3-compatible (RadosGW) vs Swift API — prefer S3 SDK.** Requires an object-storage access layer in BOTH Node server and Python. Formats-as-prefixes, not per-type buckets. |

**⚠️ CRITICAL CSAIL storage constraint:** both volume types are **redundant but NOT
backed up**, and there are **no automated snapshots**. "Production" (Ceph RBD, the default;
the only other type "Experimental" is wiped without notice) survives hardware failure but
NOT accidental deletion / DB corruption / dropped collections. → **Our own backups are
load-bearing.** Plan: daily `mongodump` → object storage (baseline), PLUS a periodic
**off-CSAIL** copy for true DR (CSAIL object storage is presumably also not-backed-up).
TIG-hosted **NFS is backed up** — an alternative if we want CSAIL-managed backup.

**On upload, `process_audio.py` transcodes every file into 3 formats:** `audio/wav/`
(lossless master, ~80% of the 25GB), `audio/mp3/` (192k playback), `audio/opus/` (web
streaming); the originally-uploaded format is preserved as its own copy. wav = master
(precious → `idtap-media`); mp3/opus = regenerable delivery encodings (→ `idtap-derived`).
Improvement to add during rewrite: always stash the raw upload at `idtap-media/original/`
(the current `else` branch for non-wav/non-mp3 uploads doesn't preserve the original).

---

## 4. Execution plan (restructure-first, with an early validation gate)

> Sequencing decision: **restructure-first** — object storage is cleaner built into the
> new architecture than bolted onto legacy. But validate the risky infra in a thin
> vertical slice *before* the full refactor lands on top of it.

### Phase 0 — Fork & baseline (safe, no deploy impact)
- [ ] Create empty repos under Jon's **personal** GitHub account.
- [ ] Push `idtap` and `Python-API` as **detached copies** (NOT GitHub "Fork" — a fork
      stays linked to UCSC-IDTAP). Full history preserved.
- [ ] Confirm `UCSC-IDTAP/*` remains untouched (DO auto-deploy on main must not fire).
- [ ] Inventory the current box: apt packages, pip freeze (captured), nvm/node,
      pm2/systemd services, nginx config, cron (backups). → provisioning checklist.

### ⚠️ OS DECISION: Ubuntu 24.04, NOT 26.04 (changed 2026-07-09)
Originally deployed 26.04 (Python 3.14). **MongoDB 8.x will NOT run on Ubuntu 26.04** — 26.04
ships **kernel 7.0**, and MongoDB 8.x has a hard startup guard refusing kernel ≥6.19
(SERVER-121912: TCMalloc violates the rseq ABI on new kernels; fatal `uname` guard id
12257600 fires before startup; `GLIBC_TUNABLES=glibc.pthread.rseq=0` does NOT bypass it;
Docker wouldn't help — shared kernel; MongoDB 7.0 has no noble repo). Official fix =
downgrade kernel (impractical on Puppet-managed box). **Resolution: redeployed the instance
on `CSAIL-Ubuntu-24.04LTS` (kernel 6.8, Python 3.12) — MongoDB 8.0.26 runs cleanly.** Redeploy
was cheap: Swift containers, Cinder volume, WebDNS IP (relaunch with eth0 Fixed IP
128.52.132.248), and security groups all carried over; only OS-level installs redone. Audio
stack validated fine on 3.12 too. **Track as a future issue** (per owner): if MongoDB later
fixes SERVER-121912, a newer Ubuntu becomes viable — but no need to chase it; 24.04 is good
until 2029.

### Gotchas found while provisioning
- **CSAIL-Ubuntu image ships a broken NVIDIA CUDA apt repo** (`nvidia-cuda.list` +
  `nvidia-hpc-sdk.list`) — missing GPG key, cosmetic `apt-get update` noise, non-blocking.
  Disable by `mv`-ing to `.disabled` (Puppet may restore on 26.04; on 24.04 done once).
- **Don't run two apt-using provisioning jobs in parallel** — dpkg lock contention; one fails.
- **`sudo: unable to resolve host idtap-server.novalocal`** — add `127.0.1.1 idtap-server.novalocal idtap-server` to `/etc/hosts`.
- **CSAIL OpenStack RC file omits domain vars** — append `OS_USER_DOMAIN_NAME`/`OS_PROJECT_DOMAIN_NAME=Default` + `OS_IDENTITY_API_VERSION=3`.
- **New-instance boot:** SSH `Connection refused` for ~1–2 min after launch is just boot/cloud-init; wait. (ICMP ping stays blocked — normal.)

### Phase 1 — Thin vertical slice on OpenStack (de-risk the infra)
- [ ] Attach a **Cinder volume**, mount at `/var/lib/mongodb`.
- [ ] Install **MongoDB** (self-hosted), migrate a sample DB via `mongodump`/`mongorestore`
      from Atlas.
- [ ] Confirm CSAIL **object-storage API** (S3 vs Swift); create a bucket/container;
      prove one upload + signed-URL download from both Node and Python.
- [x] **Audio stack validated on Python 3.14 (2026-07-09) — the biggest risk, retired.**
      In a venv (`~/audio-venv`), latest/unpinned installed with prebuilt wheels, no
      compile: essentia 2.1b6.dev1438 (cp314), numba 0.66.0 + llvmlite 0.48.0,
      numpy 2.4.6, librosa 0.11.0, scipy 1.18.0, soundfile 0.14.0, sklearn 1.9.0,
      resampy 0.4.3, matplotlib 3.11.0. DSP correct on a 440Hz tone: librosa
      melspectrogram + YIN (440.6Hz), essentia PitchYin (439.6Hz). ffmpeg installed via apt.
- [ ] Next: port the actual IDTAP audio scripts (`process_audio.py`, `visualization_*`)
      onto this stack + the new model, and process a real uploaded file end-to-end.
- [ ] Install **Node (nvm)** to match prod (v20.x) + pnpm.
- [ ] Stand up MongoDB on a Cinder volume; migrate sample data from Atlas.

### Phase 2 — Repo restructure (on the personal copies)
- [ ] Convert `idtap` to a pnpm workspace: `apps/web`, `apps/server`, `packages/model`,
      `packages/shared`, `services/audio` (extract prod Python from the 602 MB pile).
- [ ] Port `server/extract.ts` onto `src/ts/model/`; delete `src/js/classes.ts` +
      `server/classes.ts`.
- [ ] Stand up **`idtap-contract`**: author schemas + golden fixtures (non-12-TET,
      stripped, dual-string). Wire conformance tests into both `idtap` and `idtap-api` CI.
- [ ] Consolidate the two endpoint families onto a shared data-access layer.
- [ ] Build the **object-storage access layer** in server + Python (replace local-disk IO).

### Phase 3 — Full deploy & cutover
- [ ] Full data migration (DB + all media to object storage).
- [ ] Provision box to match: nginx, TLS, services, backup cron → Cinder/object storage.
- [ ] **Add auth to the web API routes** (open finding from review-2026 — currently no auth).
- [ ] End-to-end validation against the replica.
- [ ] DNS cutover (`swara.studio`), decommission DigitalOcean.

---

## 4a. CSAIL networking model (researched 2026-07-08)

**Confirmed: the box is currently NOT publicly reachable** (public-internet test from
off-VPN: 100% packet loss, ports 22/80/443 all unreachable; works only over GlobalProtect).

**But it CAN be public** — the `inet` network is "a publicly accessible IPv4 network"
(TIG). Two gates to public reachability:
1. **Security group** — default deny-all; we opened 22/80/443 from `0.0.0.0/0`. ✓ done.
2. **WebDNS IP registration — NOT done, this is the blocker.** CSAIL requires registered
   IPs; the current `128.52.136.161` is an unregistered *dynamic* lease. MIT/CSAIL's
   perimeter blocks public inbound to unregistered IPs (anti-spoofing / host-registration
   policy) → reachable on-campus/VPN but invisible publicly. Exactly our symptom.

**Fix (documented route to permanent public access):**
- [x] In **WebDNS**, reserved fixed IP → **`idtap.csail.mit.edu` = `128.52.132.248`**
      (forward + PTR confirmed). Old dynamic `128.52.136.161` retired.
- [x] Relaunched instance on the registered fixed IP (`eth0 Fixed IP`), `default` SG attached.
- [x] Verified: SSH 22 **works over VPN** (box/SG/DNS all correct).
- [ ] **BLOCKED — public inbound still filtered off-VPN.** Box is fine; it's the MIT/CSAIL
      **border firewall** not yet allowing public inbound to the new IP. → propagation delay
      and/or explicit request to `help@csail.mit.edu` (email drafted). **Public hosting +
      certbot are blocked until this clears.** Re-test off-VPN periodically.
- [ ] Once public: point `swara.studio` A record at `128.52.132.248`.

**nginx/TLS impact:** minimal. Still run own nginx on the VM (CSAIL doesn't front VMs).
TLS options: certbot (as today), `mod_md` (CSAIL-offered auto-LE), or InCommon (only for
`*.csail.mit.edu` names, NOT swara.studio). For swara.studio → certbot/Let's Encrypt.

**To check on the VM (next VPN session):** does CSAIL-Ubuntu bake in auto-registration /
config management (`/etc/csail`, MOTD, cloud-init, puppet) that changes any of this.

## Object storage API — RESOLVED 2026-07-09: **Swift (NOT S3)**
Object Store endpoint = **`https://ceph.csail.mit.edu/swift/v1`** (Ceph RadosGW via the
**Swift API**; S3 URL is None — no S3 interface). Auth via **Keystone**
(`https://keystone.csail.mit.edu:5001/v3`, project `idtap` / `872cde8f2da74be69a8e1519c900188e`).
The EC2 access/secret keys are for the **compute** EC2 API (`https://ec2api.csail.mit.edu`),
NOT object storage.
- **Credential gap:** Jon lacks Identity access → can't self-create Application
  Credentials. Swift needs Keystone auth. Verification = password-based RC file (interactive).
  **For the production app** (server can't use an interactive CSAIL password) we need a
  **service credential** (Application Credential or RadosGW Swift key) → **TIG/Proulx ask.**
- **The S3/EC2 door is CLOSED for real work (tested 2026-07-09).** EC2/S3 keys can reach
  RadosGW's S3 face and return clean 404s for *non-existent* names, but **every operation on
  the actual Keystone-created containers fails with `404 NoSuchKey`** — PUT/GET/LIST/DELETE
  on `idtap-media`, plus create-bucket and list-all-buckets. Root cause: the EC2 credential
  maps to a Keystone user with **no native RadosGW account**, so it can't see/touch the
  project's Swift containers. (S3 presigned-URL generation "succeeds" but the URL 404s — useless.)
  **Conclusion: the app MUST use the Swift API + a Keystone credential; S3 keys cannot substitute.**
- **App needs a Keystone service credential** → **Application Credential** (clean; Jon lacks
  Identity access to self-create → TIG ask) OR Jon's personal CSAIL password (works but bad
  for a server: personal login, rotation breakage, flaky 401s — dev stopgap only). Fold the
  Application-Credential request into the next TIG/Proulx email (with the firewall ask).
- **⚠️ NAMING: use hyphens, not underscores.** Jon initially named containers
  `idtap_media`/`idtap_derived`. Underscores are valid Swift container names but **INVALID
  S3 bucket names** (RadosGW returns 400 InvalidArgument) → unaddressable via S3, kills
  future S3 portability (AWS/Backblaze/MinIO/if CSAIL exposes S3). **Rename to
  `idtap-media`/`idtap-derived`** (hyphens) while empty. Verify existing containers via
  `swift list` (needs interactive Keystone token from RC file).
- **Storage-layer design:** build against the **Swift API**. Private containers + serve via
  **Swift temp URLs** (Swift's presigned-URL equivalent) after app-side permission check.
  Python: `python-swiftclient`. Node: a Swift client lib or Keystone-token + Swift REST.
- CLI access on the box: `~/os-venv` has `openstack`/`swift` clients; needs a Keystone
  credential (Application Credential → `clouds.yaml` at `~/.config/openstack/clouds.yaml`).

## 5. Open questions / to confirm
- **`idtap-contract`** as its own repo vs. a package in the monorepo dual-published?
  (leaning own-repo so the public Python client doesn't pull the whole platform)
- **DNS / TLS:** who controls `swara.studio` DNS; cert strategy on the new box.
- **Backups:** replicate the `/root/backups` daily `mongodump` cron; target = Cinder or
  object storage.
- Does CSAIL OpenStack impose **egress/firewall** limits that affect Google OAuth, PyPI,
  npm, or the MongoDB clients?

## Object-store reliability (measured 2026-07-09)
Horizon's object-store **web panel is intermittently erroring** on reload (the "stale deploy"
Proulx flagged). BUT the **RadosGW/Swift data backend itself is rock-solid**: 15/15 direct S3
GET calls from the box returned consistent clean responses at ~56–64ms, zero variance.
**HOWEVER — the Keystone-authenticated Swift path is FLAKY:** `openstack`/`swift` operations
(create/delete/list container) returned **HTTP 401 Unauthorized ~half the time**, transient,
succeeding on retry. So flakiness lives in the **Keystone token-issuance / Swift-Keystone
auth layer**, NOT the S3 data path. → **Production-app implication: cache Keystone tokens and
add retry-on-401/5xx with backoff for all Swift ops.** Idempotent retry loops
(`for i in 1..5; do ... && break || sleep 2; done`) were needed to reliably create/delete.
Use the API/CLI (not the web console) as the authoritative check.

## Containers — CREATED 2026-07-09
Both created via Swift (Keystone, `openstack container create`, "Default" domain), **private
by default**: **`idtap-media`** (wav masters) + **`idtap-derived`** (mp3/opus + visualizations),
hyphen-named for S3 portability. (Took retries past the 401 flakiness.) Note: S3/EC2 creds can
READ RadosGW but can't CREATE/list-all (RadosGW+Keystone "no native account" quirk → NoSuchKey);
and Swift-created containers don't resolve via plain S3 path-addressing (400) — so **Swift is
the authoritative interface here, not S3.** RC-file gotcha: CSAIL's OpenStack RC file omits
`OS_USER_DOMAIN_NAME`/`OS_PROJECT_DOMAIN_NAME`/`OS_IDENTITY_API_VERSION` — must append
(domain = `Default`).

## 6. Risks
- **Big-bang refactor with no running system** — mitigated by the Phase 1 gate.
- **Object-storage layer** is the largest code change (touches server + Python).
- **essentia** is a beta/dev build, Linux-x86_64 wheel only — pin a known-good version.
- **Model contract** must cover the nasty cases or it gives false confidence.

---

## Appendix A — Current box provisioning (captured 2026-07-08, read-only)

**App serving**
- nginx reverse-proxies **80/443 → `localhost:3000`** (node). Configs in the single
  `sites-enabled/default` (no conf.d).
- Vhosts: `swara.studio` + `www.swara.studio` on 443 (TLS), and a **port-80
  `default_server` (`server_name _`) that also proxies to the app** — this is why the
  API is reachable by raw IP (ties to the review-2026 "no auth on web API" finding).
- `client_max_body_size 2000M`; proxy timeouts **5400s** (90 min) for long analysis;
  WebSocket upgrade headers present (app uses ws). → **replicate all three in new nginx.**

**TLS**: Let's Encrypt via **certbot**, cert `swara.studio` (+www), expires **2026-08-25**.
New box needs certbot once `swara.studio` DNS points at it (needs port 80 reachable —
note the CSAIL IP is VPN-only, which complicates public ACME; confirm DNS/ACME path).

**Node launch (fragile — modernize on new box)**
- Running process: `ts-node server.ts` (TypeScript executed directly, **not compiled**),
  under **nodemon**, inside a **tmux** session. No systemd unit, no process manager, no
  auto-start on reboot. → new box should use a **systemd service** (or pm2 startup)
  running the built server, auto-restart + boot-persistence.
- node **v20.19.2** (`/usr/bin/node`; nvm also has v16.16.0), **pnpm 10.30.1**.
- Second tmux session **`mass_uploads_watcher`** = `directory_watcher.py` (mass-upload
  ingest) — another background service to reprovision.

**Data / secrets**
- **No local MongoDB** — confirms Atlas today. Self-hosted Mongo is net-new.
- `/root/.env` holds only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `VUE_APP_GOOGLE_CLIENT_ID`. **The Mongo Atlas URI + Python-API JWT secret are NOT in
  this .env** — locate their real config source before migration (needed to repoint to
  local Mongo). → open item.
- Backup cron: `45 20 * * *  python3 backups/backup_mongo.py` (daily 20:45 mongodump).

## Appendix B — Secrets / auth config (investigated 2026-07-09)

- **Mongo URI is assembled in code** (`server.ts` ~L200): `mongodb+srv://${USER_NAME}:${PASSWORD}@swara.f5cuf.mongodb.net/swara?retryWrites=true&w=majority`.
  Only two secrets: **`USER_NAME`** + **`PASSWORD`** (Atlas). Cluster host is hardcoded.
- **Auth = Google OAuth passthrough, NOT local JWT.** `/oauth/token` calls Google's
  `OAuthClient.getToken()` and returns Google's access/id/refresh tokens. **No local JWT
  signing secret exists** → nothing extra to migrate on the auth side.
- **Full secret set for new box:** `USER_NAME`, `PASSWORD` (Atlas — needed only for the
  final dump before cutover to local Mongo), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `VUE_APP_GOOGLE_CLIENT_ID`.
- **GAP:** old box `/root/.env` had only the 3 Google vars, NOT `USER_NAME`/`PASSWORD`.
  Atlas creds are injected elsewhere (nodemon.json / tmux shell env / second env file).
  → **Jon to locate the actual Atlas credential values** for the DB migration.
