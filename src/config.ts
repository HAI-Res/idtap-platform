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
export const SERVER_BASE: string =
  (import.meta.env.VITE_API_URL as string | undefined) ||
  (import.meta.env.DEV ? 'https://swara.studio/' : location.origin + '/');
