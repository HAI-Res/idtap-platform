import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { transcribeUserRoutes, transcribeWorkerRoutes, STALE_MS } from '../../../server/transcribeRoutes';

vi.mock('../../../server/mediaConfig', () => ({
  mediaPath: (...segs: string[]) => ['mocked-media', ...segs].join('/'),
}));

// A small in-memory stand-in for the few collection calls the routes make.
const match = (doc: any, q: any): boolean => Object.entries(q).every(([k, v]: [string, any]) => {
  const got = k.split('.').reduce((o, p) => (o == null ? o : o[p]), doc);
  if (v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date)) {
    if ('$in' in v) return v.$in.some((x: any) => String(x) === String(got));
    if ('$lt' in v) return got !== undefined && got < v.$lt;
    if ('$gte' in v) return got !== undefined && got >= v.$gte;
  }
  return String(got) === String(v);
});
const apply = (doc: any, u: any) => {
  Object.assign(doc, u.$set ?? {});
  for (const k of Object.keys(u.$unset ?? {})) delete doc[k];
  for (const [k, n] of Object.entries(u.$inc ?? {})) doc[k] = (doc[k] ?? 0) + (n as number);
  for (const [k, x] of Object.entries(u.$push ?? {})) (doc[k] ??= []).push(x);
};
const coll = (docs: any[] = []) => ({
  docs,
  findOne: async (q: any) => docs.find(d => match(d, q)) ?? null,
  insertOne: async (d: any) => { d._id = new ObjectId(); docs.push(d); return { insertedId: d._id }; },
  countDocuments: async (q: any) => docs.filter(d => match(d, q)).length,
  updateOne: async (q: any, u: any) => { const d = docs.find(x => match(x, q)); if (d) apply(d, u); return { matchedCount: d ? 1 : 0 }; },
  updateMany: async (q: any, u: any) => { const m = docs.filter(x => match(x, q)); m.forEach(d => apply(d, u)); return { matchedCount: m.length }; },
  findOneAndUpdate: async (q: any, u: any) => {
    const d = docs.filter(x => match(x, q)).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (d) apply(d, u);
    return d ?? null;
  },
  find: (q: any) => ({ sort: () => ({ limit: () => ({ toArray: async () => docs.filter(d => match(d, q)) }) }) }),
});

const OWNER = new ObjectId(), OTHER = new ObjectId(), REC = new ObjectId();
const TOKEN = 'worker-secret';
let c: any, clock: Date, opts: any;
const app = (sub = 'owner-sub') => {
  const a = express();
  a.use(express.json());
  a.use('/worker', transcribeWorkerRoutes(c, opts));
  a.use((req, _res, next) => { (req as any).user = { id: sub }; next(); });
  a.use('/api', transcribeUserRoutes(c, opts));
  return a;
};
const W = (r: request.Test) => r.set('Authorization', `Bearer ${TOKEN}`).set('X-IDTAP-Worker', 'w1');

beforeEach(() => {
  clock = new Date('2026-11-20T12:00:00Z');
  c = {
    transcribeJobs: coll(),
    transcriptions: coll(),
    audioRecordings: coll([{ _id: REC, userID: OWNER.toString(), explicitPermissions: { edit: [], view: [], publicView: false } }]),
    users: coll([
      { _id: OWNER, sub: 'owner-sub', email: 'Owner@x.edu' },
      { _id: OTHER, sub: 'other-sub', email: 'other@x.edu' },
    ]),
  };
  opts = { workerToken: TOKEN, allowedUsers: ['owner@x.edu', 'other@x.edu'], maxAudioSeconds: 1800, now: () => clock };
});

describe('starting a job', () => {
  const body = { recordingId: REC.toString(), model: 'student', tonic: 220, voice: 'F' };

  test('the owner of a recording can start one; a second is refused while it runs', async () => {
    const r = await request(app()).post('/api/transcribe').send(body);
    expect(r.status).toBe(200);
    expect(c.transcribeJobs.docs[0]).toMatchObject({ userID: OWNER.toString(), status: 'queued', params: { model: 'student', tonic: 220, voice: 'F', separate: true } });
    expect((await request(app()).post('/api/transcribe').send(body)).status).toBe(409);
  });

  test('a private recording cannot be transcribed by someone else', async () => {
    expect((await request(app('other-sub')).post('/api/transcribe').send(body)).status).toBe(403);
  });

  test('off for accounts not on the list, and for everyone without a worker token', async () => {
    opts.allowedUsers = ['other@x.edu'];
    expect((await request(app()).post('/api/transcribe').send(body)).status).toBe(403);
    opts.allowedUsers = ['*']; opts.workerToken = undefined;
    expect((await request(app()).post('/api/transcribe').send(body)).status).toBe(403);
  });

  test('bad input is refused', async () => {
    const post = (b: any) => request(app()).post('/api/transcribe').send(b);
    expect((await post({ ...body, model: 'nope' })).status).toBe(400);
    expect((await post({ ...body, tonic: undefined })).status).toBe(400);     // the student needs a tonic
    expect((await post({ ...body, tonic: -1 })).status).toBe(400);
    expect((await post({ ...body, recordingId: 'x' })).status).toBe(400);
    expect((await post({ ...body, recordingId: new ObjectId().toString() })).status).toBe(404);
    c.audioRecordings.docs[0].duration = 4000;
    expect((await post(body)).status).toBe(413);
  });

  test('a job is visible to its owner only', async () => {
    const id = (await request(app()).post('/api/transcribe').send(body)).body.jobId;
    expect((await request(app()).get(`/api/transcribe/${id}`)).body.status).toBe('queued');
    expect((await request(app('other-sub')).get(`/api/transcribe/${id}`)).status).toBe(404);
  });
});

