/**
 * PROP-7 Edit Tradition routes and the save routes' system rule
 * (server/systemRoutes.ts, SPEC-provisional §3).
 */
import { describe, test, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import systemRoutes, { systemChangeError } from '../../../server/systemRoutes';

const ID = '64b7f0f0f0f0f0f0f0f0f0f0';
const OWNER = 'owner-id';
const hindiDoc = (extra: any = {}) => ({
  _id: { toString: () => ID }, userID: OWNER, explicitPermissions: { edit: [], view: [], publicView: true },
  instrumentation: ['Vocal (F)'], trackTitles: ['Lead'],
  phraseGrid: [[{ trajectoryGrid: [[{ id: 0, uniqueId: 'a', vowel: 'ā' }]] }]], ...extra,
});
const blankDoc = (extra: any = {}) => hindiDoc({ phraseGrid: [[{ trajectoryGrid: [[{ id: 0, uniqueId: 'a' }]] }]], ...extra });

function app(doc: any, uid = OWNER, matched = 1) {
  const updates: any[] = [];
  const queries: any[] = [];
  const transcriptions = {
    findOne: async () => doc,
    updateOne: async (q: any, u: any) => { updates.push(u); queries.push(q); return { acknowledged: true, matchedCount: matched }; },
  };
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as any).user = { uid }; next(); });
  const pass: express.RequestHandler = (_req, _res, next) => next();
  a.use(systemRoutes(transcriptions, { requireSession: pass, requireCsrfHeader: pass }));
  return { a, updates, queries };
}

describe('POST /transcriptionSystemOptions', () => {
  test('per-option verdicts, with the track named in a refusal', async () => {
    const { a } = app(hindiDoc());
    const r = await request(a).post('/transcriptionSystemOptions').send({ id: ID });
    expect(r.status).toBe(200);
    expect(r.body.system).toBeNull();
    expect(r.body.editable).toBe(true);
    expect(r.body.options['hindi-urdu']).toEqual({ ok: true });
    expect(r.body.options.jyutping.ok).toBe(false);
    expect(r.body.options.jyutping.reason).toMatch(/Lead \(Vocal \(F\)\)/);
    expect(r.body.options.jyutping.reason).toMatch(/erase the Hindi vowels/);
  });
  test('404 for an unknown id', async () => {
    const { a } = app(null);
    expect((await request(a).post('/transcriptionSystemOptions').send({ id: ID })).status).toBe(404);
  });
});

describe('POST /updateTranscriptionSystem', () => {
  test('sets the system on a blank piece', async () => {
    const { a, updates } = app(blankDoc());
    const sys = { phonology: 'kurmanji', display: ['kurmanji-latin'] };
    const r = await request(a).post('/updateTranscriptionSystem').send({ id: ID, system: sys });
    expect(r.status).toBe(200);
    expect(updates).toEqual([{ $set: { system: sys } }]);
  });
  test('refuses a switch that would erase Hindi vowels (409); allows hindi-urdu', async () => {
    const { a, updates } = app(hindiDoc());
    expect((await request(a).post('/updateTranscriptionSystem').send({ id: ID, system: { phonology: 'jyutping' } })).status).toBe(409);
    expect((await request(a).post('/updateTranscriptionSystem').send({ id: ID, system: { phonology: 'hindi-urdu' } })).status).toBe(200);
    expect(updates).toHaveLength(1);
  });
  test('refuses a bad shape (400), an unknown pack (400) and a non-editor (403)', async () => {
    expect((await request(app(blankDoc()).a).post('/updateTranscriptionSystem').send({ id: ID, system: 'x' })).status).toBe(400);
    expect((await request(app(blankDoc()).a).post('/updateTranscriptionSystem').send({ id: ID, system: { phonology: 'klingon' } })).status).toBe(400);
    const priv = blankDoc({ explicitPermissions: { edit: [], view: [], publicView: true } });
    expect((await request(app(priv, 'someone-else').a).post('/updateTranscriptionSystem').send({ id: ID, system: { phonology: 'kurmanji' } })).status).toBe(403);
  });
});

describe('systemChangeError (the save routes)', () => {
  test('unchanged or unsent passes; a forbidden change is refused; a removal is refused', () => {
    const tiered = hindiDoc({ system: { phonology: 'hindi-urdu' } });
    expect(systemChangeError(tiered, undefined)).toBeNull();
    expect(systemChangeError(tiered, { phonology: 'hindi-urdu' })).toBeNull();
    expect(systemChangeError(tiered, { phonology: 'kurmanji' })?.status).toBe(409);
    expect(systemChangeError(tiered, null)?.status).toBe(400);
    expect(systemChangeError(blankDoc(), { phonology: 'kurmanji' })).toBeNull();
  });
});

describe('review of #68 (routes)', () => {
  test('the tradition update is conditional: 409 when it changed meanwhile', async () => {
    const { a, queries } = app(blankDoc(), OWNER, 0);
    const r = await request(a).post('/updateTranscriptionSystem').send({ id: ID, system: { phonology: 'kurmanji' } });
    expect(r.status).toBe(409);
    expect(JSON.stringify(queries[0])).toMatch(/\$exists/);
  });
  test('the save routes refuse a stale Hindi-vowel save into a non-Hindi piece', () => {
    const stored = blankDoc({ system: { phonology: 'kurmanji' } });
    const grid = [[{ trajectoryGrid: [[{ id: 0, uniqueId: 'a', vowel: 'a' }]] }]];
    expect(systemChangeError(stored, undefined, grid)?.status).toBe(409);
    expect(systemChangeError(stored, undefined, [[{ trajectoryGrid: [[{ id: 0, uniqueId: 'a' }]] }]])).toBeNull();
  });
});
