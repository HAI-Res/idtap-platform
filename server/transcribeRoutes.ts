/**
 * Model transcription jobs: a recording in, a private transcription out.
 *
 * The site never runs a model. It keeps a queue (collection `transcribeJobs`)
 * and workers pull from it: a worker claims the oldest queued job, downloads
 * the recording, runs source separation and the model, and posts back events
 * and the finished piece. Workers only make outbound calls, so they can sit
 * anywhere (HAI-Res/idtap-transcribe is the worker).
 *
 * Two surfaces:
 *  - user routes, mounted under the Bearer-authenticated /api router:
 *      POST /api/transcribe          start a job on a recording the caller may view
 *      GET  /api/transcribe          the caller's recent jobs
 *      GET  /api/transcribe/:id      status, events and the piece id when done
 *      POST /api/transcribe/:id/cancel
 *    and the same four under /session for the web app's cookie sign-in.
 *  - worker routes, mounted at /worker with a shared token
 *    (IDTAP_WORKER_TOKEN; with it unset the whole feature is off):
 *      POST /worker/claim
 *      GET  /worker/job/:id/audio
 *      POST /worker/job/:id/events
 *      POST /worker/job/:id/result
 *
 * Who may start jobs: IDTAP_TRANSCRIBE_USERS, a comma-separated list of user
 * emails, or `*` for every signed-in user. Unset means nobody.
 */
import express from 'express';
import fs from 'fs';
import crypto from 'crypto';
import { Collection, ObjectId } from 'mongodb';

import { mediaPath } from './mediaConfig';
import { canView } from '../shared/authz';

export const MODELS = ['student', 'rg_world_tx'] as const;
export type Model = (typeof MODELS)[number];

/** A running job whose worker has been silent this long goes back in the queue. */
export const STALE_MS = 10 * 60 * 1000;
/** A job is tried this many times before it fails for good. */
export const MAX_ATTEMPTS = 2;
/** Events kept per job (progress lines are replaced, not appended). */
const MAX_EVENTS = 200;

interface Collections {
  transcribeJobs: Collection;
  transcriptions: Collection;
  audioRecordings: Collection;
  users: Collection;
}

