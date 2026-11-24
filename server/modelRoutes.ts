/**
 * Model files for the desktop app (idtap-swift "Set up models"): the lab's own transcription model
 * weights and code, for signed-in users.
 *   GET /models/manifest       -> the pack's manifest.json (what there is, sizes, sha256)
 *   GET /models/file/:name     -> one file of the pack; Range requests resume a download
 * The pack is a folder on this server named by IDTAP_MODELS_DIR, holding manifest.json and the files
 * it lists (`files: [{ name, size, sha256 }]`). Only listed names are served. Unset, or with no
 * manifest, both routes answer 404 `models-unavailable`, so the feature is off until a pack is put
 * there. Both need a session; nothing here writes.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';

type Mw = express.RequestHandler;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function readManifest(dir: string | undefined): { files: { name: string; size?: number; sha256?: string }[]; [k: string]: unknown } | null {
  if (!dir) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return m && Array.isArray(m.files) ? m : null;
  } catch {
    return null;
  }
}

export default function modelRoutes(guards: { requireSession: Mw }, dir: string | undefined = process.env.IDTAP_MODELS_DIR) {
  const router = express.Router();
  const unavailable = (res: express.Response) => { res.status(404).json({ error: 'models-unavailable' }); };

  router.get('/models/manifest', guards.requireSession, (_req: express.Request, res: express.Response) => {
    const manifest = readManifest(dir);
    if (!manifest) { unavailable(res); return; }
    res.set('Cache-Control', 'private, no-store').json(manifest);
  });

  router.get('/models/file/:name', guards.requireSession, (req: express.Request, res: express.Response) => {
    const manifest = readManifest(dir);
    if (!manifest || !dir) { unavailable(res); return; }
    const name = req.params.name;
    // only a plain file name the manifest lists: no path, no dotfile, nothing else in the folder
    if (!SAFE_NAME.test(name) || !manifest.files.some(f => f.name === name)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.sendFile(name, { root: path.resolve(dir), dotfiles: 'deny', acceptRanges: true,
      headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/octet-stream' } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  });

  return router;
}
