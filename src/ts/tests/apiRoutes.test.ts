import { describe, test, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import apiRoutes from '../../../server/apiRoutes';

// uploadAudio spawns PYTHON_PATH and builds media paths after its DB writes;
// neuter both so the upload tests never touch disk or a real interpreter.
vi.mock('../../../server/mediaConfig', () => ({
  mediaPath: (...segs: string[]) => ['mocked-media', ...segs].join('/'),
  PYTHON_PATH: 'echo',
  pythonEnv: () => ({ ...process.env }),
}));

describe('apiRoutes /transcriptions', () => {
  test('succeeds when many documents are present', async () => {
    const docs = Array.from({ length: 1000 }, (_, i) => ({ _id: String(i), title: `t${i}` }));
    let usedProjection: any = null;
    const cursor = {
      project(p: any) { usedProjection = p; return this; },
      collation() { return this; },
      sort() { return this; },
      toArray() { return Promise.resolve(docs); },
    };
    const collections = {
      transcriptions: { find: () => cursor } as any,
      users: {
        findOne: (query: any) => Promise.resolve({ _id: 'mock-mongo-user-id' })
      } as any,
    };
    const app = express();

    // Mock authentication middleware
    app.use((req, res, next) => {
      req.user = { id: 'mock-google-user-id' };
      next();
    });

    app.use(apiRoutes(collections as any));
    const res = await request(app)
      .get('/transcriptions')
      .query({ userId: 'u1', sortKey: 'title', sortDir: '1' });

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(docs.length);
    const expectedProjection = {
      title: 1,
      dateCreated: 1,
      dateModified: 1,
      location: 1,
      _id: 1,
      durTot: 1,
      raga: 1,
      userID: 1,
      permissions: 1,
      name: 1,
      family_name: 1,
      given_name: 1,
      audioID: 1,
      instrumentation: 1,
      explicitPermissions: 1,
      soloist: 1,
      soloInstrument: 1,
    };
    expect(usedProjection).toEqual(expectedProjection);
  });
});

// ---- authz on the Bearer (/api) surface ----

const ACTOR = '634d9506a6a3647e543b7641'; // mongo user _id of the authenticated caller
const OTHER = '7c4d9506a6a3647e543b7642';
const DOC = '63f8103c4ffa426afde2f6a8';

import express2 from 'express';

function appWith(collections: any, sub = 'sub-actor') {
  const app = express2();
  app.use(express2.json());
  app.use((req, res, next) => {
    req.user = { id: sub, sub };
    next();
  });
  app.use(apiRoutes({
    users: { findOne: () => Promise.resolve({ _id: { toString: () => ACTOR } }) },
    ...collections,
  } as any));
  return app;
}

describe('apiRoutes authz', () => {
  test('GET /transcription/:id denies private doc to non-viewer', async () => {
    const app = appWith({
      transcriptions: {
        findOne: () => Promise.resolve({ _id: DOC, userID: OTHER, explicitPermissions: { publicView: false, edit: [], view: [] } }),
      },
    });
    const res = await request(app).get(`/transcription/${DOC}`);
    expect(res.status).toBe(403);
  });

  test('GET /transcription/:id honors legacy string permissions', async () => {
    const app = appWith({
      transcriptions: {
        findOne: () => Promise.resolve({ _id: DOC, userID: OTHER, permissions: 'Public' }),
      },
    });
    const res = await request(app).get(`/transcription/${DOC}`);
    expect(res.status).toBe(200);
  });

  test('POST /transcription without _id inserts owned by caller', async () => {
    let inserted: any = null;
    let userUpdate: any = null;
    const app = appWith({
      transcriptions: {
        insertOne: (doc: any) => { inserted = doc; return Promise.resolve({ acknowledged: true, insertedId: DOC }); },
      },
      users: {
        findOne: () => Promise.resolve({ _id: { toString: () => ACTOR } }),
        updateOne: (q: any, u: any) => { userUpdate = u; return Promise.resolve({}); },
      },
    });
    const res = await request(app)
      .post('/transcription')
      .send({ title: 't', userID: 'attacker-supplied', dateCreated: '2026-01-01', dateModified: '2026-01-01' });
    expect(res.status).toBe(200);
    expect(inserted.userID).toBe(ACTOR); // owner comes from the token, not the body
    expect(userUpdate.$push.transcriptions).toBe(DOC);
  });

  test('POST /transcription update strips ownership/sharing fields', async () => {
    let updateArg: any = null;
    const app = appWith({
      transcriptions: {
        findOne: () => Promise.resolve({ _id: DOC, userID: ACTOR }),
        updateOne: (q: any, u: any) => { updateArg = u; return Promise.resolve({ acknowledged: true }); },
      },
    });
    const res = await request(app)
      .post('/transcription')
      .send({ _id: DOC, title: 'new', userID: OTHER, explicitPermissions: { publicView: true, edit: [], view: [] } });
    expect(res.status).toBe(200);
    expect(updateArg.$set.title).toBe('new');
    expect(updateArg.$set.userID).toBeUndefined();
    expect(updateArg.$set.explicitPermissions).toBeUndefined();
  });

  test('POST /transcription/:id/clone forbids un-viewable source', async () => {
    const app = appWith({
      transcriptions: {
        findOne: () => Promise.resolve({ _id: DOC, userID: OTHER, explicitPermissions: { publicView: false, edit: [], view: [] } }),
      },
    });
    const res = await request(app).post(`/transcription/${DOC}/clone`).send({ title: 'copy' });
    expect(res.status).toBe(403);
  });

  test('POST /transcription/:id/clone clones viewable source to caller', async () => {
    let inserted: any = null;
    const app = appWith({
      transcriptions: {
        findOne: () => Promise.resolve({ _id: DOC, userID: OTHER, title: 'orig', explicitPermissions: { publicView: true, edit: [], view: [] } }),
        insertOne: (doc: any) => { inserted = doc; return Promise.resolve({ acknowledged: true, insertedId: 'new-id' }); },
      },
    });
    const res = await request(app).post(`/transcription/${DOC}/clone`).send({ title: 'copy' });
    expect(res.status).toBe(200);
    expect(inserted.userID).toBe(ACTOR);
    expect(inserted.title).toBe('copy');
  });

  test('DELETE /transcription/:id forbids non-owner (even with edit access)', async () => {
    const app = appWith({
      transcriptions: {
        findOne: () => Promise.resolve({ _id: DOC, userID: OTHER, explicitPermissions: { publicView: true, edit: [ACTOR], view: [] } }),
      },
    });
    const res = await request(app).delete(`/transcription/${DOC}`);
    expect(res.status).toBe(403);
  });

  test('DELETE /transcription/:id deletes owned doc and prunes user array', async () => {
    let pulled: any = null;
    const app = appWith({
      transcriptions: {
        findOne: () => Promise.resolve({ _id: DOC, userID: ACTOR }),
        deleteOne: () => Promise.resolve({ acknowledged: true, deletedCount: 1 }),
      },
      users: {
        findOne: () => Promise.resolve({ _id: { toString: () => ACTOR } }),
        updateOne: (q: any, u: any) => { pulled = u; return Promise.resolve({}); },
      },
    });
    const res = await request(app).delete(`/transcription/${DOC}`);
    expect(res.status).toBe(200);
    expect(res.body.deletedCount).toBe(1);
    expect(pulled.$pull.transcriptions).toBeDefined();
  });

  test('GET /audioRecording/:id gates on view permission', async () => {
    const priv = appWith({
      audioRecordings: {
        findOne: () => Promise.resolve({ _id: DOC, userID: OTHER, explicitPermissions: { publicView: false, edit: [], view: [] } }),
      },
    });
    expect((await request(priv).get(`/audioRecording/${DOC}`)).status).toBe(403);

    const pub = appWith({
      audioRecordings: {
        findOne: () => Promise.resolve({ _id: DOC, userID: OTHER, explicitPermissions: { publicView: true, edit: [], view: [] } }),
      },
    });
    expect((await request(pub).get(`/audioRecording/${DOC}`)).status).toBe(200);
  });
});

describe('apiRoutes POST /uploadAudio permissions', () => {
  function uploadApp(captured: {
    event?: any; aeUpdate?: any; recording?: any;
  }) {
    const app = express2();
    app.use(express2.json());
    app.use((req, res, next) => {
      req.user = { id: 'sub-actor', sub: 'sub-actor' };
      (req as any).files = {
        audioFile: {
          name: 'a.mp3',
          mimetype: 'audio/mpeg',
          size: 3,
          mv: () => Promise.resolve(),
        },
      };
      next();
    });
    app.use(apiRoutes({
      users: { findOne: () => Promise.resolve({ _id: { toString: () => ACTOR } }) },
      audioEvents: {
        insertOne: (doc: any) => { captured.event = doc; return Promise.resolve({ insertedId: doc._id }); },
        findOneAndUpdate: (q: any, u: any) => { captured.aeUpdate = u; return Promise.resolve({}); },
      },
      audioRecordings: {
        insertOne: (doc: any) => { captured.recording = doc; return Promise.resolve({ acknowledged: true }); },
      },
    } as any));
    return app;
  }

  test('publicView: false stays false on event, recording slot, and recording doc', async () => {
    const captured: any = {};
    const res = await request(uploadApp(captured)).post('/uploadAudio').send({
      metadata: JSON.stringify({ title: 'x', permissions: { publicView: false, edit: [], view: [] } }),
    });
    expect(res.status).toBe(200);
    expect(captured.event.visibility).toBe('private');
    expect(captured.event.explicitPermissions.publicView).toBe(false);
    expect(captured.aeUpdate.$set['recordings.0.explicitPermissions'].publicView).toBe(false);
    expect(captured.recording.explicitPermissions.publicView).toBe(false);
  });

  test('omitted permissions default to private (matching visibility)', async () => {
    const captured: any = {};
    const res = await request(uploadApp(captured)).post('/uploadAudio').send({
      metadata: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(200);
    expect(captured.event.visibility).toBe('private');
    expect(captured.event.explicitPermissions.publicView).toBe(false);
    expect(captured.recording.explicitPermissions.publicView).toBe(false);
  });

  test('publicView: true passes through', async () => {
    const captured: any = {};
    const res = await request(uploadApp(captured)).post('/uploadAudio').send({
      metadata: JSON.stringify({ title: 'x', permissions: { publicView: true, edit: [], view: [] } }),
    });
    expect(res.status).toBe(200);
    expect(captured.event.visibility).toBe('public');
    expect(captured.event.explicitPermissions.publicView).toBe(true);
    expect(captured.recording.explicitPermissions.publicView).toBe(true);
  });
});