export interface TranscribeOptions {
  /** Shared secret of the workers; undefined turns the feature off. */
  workerToken?: string;
  /** Emails allowed to start jobs, or ['*']. */
  allowedUsers?: string[];
  /** Longest recording accepted, seconds (from the recording's own duration when stored). */
  maxAudioSeconds?: number;
  now?: () => Date;
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): TranscribeOptions {
  return {
    workerToken: env.IDTAP_WORKER_TOKEN || undefined,
    allowedUsers: (env.IDTAP_TRANSCRIBE_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    maxAudioSeconds: Number(env.IDTAP_TRANSCRIBE_MAX_SECONDS) || 30 * 60,
  };
}

const oid = (s: string): ObjectId | null => (ObjectId.isValid(s) ? new ObjectId(s) : null);

/** What a client sees of a job. */
const publicJob = (j: any) => ({
  _id: j._id,
  status: j.status,
  model: j.params?.model,
  recordingId: j.recordingId,
  createdAt: j.createdAt,
  startedAt: j.startedAt,
  finishedAt: j.finishedAt,
  events: j.events ?? [],
  pieceId: j.pieceId,
  error: j.error,
});

/**
 * `auth` says how the caller was identified upstream: 'bearer' (the /api router: req.user.id is the
 * Google sub) or 'session' (the web app's cookie: req.user.uid is the Mongo user _id).
 */
export function transcribeUserRoutes(
  collections: Collections, opts: TranscribeOptions = optionsFromEnv(), auth: 'bearer' | 'session' = 'bearer',
) {
  const router = express.Router();
  const now = opts.now ?? (() => new Date());

  const actor = async (req: express.Request) => {
    const u = req.user as { id?: string; uid?: string; email?: string } | undefined;
    const sessionId = auth === 'session' && u?.uid && ObjectId.isValid(u.uid) ? new ObjectId(u.uid) : null;
    if (auth === 'session' && !sessionId) return undefined;
    const user = await collections.users.findOne(sessionId ? { _id: sessionId } : { sub: u?.id });
    return user ? { id: user._id.toString(), email: String(user.email || u?.email || '').toLowerCase() } : undefined;
  };
  const allowed = (email: string) =>
    !!opts.workerToken && !!opts.allowedUsers?.length && (opts.allowedUsers.includes('*') || opts.allowedUsers.includes(email));

  router.post('/transcribe', async (req, res) => {
    try {
      const me = await actor(req);
      if (!me) return res.status(401).json({ error: 'User not authenticated' });
      if (!allowed(me.email)) return res.status(403).json({ error: 'Model transcription is not enabled for this account' });

      const b = req.body ?? {};
      const model: Model = b.model ?? 'student';
      if (!MODELS.includes(model)) return res.status(400).json({ error: `model must be one of ${MODELS.join(', ')}` });
      if (b.voice !== undefined && b.voice !== 'M' && b.voice !== 'F') return res.status(400).json({ error: 'voice must be M or F' });
      for (const k of ['tonic', 'lam'] as const) {
        if (b[k] !== undefined && !(typeof b[k] === 'number' && isFinite(b[k]) && b[k] > 0)) {
          return res.status(400).json({ error: `${k} must be a positive number` });
        }
      }
      if (model === 'student' && b.tonic === undefined) {
        return res.status(400).json({ error: 'the student model needs a tonic (Hz)' });
      }
      const recId = oid(String(b.recordingId ?? ''));
      if (!recId) return res.status(400).json({ error: 'recordingId is required' });
      const recording = await collections.audioRecordings.findOne({ _id: recId });
      if (!recording) return res.status(404).json({ error: 'Recording not found' });
      if (!canView(recording, me.id)) return res.status(403).json({ error: 'forbidden' });
      if (opts.maxAudioSeconds && typeof recording.duration === 'number' && recording.duration > opts.maxAudioSeconds) {
        return res.status(413).json({ error: `Recording is longer than ${Math.round(opts.maxAudioSeconds / 60)} minutes` });
      }

      const active = await collections.transcribeJobs.findOne({ userID: me.id, status: { $in: ['queued', 'running'] } });
      if (active) return res.status(409).json({ error: 'You already have a transcription running', jobId: active._id });

      const params: Record<string, unknown> = { model, voice: b.voice ?? 'M', separate: b.separate !== false };
      for (const k of ['tonic', 'lam'] as const) if (b[k] !== undefined) params[k] = b[k];
      for (const k of ['title', 'raga'] as const) if (typeof b[k] === 'string' && b[k]) params[k] = String(b[k]).slice(0, 200);
      const result = await collections.transcribeJobs.insertOne({
        userID: me.id, recordingId: recId.toString(), params, status: 'queued', attempts: 0, events: [], createdAt: now(),
      });
      const ahead = await collections.transcribeJobs.countDocuments({ status: 'queued', _id: { $lt: result.insertedId } });
      res.json({ jobId: result.insertedId, queuedAhead: ahead });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/transcribe', async (req, res) => {
    try {
      const me = await actor(req);
      if (!me) return res.status(401).json({ error: 'User not authenticated' });
      const jobs = await collections.transcribeJobs.find({ userID: me.id }).sort({ createdAt: -1 }).limit(20).toArray();
      res.json({ enabled: allowed(me.email), models: MODELS, jobs: jobs.map(publicJob) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/transcribe/:id', async (req, res) => {
    try {
      const me = await actor(req);
      const id = oid(req.params.id);
      if (!me) return res.status(401).json({ error: 'User not authenticated' });
      if (!id) return res.status(400).json({ error: 'bad job id' });
      const job = await collections.transcribeJobs.findOne({ _id: id });
      if (!job || job.userID !== me.id) return res.status(404).json({ error: 'Job not found' });
      res.json(publicJob(job));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/transcribe/:id/cancel', async (req, res) => {
    try {
      const me = await actor(req);
      const id = oid(req.params.id);
      if (!me) return res.status(401).json({ error: 'User not authenticated' });
      if (!id) return res.status(400).json({ error: 'bad job id' });
      const r = await collections.transcribeJobs.updateOne(
        { _id: id, userID: me.id, status: { $in: ['queued', 'running'] } },
        { $set: { status: 'cancelled', finishedAt: now() } },
      );
      if (!r.matchedCount) return res.status(404).json({ error: 'No running job with that id' });
      res.json({ cancelled: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export function transcribeWorkerRoutes(collections: Collections, opts: TranscribeOptions = optionsFromEnv()) {
  const router = express.Router();
  const now = opts.now ?? (() => new Date());

  router.use((req, res, next) => {
    if (!opts.workerToken) return res.status(404).end();
    const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
    const want = Buffer.from(opts.workerToken);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(401).json({ error: 'bad worker token' });
    next();
  });

  /** The job, if this worker holds it and it is still running. */
  const held = async (req: express.Request) => {
    const id = oid(req.params.id);
    const worker = String(req.headers['x-idtap-worker'] || '');
    if (!id || !worker) return null;
    return collections.transcribeJobs.findOne({ _id: id, status: 'running', worker });
  };

  router.post('/claim', async (req, res) => {
    try {
      const worker = String(req.body?.worker || '');
      const models: string[] = Array.isArray(req.body?.models) ? req.body.models.map(String) : [];
      if (!worker || !models.length) return res.status(400).json({ error: 'worker and models are required' });
      const t = now();
      const stale = new Date(t.getTime() - STALE_MS);
      // a worker that went quiet: requeue its job, or fail it after the last attempt
      await collections.transcribeJobs.updateMany(
        { status: 'running', heartbeatAt: { $lt: stale }, attempts: { $gte: MAX_ATTEMPTS } },
        { $set: { status: 'failed', finishedAt: t, error: { code: 'worker', message: 'The worker stopped responding' } } },
      );
      await collections.transcribeJobs.updateMany(
        { status: 'running', heartbeatAt: { $lt: stale } },
        { $set: { status: 'queued' }, $unset: { worker: '' } },
      );
      const filter: Record<string, unknown> = { status: 'queued', 'params.model': { $in: models } };
      if (req.body?.canSeparate === false) filter['params.separate'] = false;
      const job = await collections.transcribeJobs.findOneAndUpdate(
        filter,
        { $set: { status: 'running', worker, startedAt: t, heartbeatAt: t, events: [] }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      );
      const doc: any = job && 'value' in (job as any) ? (job as any).value : job;   // driver 5 and 6 differ
      if (!doc) return res.status(204).end();
      res.json({ jobId: doc._id, recordingId: doc.recordingId, params: doc.params });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/job/:id/audio', async (req, res) => {
    try {
      const job = await held(req);
      if (!job) return res.status(404).json({ error: 'Job not held by this worker' });
      const file = mediaPath('audio', 'wav', job.recordingId + '.wav');
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'Recording file missing' });
      res.type('audio/wav');
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/job/:id/events', async (req, res) => {
    try {
      const job = await held(req);
      // 409 tells the worker to stop: the job was cancelled or taken back
      if (!job) return res.status(409).json({ error: 'Job not held by this worker' });
      const incoming: any[] = Array.isArray(req.body?.events) ? req.body.events.slice(-MAX_EVENTS) : [];
      let events: any[] = job.events ?? [];
      for (const e of incoming) {
        if (!e || typeof e.event !== 'string') continue;
        // one progress line, updated in place
        if (e.event === 'progress' && events.length && events[events.length - 1].event === 'progress') events[events.length - 1] = e;
        else events.push(e);
      }
      events = events.slice(-MAX_EVENTS);
      await collections.transcribeJobs.updateOne({ _id: job._id }, { $set: { events, heartbeatAt: now() } });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/job/:id/result', async (req, res) => {
    try {
      const job = await held(req);
      if (!job) return res.status(409).json({ error: 'Job not held by this worker' });
      const t = now();
      if (req.body?.error) {
        const error = { code: String(req.body.error.code || 'failed'), message: String(req.body.error.message || '').slice(0, 2000) };
        await collections.transcribeJobs.updateOne({ _id: job._id }, { $set: { status: 'failed', finishedAt: t, error } });
        return res.json({ ok: true });
      }
      const piece = req.body?.piece;
      if (!piece || typeof piece !== 'object' || !Array.isArray(piece.phraseGrid)) {
        return res.status(400).json({ error: 'piece is required' });
      }
      // Ownership, the recording link and privacy are set here, never taken from the worker.
      const insert = { ...piece };
      delete insert._id;
      insert.userID = job.userID;
      insert.audioID = job.recordingId;
      insert.permissions = 'Private';
      insert.explicitPermissions = { edit: [], view: [], publicView: false };
      insert.dateCreated = t;
      insert.dateModified = t;
      insert.transcribedBy = { model: job.params?.model, jobId: job._id.toString(), provenance: req.body?.provenance ?? null };
      const result = await collections.transcriptions.insertOne(insert);
      await collections.users.updateOne({ _id: new ObjectId(job.userID) }, { $push: { transcriptions: result.insertedId } } as any);
      await collections.transcribeJobs.updateOne(
        { _id: job._id },
        { $set: { status: 'done', finishedAt: t, pieceId: result.insertedId.toString() } },
      );
      res.json({ ok: true, pieceId: result.insertedId });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
