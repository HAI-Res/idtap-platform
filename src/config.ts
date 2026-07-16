// Base URL for all API + media requests.
//
// Historically this was hardcoded to https://swara.studio/ throughout the frontend,
// which meant a build served from anywhere still talked to the DigitalOcean prod
// server. For the CSAIL migration the frontend must call whichever origin served it.
//
// - Deployed build (idtap.csail.mit.edu, swara.studio): same-origin — the app talks
//   to the server that served it. No per-environment config needed.
// - `vite dev` (localhost:3000, no local backend proxy): defaults to prod so the
//   existing "develop the frontend against the live API" workflow keeps working.
// - Any environment can override explicitly with VITE_API_URL.
//
// `location.origin` (not `window.location.origin`) so this also resolves correctly
// inside Web Workers, where `window` is undefined but `location` exists.
//
// Node-safety: server.ts pulls this module into its bundle transitively
// (server.ts → extract → serverCalls → config). In that CJS/Node context there is
// no `import.meta.env` and no `location`, so both accesses must be guarded or the
// server crashes on load. SERVER_BASE is never actually *used* server-side; it just
// has to evaluate without throwing. Vite still statically provides `import.meta.env`
// in the browser build, so the frontend behavior is unchanged.
const _env: { VITE_API_URL?: string; DEV?: boolean } =
  ((import.meta as unknown as { env?: Record<string, unknown> }).env as
    | { VITE_API_URL?: string; DEV?: boolean }
    | undefined) || {};
const _origin: string =
  typeof location !== 'undefined' ? location.origin + '/' : 'https://swara.studio/';
export const SERVER_BASE: string =
  _env.VITE_API_URL || (_env.DEV ? 'https://swara.studio/' : _origin);
