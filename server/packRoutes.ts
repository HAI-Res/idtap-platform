/**
 * PROP-9: phoneme packs served by the API, from the copies bundled in shared/packs
 * (the same data the model uses; contract-conformance.test.ts checks they equal
 * the contract's packs/).
 *   GET /api/packs       -> { ids: [...], packs: { id: { id, name, packVersion, status } } }
 *   GET /api/packs/:id   -> the pack JSON, or 404
 */
import express from 'express';
import { PACKS } from '../shared/syllables';

export default function packRoutes() {
  const router = express.Router();
  router.get('/', (_req: express.Request, res: express.Response) => {
    const ids = Object.keys(PACKS).sort();
    const packs = Object.fromEntries(ids.map(id => {
      const p = PACKS[id];
      return [id, { id: p.id, name: p.name, packVersion: p.packVersion, status: p.status }];
    }));
    res.json({ ids, packs });
  });
  router.get('/:id', (req: express.Request, res: express.Response) => {
    const p = Object.prototype.hasOwnProperty.call(PACKS, req.params.id) ? PACKS[req.params.id] : undefined;
    if (!p) {
      res.status(404).json({ error: `unknown pack '${req.params.id}'` });
      return;
    }
    res.json(p);
  });
  return router;
}
