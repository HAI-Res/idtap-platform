/**
 * PROP-7 Edit Tradition (lyric mode, SPEC-provisional §3).
 *   POST /transcriptionSystemOptions {id}            -> { system, options: {phonology: {ok, reason?}} }
 *   POST /updateTranscriptionSystem  {id, system}    -> $set system only, when systemChangeAllowed
 * Both need a session; the update needs the CSRF header and canEdit.
 */
import express from 'express';
import { ObjectId } from 'mongodb';
import { canEdit, canView } from '../shared/authz';
import { PACKS, systemChangeAllowed, validateSystem } from '../shared/syllables';

/** The `system` each modal option writes (spec §3 table). */
export const TRADITION_SYSTEMS: { [phonology: string]: { phonology: string; display: string[] } } = {
  'hindi-urdu': { phonology: 'hindi-urdu', display: ['sargam', 'Deva'] },
  jyutping: { phonology: 'jyutping', display: ['jyutping', 'Hant'] },
  kurmanji: { phonology: 'kurmanji', display: ['kurmanji-latin'] },
};

type Mw = express.RequestHandler;

export default function systemRoutes(
  transcriptions: { findOne: (q: any, o?: any) => Promise<any>; updateOne: (q: any, u: any) => Promise<any> },
  guards: { requireSession: Mw; requireCsrfHeader: Mw },
) {
  const router = express.Router();
  const load = async (id: unknown) => {
    if (typeof id !== 'string' || !ObjectId.isValid(id)) return null;
    return transcriptions.findOne(
      { _id: new ObjectId(id) },
      { projection: { system: 1, instrumentation: 1, phraseGrid: 1, userID: 1, explicitPermissions: 1, permissions: 1 } },
    );
  };

  router.post('/transcriptionSystemOptions', guards.requireSession, async (req: express.Request, res: express.Response) => {
    try {
      const doc = await load(req.body?.id);
      if (!doc) { res.status(404).json({ error: 'not found' }); return; }
      if (!canView(doc, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
      const options: { [k: string]: { ok: boolean; reason?: string } } = {};
      for (const [ph, sys] of Object.entries(TRADITION_SYSTEMS)) {
        if (!PACKS[ph]) continue;
        const r = systemChangeAllowed(doc, sys);
        options[ph] = r.ok ? { ok: true } : { ok: false, reason: r.reason };
      }
      res.json({ system: doc.system ?? null, editable: canEdit(doc, req.user!.uid), options });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.post('/updateTranscriptionSystem', guards.requireSession, guards.requireCsrfHeader, async (req: express.Request, res: express.Response) => {
    try {
      const doc = await load(req.body?.id);
      if (!doc) { res.status(404).json({ error: 'not found' }); return; }
      if (!canEdit(doc, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
      const next = req.body?.system;
      const valid = validateSystem(next);
      if (!valid.ok) { res.status(400).json({ error: valid.reason }); return; }
      const allowed = systemChangeAllowed(doc, next);
      if (!allowed.ok) { res.status(409).json({ error: allowed.reason }); return; }
      await transcriptions.updateOne({ _id: doc._id }, { $set: { system: next } });
      res.json({ ok: true, system: next });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  return router;
}

/**
 * For the save routes: a save may not change `system` past the rule either.
 * Unchanged (or not sent, which a $set leaves in place) passes. -> null or an error body.
 */
export function systemChangeError(stored: any, sent: unknown): { status: 400 | 409; error: string } | null {
  if (sent === undefined) return null;
  if (JSON.stringify(sent ?? null) === JSON.stringify(stored?.system ?? null)) return null;
  const valid = validateSystem(sent);
  if (!valid.ok) return { status: 400, error: valid.reason };
  const allowed = systemChangeAllowed(stored, sent as any);
  return allowed.ok ? null : { status: 409, error: allowed.reason };
}
