// IDTAP desktop shell.
//
// Serves the repo's built frontend (dist/) from a local origin, proxies API and
// media calls to the upstream server, and signs in via the system browser
// (see auth.mjs). The renderer runs the stock web app — no preload, no IPC:
// everything desktop-specific happens at the HTTP layer in localServer.mjs.

import { app, BrowserWindow, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startLocalServer } from './localServer.mjs';
import { startLoginFlow } from './auth.mjs';
import { loadToken, saveToken } from './tokenStore.mjs';

const UPSTREAM = (process.env.IDTAP_UPSTREAM || 'https://swara.studio').replace(/\/$/, '');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = process.env.IDTAP_DIST || path.resolve(__dirname, '..', '..', 'dist');

let win = null;
let sessionToken = null;
let appOrigin = null;

// A desktop app holds unsaved transcription edits in the renderer; a stray throw in
// the main process (a bad request to the local server, a socket error) must not be
// allowed to end the session. Log and keep running.
process.on('uncaughtException', (err) => console.error('uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

function reportLoginFailure(err) {
  console.error('desktop login failed:', err?.message || err);
  dialog.showErrorBox(
    'Sign-in failed',
    `${err?.message || err}\n\nClose the browser tab and try signing in again.`,
  );
  // the renderer is parked on the "signing in…" page; put it back in the app
  if (win && appOrigin) win.loadURL(`${appOrigin}/`);
}

function createWindow(origin) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'IDTAP',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // external links (papers, github, …) go to the real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !url.startsWith(origin)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
  win.loadURL(`${origin}/`);
  return win;
}

app.whenReady().then(async () => {
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    dialog.showErrorBox(
      'Frontend build not found',
      `Expected the built web app at:\n${DIST_DIR}\n\nRun "pnpm build" in the repo root first (or set IDTAP_DIST).`,
    );
    app.quit();
    return;
  }

  sessionToken = loadToken();

  const { origin } = await startLocalServer({
    distDir: DIST_DIR,
    upstream: UPSTREAM,
    getSessionToken: () => sessionToken,
    setSessionToken: (t) => { sessionToken = t; saveToken(t); },
    onLoginRequest: () => {
      startLoginFlow({
        upstream: UPSTREAM,
        openExternal: (url) => shell.openExternal(url),
        onSuccess: (token) => { sessionToken = token; saveToken(token); },
        onFailure: reportLoginFailure,
      }).catch(reportLoginFailure); // e.g. the loopback listener can't bind
    },
  });

  appOrigin = origin;
  createWindow(origin);
  app.on('activate', () => { if (!win) createWindow(origin); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