describe('the web app (session sign-in)', () => {
  const sessionApp = (uid?: string) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { if (uid) (req as any).user = { uid }; next(); });
    a.use('/session', transcribeUserRoutes(c, opts, 'session'));
    return a;
  };
  test('the session user id is the Mongo _id; the same rules apply', async () => {
    const body = { recordingId: REC.toString(), model: 'rg_world_tx' };
    const r = await request(sessionApp(OWNER.toString())).post('/session/transcribe').send(body);
    expect(r.status).toBe(200);
    expect(c.transcribeJobs.docs[0].userID).toBe(OWNER.toString());
    expect((await request(sessionApp(OWNER.toString())).get('/session/transcribe')).body.jobs).toHaveLength(1);
    expect((await request(sessionApp(OTHER.toString())).post('/session/transcribe').send(body)).status).toBe(403);
    expect((await request(sessionApp()).post('/session/transcribe').send(body)).status).toBe(401);
    expect((await request(sessionApp('not-an-id')).post('/session/transcribe').send(body)).status).toBe(401);
  });
});

describe('the worker side', () => {
  const start = async () => (await request(app()).post('/api/transcribe')
    .send({ recordingId: REC.toString(), model: 'student', tonic: 220, title: 'T' })).body.jobId as string;

  test('needs the token; is absent when no token is configured', async () => {
    expect((await request(app()).post('/worker/claim').send({ worker: 'w1', models: ['student'] })).status).toBe(401);
    opts.workerToken = undefined;
    expect((await W(request(app()).post('/worker/claim')).send({ worker: 'w1', models: ['student'] })).status).toBe(404);
  });

  test('claim, events, result: the piece is private, owned by the requester and linked to the recording', async () => {
    const id = await start();
    expect((await W(request(app()).post('/worker/claim')).send({ worker: 'w1', models: ['rg_world_tx'] })).status).toBe(204);
    const claim = await W(request(app()).post('/worker/claim')).send({ worker: 'w1', models: ['student'] });
    expect(claim.body).toMatchObject({ jobId: id, recordingId: REC.toString(), params: { model: 'student', tonic: 220 } });
    expect((await W(request(app()).post('/worker/claim')).send({ worker: 'w2', models: ['student'] })).status).toBe(204);

    const ev = (events: any[]) => W(request(app()).post(`/worker/job/${id}/events`)).send({ events });
    await ev([{ event: 'phase', phase: 'separate' }, { event: 'progress', done: 1, total: 8 }]);
    await ev([{ event: 'progress', done: 2, total: 8 }]);
    expect((await request(app()).get(`/api/transcribe/${id}`)).body.events).toEqual(
      [{ event: 'phase', phase: 'separate' }, { event: 'progress', done: 2, total: 8 }]);

    const piece = { title: 'T', phraseGrid: [[]], userID: 'someone-else', audioID: 'x', _id: 'y',
      explicitPermissions: { edit: [], view: [], publicView: true } };
    const done = await W(request(app()).post(`/worker/job/${id}/result`)).send({ piece });
    expect(done.status).toBe(200);
    expect(c.transcriptions.docs[0]).toMatchObject({ userID: OWNER.toString(), audioID: REC.toString(),
      explicitPermissions: { edit: [], view: [], publicView: false }, permissions: 'Private' });
    expect(c.users.docs[0].transcriptions).toHaveLength(1);
    const job = (await request(app()).get(`/api/transcribe/${id}`)).body;
    expect(job).toMatchObject({ status: 'done', pieceId: c.transcriptions.docs[0]._id.toString() });
    // the job is finished: the worker can no longer write to it
    expect((await ev([{ event: 'phase', phase: 'x' }])).status).toBe(409);
  });

  test('another worker cannot touch a held job; a cancelled job tells its worker to stop', async () => {
    const id = await start();
    await W(request(app()).post('/worker/claim')).send({ worker: 'w1', models: ['student'] });
    const other = request(app()).post(`/worker/job/${id}/result`).set('Authorization', `Bearer ${TOKEN}`).set('X-IDTAP-Worker', 'w2');
    expect((await other.send({ piece: { phraseGrid: [[]] } })).status).toBe(409);
    await request(app()).post(`/api/transcribe/${id}/cancel`);
    expect((await W(request(app()).post(`/worker/job/${id}/events`)).send({ events: [] })).status).toBe(409);
    expect(c.transcriptions.docs).toHaveLength(0);
  });

  test('a silent worker loses its job: requeued once, then failed', async () => {
    const id = await start();
    const claim = (w: string) => W(request(app()).post('/worker/claim')).send({ worker: w, models: ['student'] });
    await claim('w1');
    clock = new Date(clock.getTime() + STALE_MS + 1000);
    expect((await claim('w2')).body.jobId).toBe(id);                 // second attempt
    clock = new Date(clock.getTime() + STALE_MS + 1000);
    expect((await claim('w3')).status).toBe(204);
    expect(c.transcribeJobs.docs[0]).toMatchObject({ status: 'failed', error: { code: 'worker' } });
  });

  test('a failed run records the error', async () => {
    const id = await start();
    await W(request(app()).post('/worker/claim')).send({ worker: 'w1', models: ['student'] });
    await W(request(app()).post(`/worker/job/${id}/result`)).send({ error: { code: 'audio', message: 'no singing found' } });
    expect((await request(app()).get(`/api/transcribe/${id}`)).body).toMatchObject({ status: 'failed', error: { code: 'audio' } });
  });
});
