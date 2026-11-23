/** Model files for the desktop app (server/modelRoutes.ts). */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import modelRoutes from '../../../server/modelRoutes';

let dir = '';
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idtap-models-'));
  fs.writeFileSync(path.join(dir, 'student.tar'), 'abcdefghij');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'not in the manifest');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, files: [{ name: 'student.tar', size: 10 }] }));
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function app(signedIn = true, d: string | undefined = dir) {
  const a = express();
  a.use((req, _res, next) => { if (signedIn) (req as any).user = { uid: 'u' }; next(); });
  const requireSession: express.RequestHandler = (req, res, next) => {
    if (!(req as any).user?.uid) { res.status(401).json({ error: 'authentication required' }); return; }
    next();
  };
  a.use(modelRoutes({ requireSession }, d));
  return a;
}

describe('model files', () => {
  test('a signed-in user gets the manifest and a listed file', async () => {
    const m = await request(app()).get('/models/manifest');
    expect(m.status).toBe(200);
    expect(m.body.files).toEqual([{ name: 'student.tar', size: 10 }]);
    const f = await request(app()).get('/models/file/student.tar');
    expect(f.status).toBe(200);
    expect(f.body.toString()).toBe('abcdefghij');
  });

  test('a Range request resumes a download', async () => {
    const f = await request(app()).get('/models/file/student.tar').set('Range', 'bytes=4-');
    expect(f.status).toBe(206);
    expect(f.body.toString()).toBe('efghij');
  });

  test('no session: 401 for both', async () => {
    expect((await request(app(false)).get('/models/manifest')).status).toBe(401);
    expect((await request(app(false)).get('/models/file/student.tar')).status).toBe(401);
  });

  test('only files the manifest lists are served', async () => {
    expect((await request(app()).get('/models/file/secret.txt')).status).toBe(404);
    expect((await request(app()).get('/models/file/manifest.json')).status).toBe(404);
    expect((await request(app()).get('/models/file/..%2Fmanifest.json')).status).toBe(404);
    expect((await request(app()).get('/models/file/.hidden')).status).toBe(404);
  });

  test('off until a pack is there', async () => {
    expect((await request(app(true, '')).get('/models/manifest')).body).toEqual({ error: 'models-unavailable' });
    expect((await request(app(true, path.join(dir, 'nope'))).get('/models/file/student.tar')).status).toBe(404);
  });
});
