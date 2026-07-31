
import express, { Request, Response } from 'express';
import fileUpload from 'express-fileupload';
import bodyParser from 'body-parser';
import cors from 'cors';
import morgan from 'morgan';
import { MongoClient, ObjectId } from 'mongodb';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import history from 'connect-history-api-fallback';
import cron from 'node-cron';
import aggregations from './aggregations.js';
import { OAuth2Client } from 'google-auth-library';
import { DN_Extractor } from './extract';
import { DN_ExtractorOptions } from '@shared/types';
import 'dotenv/config';
import { $push } from 'mongo-dot-notation';
import apiRoutes from './apiRoutes';
import oauthRoutes from './oauthRoutes';
import authRoutes from './authRoutes';
import cookieParser from 'cookie-parser';
import {
  verifySession, signSession, sessionCookieOptions, SESSION_COOKIE, SESSION_TTL_SECONDS,
} from './session';
import { canView, canEdit, isOwner } from '@shared/authz';

import { mediaPath, PYTHON_PATH, UPLOAD_TMP_DIR, pythonEnv } from './mediaConfig';

// Load Google OAuth credentials from environment variables
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('ERROR: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables must be set');
  process.exit(1);
}

console.log('Using Google OAuth credentials from environment variables');

// Extend Express Request interface to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email?: string;
        sub: string;
        /** Mongo user _id — present for web-session requests (attachUser) */
        uid?: string;
        name?: string;
      };
    }
  }
}

const app = express();

// Google OAuth client for token verification
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Function to verify Google OAuth token
async function verifyGoogleToken(token: string) {
  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload) {
      throw new Error('Invalid token payload');
    }
    return payload;
  } catch (error) {
    throw new Error('Token verification failed');
  }
}
async function exists (path: string) {  
  try {
	await fs.access(path)
	return true
  } catch {
	return false
  }
}

// Function to run a Python script and return a Promise
function runPythonScript(scriptPath: string, args: string[] = []): Promise<void> {
  return new Promise<void>((resolve, reject) => {
	const pythonProcess = spawn(PYTHON_PATH, [scriptPath, ...args], { env: pythonEnv() });

	pythonProcess.stdout.on('data', (data) => {
	  console.log(`stdout from ${scriptPath}: ${data}`);
	});

	pythonProcess.stderr.on('data', (data) => {
	  console.error(`stderr from ${scriptPath}: ${data}`);
	});

	pythonProcess.on('close', (code) => {
	  console.log(`${scriptPath} process exited with code ${code}`);
	  if (code === 0) {
		resolve();
	  } else {
		reject(new Error(`${scriptPath} process exited with code ${code}`));
	  }
	});
  });
}

const deleteFiles = async (audioID: string) => {
  const peaksPath = mediaPath('peaks', audioID + '.json');
  const spectrogramsPath = mediaPath('spectrograms', audioID);
  const mp3Path = mediaPath('audio', 'mp3', audioID + '.mp3');
  const wavPath = mediaPath('audio', 'wav', audioID + '.wav');
  const opusPath = mediaPath('audio', 'opus', audioID + '.opus');
  // also reclaim the per-recording melograph + spec_data dirs (rm force = no-op if absent)
  fs.rm(mediaPath('melographs', audioID), { recursive: true, force: true })
  fs.rm(mediaPath('spec_data', audioID), { recursive: true, force: true })
  const peaksPathExists = await exists(peaksPath);
  const spectrogramsPathExists = await exists(spectrogramsPath);
  const mp3PathExists = await exists(mp3Path);
  const wavPathExists = await exists(wavPath);
  const opusPathExists = await exists(opusPath);
  if (peaksPathExists) {
	fs.unlink(peaksPath)
  }
  if (spectrogramsPathExists) {
	fs.rm(spectrogramsPath, { recursive: true, force: true })
  }
  if (mp3PathExists) {
	fs.unlink(mp3Path)
  }
  if (wavPathExists) {
	fs.unlink(wavPath)
  }
  if (opusPathExists) {
	fs.unlink(opusPath)
  }
}

const getSuffix = (mimetype: string): string | undefined => {
  // TODO add other audio file types
  const end = mimetype.split('/')[1];
  if (end === 'mpeg') {
	return '.mp3'
  } else if (end === 'wav' || end === 'x-wav') {
	return '.wav'
  } else if (end === 'm4a' || end === 'x-m4a') {
	return '.m4a'
  } else if (end === 'flac' || end === 'x-flac') {
	return '.flac'
  } else if (end === 'ogg' || end === 'x-ogg') {
	return '.opus'
  } else if (end === 'opus' || end === 'x-opus') {
	return '.opus'
  }
};

cron.schedule('0 0 * * *', () => {
  spawn(PYTHON_PATH, ['delete_unlinked_audio.py'], { env: pythonEnv() })
})

// schedule a cron job to backup every day
cron.schedule('0 0 * * *', () => {
  spawn(PYTHON_PATH, ['backups/backup_mongo.py'], { env: pythonEnv() })
});

app.use(fileUpload({
  createParentPath: true,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB limit
  useTempFiles: true,
  tempFileDir: UPLOAD_TMP_DIR,
  abortOnLimit: false
}))
app.use(history({
  htmlAcceptHeaders: ['text/html'],
  // Don't SPA-rewrite the server-handled auth/session endpoints. /auth/callback in
  // particular is a top-level browser navigation (Accept: text/html) that would
  // otherwise be swallowed into index.html. Rewrite them to themselves (path + query
  // preserved) so they fall through to the real route handlers.
  rewrites: [
    { from: /^\/(auth|session)\//, to: ({ parsedUrl }: any) => parsedUrl.pathname + (parsedUrl.search || '') },
  ],
}) as unknown as express.RequestHandler)

app.use(cors({
  origin: '*'
}));
app.use(bodyParser({
  limit: '1000mb'
}))
app.use(express.json({
  type: ['application/json', 'text/plain']
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(morgan('dev'));

app.set('trust proxy', 1);
app.use(cookieParser());
// Populate req.user from the `sid` session cookie on every request. NON-BLOCKING:
// this only *identifies* the caller; per-route enforcement (401/403 + ownership
// checks via shared/authz) is added in the handler sweep. Public routes keep working
// logged-out (req.user simply stays undefined).
app.use((req, res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const s = verifySession(token);
    if (s) {
      req.user = { id: s.sub, sub: s.sub, uid: s.uid, email: s.email, name: s.name };
      // sliding session: re-issue once past half its lifetime so active users don't
      // get logged out mid-session.
      const nowSec = Math.floor(Date.now() / 1000);
      if (s.exp - nowSec < SESSION_TTL_SECONDS / 2) {
        res.cookie(
          SESSION_COOKIE,
          signSession({ sub: s.sub, uid: s.uid, email: s.email, name: s.name }),
          sessionCookieOptions(),
        );
      }
    }
  }
  next();
});

// Sentinel actor id for unauthenticated requests on public-readable endpoints: it is
// not a valid ObjectId string, so `{ userID: NO_SESSION }` / permission-array matches
// match no real document — public clauses still apply, private ones never leak.
const NO_SESSION = '__no_session__';

// --- A5 enforcement guards (used per-route in the handler sweep) ---
// requireSession: 401 unless a verified session (sid cookie) populated req.user.
const requireSession: express.RequestHandler = (req, res, next) => {
  if (!req.user?.uid) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  next();
};
// requireCsrfHeader: 403 on state-changing requests lacking the app's custom header.
// A cross-site attacker can't set a custom header without a CORS preflight we don't
// grant, so this closes the residual gap left by SameSite=Lax. The SPA sends it via a
// shared request wrapper.
const requireCsrfHeader: express.RequestHandler = (req, res, next) => {
  if (req.get('X-IDTAP-Client') !== 'web') {
    res.status(403).json({ error: 'missing client header' });
    return;
  }
  next();
};

const apiTimeout = 600000;
app.use((req, res, next) => {
  // Set the timeout for all HTTP requests
  req.setTimeout(apiTimeout, () => {
	let err = new Error('Request Timeout') as Error & { status?: number };
	err.status = 408;
	next(err);
  });
  // Set the server response timeout for all HTTP requests
  res.setTimeout(apiTimeout, () => {
	let err = new Error('Service Unavailable') as Error & { status?: number };
	err.status = 503;
	next(err);
  });
  next();
});
const settings = 'retryWrites=true&w=majority';
const webAddress = 'swara.f5cuf.mongodb.net/swara';
const password = process.env.PASSWORD;
const username = process.env.USER_NAME;
const login = `srv://${username}:${password}`;
// MONGO_URI overrides the Atlas connection (e.g. the CSAIL box's local mongod:
// mongodb://127.0.0.1:27017). Unset => build the Atlas srv URI from USER_NAME/PASSWORD
// exactly as before, so the DigitalOcean deploy is unaffected. db name stays `swara`.
const uri = process.env.MONGO_URI || `mongodb+${login}@${webAddress}?${settings}`;

const runServer = async () => {
  try {
	const client = await MongoClient.connect(uri);    
	console.log('Connected to Database')
	const db = client.db('swara');
	const transcriptions = db.collection('transcriptions');
	const audioFiles = db.collection('audioFiles');
	const audioEvents = db.collection('audioEvents');
	const musicians = db.collection('musicians');
	const eventTypes = db.collection('audioEventTypes');
	const ragas = db.collection('ragas');
	const instruments = db.collection('instruments');
	const location = db.collection('location');
	const performanceSections = db.collection('performanceSections');
	const audioRecordings = db.collection('audioRecordings');
	const users = db.collection('users');
	const phonemes = db.collection('phonemes');
	const collections = db.collection('collections');
        const gharanas = db.collection('gharanas');

        // Authentication middleware for API routes
        app.use('/api', async (req, res, next) => {
          const authHeader = req.headers.authorization;
          if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Bearer token required' });
          }

          const token = authHeader.replace('Bearer ', '');
          try {
            const payload = await verifyGoogleToken(token);
            req.user = {
              id: payload.sub || '',
              email: payload.email || '',
              sub: payload.sub || ''
            };
            next();
          } catch (err) {
            return res.status(401).json({ error: 'Invalid or expired token' });
          }
        });

        const apiRouter = apiRoutes({ 
          transcriptions, 
          users, 
          audioEvents, 
          audioRecordings, 
          musicians, 
          ragas, 
          locations: location 
        });
        app.use('/api', apiRouter);
        
        // OAuth routes for Python client (no auth middleware)
        const oauthRouter = oauthRoutes({ users }, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
        app.use('/oauth', oauthRouter);

        // Web session auth (server-mediated OIDC + sid cookie): /auth/login,
        // /auth/callback, /session/me, /session/logout.
        const authRouter = authRoutes({ users, googleClientId: GOOGLE_CLIENT_ID, googleClientSecret: GOOGLE_CLIENT_SECRET });
        app.use('/', authRouter);
	  
	app.post('/insertNewTranscription', requireSession, requireCsrfHeader, async (req, res) => {
	  // creates new transcription entry in transcriptions collection
	  try {
		const insert = req.body;
		insert.userID = req.user!.uid; // owner is the authenticated user, not client-supplied
		insert['dateCreated'] = new Date(insert.dateCreated);
		insert['dateModified'] = new Date(insert.dateModified);
		
		const result = await transcriptions.insertOne(req.body)

		const userID = insert.userID;
		const query = { _id: new ObjectId(userID) };
		// const update = { transcriptions: $push(result.insertedId) };
		const update = { $push: { transcriptions: result.insertedId } };
		await users.updateOne(query, update);
		res.send(JSON.stringify(result));
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.post('/updateTranscription', requireSession, requireCsrfHeader, async (req, res) => {
	  // updates a transcription
	  const updateObj: { [key: string]: any } = {};
	  Object.keys(req.body).forEach(key => {
		// content only — ownership/sharing changes use their own owner-gated endpoints
		if (key !== '_id' && key !== 'userID' && key !== 'permissions' && key !== 'explicitPermissions') updateObj[key] = req.body[key]
	  });
	  updateObj['dateModified'] = new Date();
	  updateObj['dateCreated'] = new Date(updateObj['dateCreated'])
	  const query = { '_id': new ObjectId(req.body._id) };
	  const update = {
		'$set': updateObj,
		'$unset': {
		  'sectionStartsGrid': '',      // Remove legacy field - now using phrase.isSectionStart
		  'sectionStarts': '',           // Remove even older legacy field
		  'phrases': '',                 // Remove legacy duplicate of phraseGrid[0]
		  'sectionCategorization': '',   // Remove legacy duplicate of sectionCatGrid[0]
		  'durArray': '',                // Remove legacy duplicate of durArrayGrid[0]
		}
	  };
	  try {
		const target = await transcriptions.findOne(query);
		if (!target) { res.status(404).json({ error: 'not found' }); return; }
		if (!canEdit(target, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		const result = await transcriptions.updateOne(query, update);
		res.send(JSON.stringify({ ...result, dateModified: updateObj['dateModified'] }))
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.get('/getAllCollections', async (req, res) => {
	  try {
		const result = await collections.find().toArray();
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.get('/getAllMusicians', async (req, res) => {
	  try {
		const result = await musicians.find().toArray();
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.get('/getAllGharanas', async (req, res) => {
	  try {
		const result = await gharanas.find().toArray();
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.get('/getAllTranscriptions', async (req, res) => {
	  try {
		// Identity comes from the verified session cookie, never the query string, so it
		// cannot be spoofed to read another user's private transcriptions. When logged
		// out, the sentinel matches no document, so only the public clauses apply.
		const userID: string = req.user?.uid ?? NO_SESSION;
		const sortKey: string = JSON.parse(req.query.sortKey as string);
		let newPermissions = false;
		const reqNP = req.query.newPermissions;
		if (reqNP && reqNP !== 'undefined') {
		  newPermissions = JSON.parse(req.query.newPermissions as string);
		}
		let secondarySortKey = undefined;
		if (sortKey === 'family_name') secondarySortKey = 'given_name';
		const sortDir: string = JSON.parse(req.query.sortDir as string);
		const proj = {
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
		  soloInstrument: 1
		}
		let query;
		if (!newPermissions) {
		  query = {
			'$or': [
			  {
				'$or': [
				  { 'permissions': 'Public' },
				  { 'permissions': 'Publicly Editable' }
				]
			  },
			  { 'userID': userID },
			]
		  };
		} else {
		  query = {
			$or: [
			  { "explicitPermissions.publicView": true },
			  { "explicitPermissions.edit": userID },
			  { "explicitPermissions.view": userID },
			  { "userID": userID }
			]
		  };
		}
		const sort: { [key: string]: 1 | -1 } = {};
		sort[sortKey] = sortDir === '1' ? 1 : -1;
		if (secondarySortKey) sort[secondarySortKey] = sortDir === '1' ? 1 : -1;
		const result = await transcriptions
		  .find(query)
		  .collation({ 'locale': 'en' })
		  .sort(sort)
		  .project(proj)
		  .toArray();
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.get('/getAllTranscriptionsOfAudioFile', async (req, res) => {
	  const query = {
		audioID: req.query.audioID,
		$or: [
		  { userID: req.user?.uid ?? NO_SESSION },
		  { permissions: { $in: ['Public', 'Publicly Editable'] } }
		]
	  };
	  const projection = {
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
		explicitPermissions: 1
	  };
	  try {
		const result = await transcriptions.find(query)
		  .project(projection).toArray();
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.get('/nameFromUserID', async (req, res) => {
	  // retrieve a user's name from their associated userID in the users db
	  const query = {
		_id: new ObjectId(JSON.parse(req.query.userID as string))
	  };
	  try {
		const result = await users.findOne(query);
		if (result && result.name !== undefined) {
		  res.send(JSON.stringify(result.name));
		} else {
		  res.status(404).send('User not found');
		}
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.get('/allUsers', async (req, res) => {
	  try {
		const result = await users.find().toArray();
		res.send(JSON.stringify(result))
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.get('/getAllAudioRecordingMetadata', async (req, res) => {
	  // get all relevent data for audio files
	  const projection = {
		performers: 1,
		musicians: 1,
		raags: 1,
		_id: 1,
		duration: 1,
		fundamental: 1,
		fileNumber: 1,
		year: 1,
		saEstimate: 1,
		saVerified: 1,
		octOffset: 1,
		parentID: 1,
		parentTitle: 1,
		parentTrackNumber: 1,
		userID: 1,
		explicitPermissions: 1,
		title: 1
	  }
	  try {
		const out = await audioRecordings.find().project(projection).toArray();
		res.json(out)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.post('/saveMultiQuery', requireSession, requireCsrfHeader, async (req, res) => {
	  const userID = req.user!.uid;
	  if (!userID || userID.length !== 24) {
		console.log(userID)
		return res.status(400).send('Invalid userID: ' + userID);
	  }
	  const query = { _id: new ObjectId(userID) };
	  const multiQueryObj: { [key: string]: any } = {};
	  multiQueryObj['queries'] = req.body.queries;
	  multiQueryObj['dateCreated'] = new Date();
	  multiQueryObj['options'] = req.body.options;
	  multiQueryObj['transcriptionID'] = req.body.transcriptionID;
	  multiQueryObj['title'] = req.body.title;
	  const uniqueID = new ObjectId();
	  multiQueryObj['_id'] = uniqueID;
	  try {
		const result = await users.updateOne(query, { $push: { 
		  multiQueries: multiQueryObj 
		} });
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }

	});

	app.delete('/deleteQuery', requireSession, requireCsrfHeader, async (req, res) => {
	  const query = { _id: new ObjectId(req.user!.uid) };
	  const mQueryID = new ObjectId(req.body.queryID);

	  try {
		const result = await users.updateOne(query, {
		  $pull: { multiQueries: { _id: mQueryID } }
		});
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.post('/createCollection', requireSession, requireCsrfHeader, async (req, res) => {
	  // create a new collection
	  try {
		// get the user's name from their userID
		const query = { _id: new ObjectId(req.user!.uid) };
		const projection = { projection: { _id: 0, name: 1 } };
		const result = await users.findOne(query, projection);
		if (!result) {
		  return res.status(404).send('User not found');
		}
		const name = result.name;
		// create the collection
		const collection = req.body;
		collection['userID'] = req.user!.uid; // collection owner
		collection['dateCreated'] = new Date();
		collection['dateModified'] = new Date();
		collection['userName'] = name;
		const result2 = await collections.insertOne(collection);
		res.json(result2)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.delete('/deleteCollection', requireSession, requireCsrfHeader, async (req, res) => {
	  // delete a collection
	  try {
		const query = { _id: new ObjectId(req.body._id) };
		const coll = await collections.findOne(query);
		if (!coll) { res.status(404).json({ error: 'not found' }); return; }
		if (!isOwner(coll, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		const result = await collections.deleteOne(query);
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.post('/updateCollection', requireSession, requireCsrfHeader, async (req, res) => {
	  // update a collection
	  try {
		const query = { _id: new ObjectId(req.body._id) };
		const coll = await collections.findOne(query);
		if (!coll) { res.status(404).json({ error: 'not found' }); return; }
		if (!canEdit(coll, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		// copy to updates, and remove _id + owner (owner reassignment isn't allowed here)
		const updates = req.body;
		delete updates._id;
		delete updates.userID;
		const update = { $set: updates };
		const result = await collections.updateOne(query, update);
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.get('/getAllAudioEventMetadata', async (req, res) => {
	  // retreive metadata for all audio events
	  try {
		const result = await audioEvents.find().sort({
		  'name': 1
		}).toArray();
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.post('/getOneTranscription', async (req, res) => {
	  // retreive a particular transcription. If _id is 0, return first one.
	  if (req.body._id === 0) {
		try {
		  const result = await transcriptions.find().sort({ "_id": 1 }).next();
		  if (result && !canView(result, req.user?.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		  res.json(result)
		} catch (err) {
		  console.error(err);
		  res.status(500).send(err);
		}
	  } else {
		try {
		  const query = { '_id': new ObjectId(req.body._id) };
		  const result = await transcriptions.findOne(query);
		  if (result && !canView(result, req.user?.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		  res.send(JSON.stringify(result))
		} catch (err) {
		  console.error(err);
		  res.status(500).send(err);
		}  
	  }
	});
	
	app.get('/pieceExists', async (req, res) => { 
	  try {
		const query = { _id: new ObjectId(req.query._id as string) };
		const result = await transcriptions.countDocuments(query) > 0;
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err)
	  }
	});

	app.delete('/oneTranscription', requireSession, requireCsrfHeader, async (req, res) => {
	  // delete a particular transcription
	  try {
		const query = { "_id": new ObjectId(req.body._id) };
		const target = await transcriptions.findOne(query);
		if (!target) { res.status(404).json({ error: 'not found' }); return; }
		if (!isOwner(target, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		const result = await transcriptions.deleteOne(query);

		// also, remove from user's transcriptions array (the owner, from the session)
		const userID = req.user!.uid;
		const query2 = { _id: new ObjectId(userID) };
		const tID = new ObjectId(req.body._id);
		const result2 = await users.updateOne(query2, { $pull: { 
		  transcriptions: { $in: [tID] } 
		} });
		console.log(userID)
		console.log(query2)
		console.log(result2)
		res.json(result);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }    
	});

	app.delete('/deleteRecording', requireSession, requireCsrfHeader, async (req, res) => {
	  // delete a particular recording
	  try {
		const query1 = { "_id": new ObjectId(req.body._id) };
		const found1 = await audioRecordings.findOne(query1);
		if (!found1) {
		  return res.status(404).send('Recording not found');
		}
		if (!isOwner(found1, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		const parentID = found1.parentID;
		const result1 = await audioRecordings.deleteOne(query1);
		// also delete recording from audioevent, if rec has associated audio
		// event
		// if parentID is not null
		if (parentID) {

		  const query2 = { "_id": new ObjectId(parentID) };
		  const projection = { 'recordings': 1, '_id': 0 };
		  const result2 = await audioEvents.findOne(query2, { projection });
		  if (!result2) {
			return res.status(404).send('Audio event not found');
		  }
		  const recordings = result2.recordings;
		  const newRecordings: { [key: number]: any } = {};
		  let count = 0;
		  for (let idx in recordings) {
			if (recordings[idx].audioFileId.toString() !== req.body._id) {
			  newRecordings[count] = recordings[idx];
			  if (newRecordings[count].parentTrackNumber !== count) {
				newRecordings[count].parentTrackNumber = count;
				// update in audioRecordings collection
				const query = { 
				  '_id': new ObjectId(newRecordings[count].audioFileId) 
				};
				const update = { $set: { 'parentTrackNumber': count } };
				await audioRecordings.updateOne(query, update);
			  }
			  count++;
			}
		  }
		  
		  result2.recordings = newRecordings;
		  const result3 = await audioEvents.updateOne(query2, { 
			$set: {recordings: newRecordings}
		  });
		  // if no recs left, delete audio event
		  let result4 = undefined;
		  if (Object.keys(newRecordings).length === 0) {
			result4 = await audioEvents.deleteOne(query2);
		  }
		  if (result4 !== undefined) {
			res.json({ result1, result2, result3, result4 });
		  } else {
			res.json({ result1, result2, result3 });
		  }
		} else {
		  res.json(result1);
		}

		const peaksPath = mediaPath('peaks', req.body._id + '.json');
		const spectrogramsPath = mediaPath('spectrograms', req.body._id);
		const mp3Path = mediaPath('audio', 'mp3', req.body._id + '.mp3');
		const wavPath = mediaPath('audio', 'wav', req.body._id + '.wav');
		const opusPath = mediaPath('audio', 'opus', req.body._id + '.opus');
		fs.rm(mediaPath('melographs', req.body._id), { recursive: true, force: true })
		fs.rm(mediaPath('spec_data', req.body._id), { recursive: true, force: true })
		const peaksPathExists = await exists(peaksPath);
		const spectrogramsPathExists = await exists(spectrogramsPath);
		const mp3PathExists = await exists(mp3Path);
		const wavPathExists = await exists(wavPath);
		const opusPathExists = await exists(opusPath);
		if (peaksPathExists) {
		  fs.unlink(peaksPath)
		}
		if (spectrogramsPathExists) {
		  fs.rm(spectrogramsPath, { recursive: true, force: true })
		}
		if (mp3PathExists) {
		  fs.unlink(mp3Path)
		}
		if (wavPathExists) {
		  fs.unlink(wavPath)
		}
		if (opusPathExists) {
		  fs.unlink(opusPath)
		}
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }    
	});

	app.delete('/deleteAudioEvent', requireSession, requireCsrfHeader, async (req, res) => {
	  // delete a particular audio event
	  try {
		const query = { "_id": new ObjectId(req.body._id) };
		const projection = { 'recordings': 1, '_id': 0, 'userID': 1, 'explicitPermissions': 1, 'permissions': 1 };
		const result = await audioEvents.findOne(query, { projection });
		if (!result) {
		  return res.status(404).send('Audio event not found');
		}
		if (!isOwner(result, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		const recordings = result.recordings;
		const idxs = Object.keys(recordings);
		idxs.forEach(async idx => {
		  const recID = recordings[idx].audioFileId?.toString();
		  //  remove from audioRecordings collection
		  const query = { '_id': new ObjectId(recID) };
		  const result = await audioRecordings.deleteOne(query);
		  console.log(result)
		  // remove from peaks folder
		  const peaksPath = mediaPath('peaks', recID + '.json');
		  const spectrogramsPath = mediaPath('spectrograms', recID);
		  const mp3Path = mediaPath('audio', 'mp3', recID + '.mp3');
		  const wavPath = mediaPath('audio', 'wav', recID + '.wav');
		  const opusPath = mediaPath('audio', 'opus', recID + '.opus');
		  const peaksPathExists = await exists(peaksPath);
		  const spectrogramsPathExists = await exists(spectrogramsPath);
		  const mp3PathExists = await exists(mp3Path);
		  const wavPathExists = await exists(wavPath);
		  const opusPathExists = await exists(opusPath);
		  if (peaksPathExists) {
			fs.unlink(peaksPath)
		  }
		  if (spectrogramsPathExists) {
			fs.rm(spectrogramsPath, { recursive: true, force: true })
		  }
		  if (mp3PathExists) {
			fs.unlink(mp3Path)
		  }
		  if (wavPathExists) {
			fs.unlink(wavPath)
		  }
		  if (opusPathExists) {
			fs.unlink(opusPath)
		  }
		  fs.rm(mediaPath('melographs', recID), { recursive: true, force: true })
		  fs.rm(mediaPath('spec_data', recID), { recursive: true, force: true })
		})
		const delResult = await audioEvents.deleteOne(query);
		console.log(delResult)
		res.json(delResult);
		// res.json('not deleted _id ' + req.body._id);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/getAudioDBEntry', async (req, res) => {
	  // retrieve a particular entry from the audioFiles db
	  try {
		const query = { '_id': new ObjectId(req.body._id) };
		const result = await audioFiles.findOne(query);
		res.json(result);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }    
	});

	app.get('/getSortedMusicians', async (req, res) => {
	  //Get all names of all musicians from db, sorted
	  const sorts: { [key: string]: 1 | -1 } = { 
		'Last Name': 1, 
		'First Name': 1, 
		'Middle Name': 1 
		};
	  const proj: { [key: string]: number } = { 'Initial Name': 1, _id: 0 };
	  if (req.query.verbose === 'true') {
		proj['First Name'] = 1;
		proj['Last Name'] = 1;
		proj['Middle Name'] = 1;
	  }
	  try {
		let result = await musicians.find().sort(sorts).project(proj).toArray();
		const output = req.query.verbose === 'true' ? 
		  result : 
		  result.map(r => r['Initial Name']);
		res.json(output)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.get('/getGharana', async (req, res) => {
	  //gets gharana of a particular musician
	  const initName = JSON.parse(req.query.initName as string);
	  const query = { 'Initial Name': initName };
	  const projection = { projection: { Gharana: 1, _id: 0 } };
	  try {
		const result = musicians.findOne(query, projection);
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }    
	});

	app.get('/getInstruments', async (req, res) => {
	  // get names of all instruments, or instruments  of particular kind (if 
	  // melody is true)
	  const proj = { name: 1, _id: 0 };
	  if (req.query.melody) {
		const query = { 'kind': 'melody' };
		try {
		  const result = await instruments.find(query).project(proj).toArray();
		  res.json(result.map(r => r.name))
		} catch (err) {
		  console.error(err);
		  res.status(500).send(err);
		}        
	  } else {
		try {
		  const result = await instruments.find().project(proj).toArray();
		  res.json(result.map(r => r.name))
		} catch (err) {
		  console.error(err);
		  res.status(500).send(err);
		}
	  }
	});

	app.get('/verifySpectrogram', async (req, res) => {
	  // verify that spectrogram exists for a particular recording
	  const dir = mediaPath('spectrograms', String(req.query.id), '0');
	  try {
		const files = await fs.readdir(dir);
		res.json(files.length > 0)
	  } catch (err) {
		if (typeof err === 'object' && err !== null && 'code' in err && (err as any).code === 'ENOENT') {
		  res.json(false)
		} else {
		  console.error(err);
		  res.status(500).send(err);
		}
		
	  }
	});

	app.get('/verifyMelograph', async (req, res) => {
	  // verify that melograph exists for a particular recording
	  const dir = mediaPath('melographs', String(req.query.id));
	  try {
		const files = await fs.readdir(dir);
		res.json(files.length > 0)
	  } catch (err) {
		if (typeof err === 'object' && err !== null && 'code' in err && (err as any).code === 'ENOENT') {
		  res.json(false)
		} else {
		  console.error(err);
		  res.status(500).send(err);
		}
	  }
	});

	app.get('/getRagaNames', async (req, res) => {
	  // gets names of all ragas
	  const proj = { 'name': 1, _id: 0 };
	  const sortRule: { [key: string]: 1 | -1 } = { 'name': 1 };
	  try {
		let result = await ragas.find().sort(sortRule).project(proj).toArray();
		const names = await result.map(r => r.name);
		res.json(names)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }    
	});

	app.get('/getLocationObject', async (req, res) => {
	  // gets location object
	  try {
		const result = await location.findOne({}, { projection: { _id: 0 } });
		res.json(result);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.get('/getEventTypes', async (req, res) => {
	  // retrieve list of all possible event types
	  const projection = { 'type': 1, _id: 0 };
	  try {
		const result = await eventTypes.find().project(projection).toArray();
		res.json(result.map(r => r.type))
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }    
	});

	app.get('/getPerformanceSections', async (req, res) => {
	  // retrieve list of all possible performance sections
	  const proj = { 'name': 1, _id: 0 };
	  try {
		const result = await performanceSections.find().project(proj).toArray();
		res.json(result.map(r => r.name));
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.get('/getNumberOfSpectrograms', async (req, res) => {
	  // returns the number of spectrograms that the app needs to load
	  const dir = mediaPath('spectrograms', String(req.query.id), '0');
	  try {  
		const files = await fs.readdir(dir);
		res.json(files.length)  
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.post('/updateVisibility', requireSession, requireCsrfHeader, async (req, res) => {
	  // update the visibility of either a transcription, recording, or 
	  // audioEvent
	  if (req.body.artifactType === 'transcription') {
		try {
		  const query = { _id: new ObjectId(req.body._id) };
		  const update = { $set: { 
			"explicitPermissions": req.body.explicitPermissions 
		  } };
		  const t = await transcriptions.findOne(query);
		  if (!t) { res.status(404).json({ error: 'not found' }); return; }
		  if (!isOwner(t, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		  const result = await transcriptions.updateOne(query, update);
		  res.json(result)
		} catch (err) {
		  console.error(err);
		  res.status(500).send(err);
		}
	  } else if (req.body.artifactType === 'audioRecording') {
		try {
		  const q = { _id: new ObjectId(req.body._id) };
		  const up = { $set: { 
			"explicitPermissions": req.body.explicitPermissions 
		  } };
		  const options = { returnDocument: 'after' as const };
		  const recOwner = await audioRecordings.findOne(q);
		  if (!recOwner) { res.status(404).json({ error: 'not found' }); return; }
		  if (!isOwner(recOwner, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		  const result = await audioRecordings.findOneAndUpdate(q, up, options);
      if (!result.value) {
        return res.status(404).send('Recording not found');
      }
		  const parentID = result.value.parentID;
		  const key = result.value.parentTrackNumber;
		  const query2 = { _id: new ObjectId(parentID) };
		  const path = `recordings.${key}.explicitPermissions`;
		  const update2 = { $set: { [path]: req.body.explicitPermissions } };
		  const result2 = await audioEvents.updateOne(query2, update2);
		  res.json({ result, result2 })
		} catch (err) {
		  console.error(err);
		  res.status(500).send(err);
		}
	  } else if (req.body.artifactType === 'audioEvent') {
		console.log(req.body)
		try {
		  const query = { _id: new ObjectId(req.body._id) };
		  const update = { $set: { 
			"explicitPermissions": req.body.explicitPermissions 
		  } };
		  const aeOwner = await audioEvents.findOne(query);
		  if (!aeOwner) { res.status(404).json({ error: 'not found' }); return; }
		  if (!isOwner(aeOwner, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		  const result = await audioEvents.findOneAndUpdate(query, update);
		  const audioEvent = result.value;
      if (!audioEvent) {
        return res.status(404).send('Audio event not found');
      }
		  for (let recording of Object.values(audioEvent.recordings)) {
		const rec = recording as { audioFileId: string };
		const query = { _id: new ObjectId(rec.audioFileId) };
		const update = { $set: { 
		  "explicitPermissions": req.body.explicitPermissions 
		} 
	  };
			await audioRecordings.findOneAndUpdate(query, update);
		  }
		  res.json(result)
		} catch (err) {
		  console.error(err);
		  res.status(500).send(err);
		}
	  }

	});
	
	app.post('/makeSpectrograms', requireSession, requireCsrfHeader, async (req, res) => {
	  // generate spectrograms for the given recording ID and tonic estimate
	  const makingSpecs = spawn(
		PYTHON_PATH,
		['generate_log_spectrograms.py', req.body.recId, req.body.saEst],
		{ env: pythonEnv() }
	  );
	  try {
		makingSpecs.stdout.on('data', data => {
		  console.log(`stdout: ${data}`)
		});
		
		makingSpecs.stderr.on('data', data => {
		  console.error(`stderr: ${data}`)
		});
		await makingSpecs.on('close', (msg) => {
		  console.log(msg)
		  res.json('made the spectrograms')
		})
	  } catch (err) {
		console.error(err)
	  }
	})

	app.post('/makeMelograph', requireSession, requireCsrfHeader, async (req, res) => {
	  res.setTimeout(10 * 60 * 1000); // 10 minutes
	  const makingMelograph = spawn(
		PYTHON_PATH,
		['generate_melograph.py', req.body.recId, req.body.saEst],
		{ env: pythonEnv() }
	  );
	  try {
		makingMelograph.stdout.on('data', data => {
		  console.log(`stdout: ${data}`)
		});
		
		makingMelograph.stderr.on('data', data => {
		  console.error(`stderr: ${data}`)
		});
		await new Promise((resolve, reject) => {
		  makingMelograph.on('close', (msg) => {
			console.log(msg);
			resolve(undefined);
		  });
	
		  makingMelograph.on('error', (err) => {
			console.error(err);
			reject(err);
		  });
		});
		res.json('made the melograph')
	  } catch (err) {
		console.error(err)
	  }
	})

	app.get('/getAudioEvent', async (req, res) => {
	  try {
		const result = await audioEvents.findOne({
		  _id: new ObjectId(req.query._id as string)
		});
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.get('/getAudioRecording', async (req, res) => {
	  try {
		const result = await audioRecordings.findOne({
		  _id: new ObjectId(req.query._id as string)
		});
		if (!result) { res.status(404).json({ error: 'not found' }); return; }
		if (!canView(result, req.user?.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/initializeAudioEvent', requireSession, requireCsrfHeader, async (req, res) => {
	  // Creates a new (empty) AudioEvent mongDB entry, and receives back a 
	  // unique _id for use throughout the upload / metadata entry process.
	  const userID = req.user!.uid;
	  const insertion: {
      userID: string; 
      permissions: string; 
      explicitPermissions: { publicView: boolean; edit: string[]; view: string[] }; 
      name?: string; 
      'event type'?: string; 
    } = {
      userID: userID,
      permissions: "Public",
      explicitPermissions: {
        publicView: true,
        edit: [],
        view: []
      },
	  };
	  if (req.body.name) insertion.name = req.body.name;
	  if (req.body.eventType) insertion['event type'] = req.body.eventType;
	  try {
		const result = await audioEvents.insertOne(insertion);
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.delete('/cleanEmptyDoc', requireSession, requireCsrfHeader, async (req, res) => {
	  const query = { _id: new ObjectId(req.body._id) };
	  const projection = { projection: { _id: 0 } };
	  try {
		const result = await audioEvents.findOne(query, projection)
    if (!result) {
      return res.status(404).send('Audio event not found');
    }
		if (Object.keys(result).length <= 2) {
		  const output = await audioEvents.deleteOne(query);
		  res.json(output)
		}
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }    
	})

	app.post('/saveAudioMetadata', requireSession, requireCsrfHeader, async (req, res) => {
	  const parentId = new ObjectId(req.body._id);
	  const myUpdates = req.body.updates;
	  const addMusicians = req.body.addMusicians;
	  const query = { _id: parentId };
	  const existingAE = await audioEvents.findOne(query);
	  if (existingAE && !canEdit(existingAE, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
	  const update = { $set: myUpdates };
	  const options = { upsert: true };
	  console.log(addMusicians)
	  try {
		if (addMusicians.length > 0) {
		  const [result1, result2] = await Promise.all([
			audioEvents.updateOne(query, update, options),
			musicians.insertMany(addMusicians)
		  ])
		  res.json({ result1, result2 });
		} else {
		  const result = await audioEvents.updateOne(query, update, options);
		  res.json(result);
		}
		aggregations.generateAudioRecordingsDB();
		
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/addMusicianToDB', requireSession, requireCsrfHeader, async (req, res) => {
	  //adding new entry to musicians db
	  const entry = { 
		'Initial Name': req.body.initName,
		'Gharana': req.body.gharana,
		'Full Name': req.body.fullName,
		'Instrument': req.body.instrument
	  };
	  try {
		const result = await musicians.insertOne(entry);
		res.json(result);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/addGharanaToDB', requireSession, requireCsrfHeader, async (req, res) => {
	  //adding new entry to gharanas db
	  const entry = { 'name': req.body.name, 'members': req.body.members };
	  try {
		const result = await gharanas.insertOne(entry);
		res.json(result);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/addCountryToDB', requireSession, requireCsrfHeader, async (req, res) => {
	  const country = req.body.country;
	  const continent = req.body.continent;
	  const update = { $set: { [`${continent}.${country}`]: [] } };
	  const query = {};
	  try {
		const result = await location.updateOne(query, update);
		res.json(result);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  } 
	})

	app.post('/addCityToDB', requireSession, requireCsrfHeader, async (req, res) => {
	  const continent = req.body.continent;
	  const country = req.body.country;
	  const city = req.body.city;
	  const update = { $push: { [`${continent}.${country}`]: city } };
	  const query = {};
	  try {
		const result = await location.updateOne(query, update);
		res.json(result);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/addRaagToDB', requireSession, requireCsrfHeader, async (req, res) => {
	  const d = new Date();
	  const entry = { 'name': req.body.raag, 'updatedDate': d.toISOString() };
	  try {
		const result = await ragas.insertOne(entry);
		res.json(result);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/updateSaEstimate', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const verString = `recordings.${req.body.recIdx}.saVerified`;
		const estString = `recordings.${req.body.recIdx}.saEstimate`;
		const octString = `recordings.${req.body.recIdx}.octOffset`;
		const query = { _id: new ObjectId(req.body.aeID) };
		const ae = await audioEvents.findOne(query);
		if (!ae) { res.status(404).json({ error: 'not found' }); return; }
		if (!canEdit(ae, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		const update: { $set: { [key: string]: any } } = { $set: {} };
		update.$set[verString] = req.body.verified;
		update.$set[estString] = req.body.saEstimate;
		update.$set[octString] = req.body.octOffset;
		await audioEvents.updateOne(query, update);
		const otherQuery = { _id: new ObjectId(req.body.recID) };
		const saEst = req.body.saEstimate;
		const ver = req.body.verified;
		const oct = req.body.octOffset;
		const setting = { saEstimate: saEst, saVerified: ver, octOffset: oct };
		const otherUpdate = { $set: setting };
		const oRes = await audioRecordings.updateOne(otherQuery, otherUpdate);
		res.json(oRes)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err)
	  }
	})

	app.post('/updateAudioRecording', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const query = { _id: new ObjectId(req.body._id) };
		const rec = await audioRecordings.findOne(query);
		if (!rec) { res.status(404).json({ error: 'not found' }); return; }
		if (!canEdit(rec, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		const isoDateString = new Date().toISOString();
		const update = { $set: {
		  ...req.body.updates,
		  dateModified: isoDateString
		 } };
		const result = await audioRecordings.updateOne(query, update);
		if (req.body.ae_id !== undefined) {
		  const aeUpdate: { [key: string]: any } = {};
		  Object.keys(req.body.updates).forEach(key => {
			aeUpdate[key] = JSON.parse(JSON.stringify(req.body.updates[key]));
		  })
		  aeUpdate['audioFileId'] = new ObjectId(req.body._id);
		  delete aeUpdate['_id'];

		  const aeQuery = { _id: new ObjectId(req.body.ae_id) };
		  const aeUpdateKeys = Object.keys(aeUpdate);
		  const aeUpdateFull: { $set: { [key: string]: any } } = { $set: {} };
		  aeUpdateKeys.forEach(key => {
			const path = `recordings.${req.body.parentTrackNum}.${key}`;
			aeUpdateFull.$set[path] = aeUpdate[key];
		  });
		  aeUpdateFull.$set['dateModified'] = isoDateString;
		  await audioEvents.updateOne(aeQuery, aeUpdateFull);
		}
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err)
	  }
	})

	app.post('/updateTranscriptionTitle', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const query = { _id: new ObjectId(req.body.id) };
		const target = await transcriptions.findOne(query);
		if (!target) { res.status(404).json({ error: 'not found' }); return; }
		if (!canEdit(target, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		const update = { $set: { title: req.body.title} };
		const result = await transcriptions.updateOne(query, update);
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err)
	  }
	})

	app.post('/updateTranscriptionPermissions', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const query = { _id: new ObjectId(req.body.id) };
		const target = await transcriptions.findOne(query);
		if (!target) { res.status(404).json({ error: 'not found' }); return; }
		if (!isOwner(target, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		const update = { $set: { permissions: req.body.permissions} };
		const result = await transcriptions.updateOne(query, update);
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/updateTranscriptionOwner', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const query = { _id: new ObjectId(req.body.transcriptionID) };
		const target = await transcriptions.findOne(query);
		if (!target) { res.status(404).json({ error: 'not found' }); return; }
		if (!isOwner(target, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		const update = { $set: {
		  userID: req.body.userID,
		  name: req.body.name,
		  family_name: req.body.family_name,
		  given_name: req.body.given_name
		} };
		const result = await transcriptions.updateOne(query, update);
		// remove from old user's transcriptions array
		const query2 = { _id: new ObjectId(req.body.originalOwnerID) };
		const tID = new ObjectId(req.body.transcriptionID);
		await users.updateOne(query2, { $pull: {
		  transcriptions: { $in: [tID] }
		} });
		// add to new user's transcriptions array
		const query3 = { _id: new ObjectId(req.body.userID) };
		await users.updateOne(query3, { $push: {
		  transcriptions: tID
		} });
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.get('/loadQueries', async (req, res) => {
	  try {
		if (!req.user?.uid) { res.json([]); return; }
		const userID = req.user.uid;
		const transcriptionID = req.query.transcriptionID;
		const query = { _id: new ObjectId(userID as string) };
		const projection = { projection: { multiQueries: 1, _id: 0 } };
		let user = await users.findOne(query, projection);
    if (!user) {
      return res.status(404).send('User not found');
    }
		let multiQueries: { transcriptionID: string }[] = user.multiQueries;
		multiQueries = multiQueries.filter(q => {
		  return q.transcriptionID === transcriptionID
		});
		res.json(multiQueries)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.get('/getVerifiedStatus', async (req, res) => {
	  try {
		const query = { _id: new ObjectId(req.query.aeID as string) };
		const verString = `$recordings.${req.query.recIdx}.saVerified`;
		const estString = `$recordings.${req.query.recIdx}.saEstimate`;
		const octOffset = `$recordings.${req.query.recIdx}.octOffset`;
		const projection: { [key: string]: any } = { '_id': 0 };
		projection['saEstimate'] = estString;
		projection['saVerified'] = verString;
		projection['octOffset'] = octOffset;
		const options = { projection: projection };
		const result = await audioEvents.findOne(query, options);
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.get('/getRaagRule', async (req, res) => {
	  try {
		const query = { name: req.query.name };
		const projection = { _id: 0, rules: 1, updatedDate: 1 };
		const options = { projection: projection };
		const result = await ragas.findOne(query, options);
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err)
	  }
	})

	app.get('/getIpaVowels', async (req, res) => {
	  try {
		const query = { type: 'vowel' };
		const projection = { _id: 0 };
		const options = { projection: projection };
		const result = await phonemes.find(query, options).toArray();
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err)
	  }
	})
	
	app.post('/addRecordingToCollection', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		// add recordingID to collections collection
		const query = { _id: new ObjectId(req.body.colID) };
		const coll = await collections.findOne(query);
		if (!coll) { res.status(404).json({ error: 'not found' }); return; }
		if (!canEdit(coll, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }

		const update = { $push: { audioRecordings: req.body.recordingID } };
		const result = await collections.updateOne(query, update);
		// add colID to audioRecordings collection
		const query2 = { _id: new ObjectId(req.body.recordingID) };
		const update2 = { $push: { collections: req.body.colID } };
		const result2 = await audioRecordings.updateOne(query2, update2);
		res.json({ result, result2 })
	  } catch (err) {
		console.error(err);
		res.status(500).send(err)
	  }
	})

	app.post('/addTranscriptionToCollection', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		// add recordingID to collections collection
		const query = { _id: new ObjectId(req.body.colID) };
		const coll = await collections.findOne(query);
		if (!coll) { res.status(404).json({ error: 'not found' }); return; }
		if (!canEdit(coll, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		const update = { $push: { transcriptions: req.body.transcriptionID } };
		const result = await collections.updateOne(query, update);
		// add colID to audioRecordings collection
		const query2 = { _id: new ObjectId(req.body.transcriptionID) };
		const update2 = { $push: { collections: req.body.colID } };
		const result2 = await transcriptions.updateOne(query2, update2);
		res.json({ result, result2 })
	  } catch (err) {
		console.error(err);
		res.status(500).send(err)
	  }
	})

	app.post('/addAudioEventToCollection', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		// add recordingID to collections collection
		const query = { _id: new ObjectId(req.body.colID) };
		const coll = await collections.findOne(query);
		if (!coll) { res.status(404).json({ error: 'not found' }); return; }
		if (!canEdit(coll, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		const update = { $push: { audioEvents: req.body.audioEventID } };
		const result = await collections.updateOne(query, update);
		// add colID to audioRecordings collection
		const query2 = { _id: new ObjectId(req.body.audioEventID) };
		const update2 = { $push: { collections: req.body.colID } };
		const result2 = await audioEvents.updateOne(query2, update2);
		res.json({ result, result2 })
	  } catch (err) {
		console.error(err);
		res.status(500).send(err)
	  }
	})

	app.post('/removeRecordingFromCollection', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
      // remove recordingID from collections collection
      const query = { _id: new ObjectId(req.body.colID) };
      const coll = await collections.findOne(query);
      if (!coll) { res.status(404).json({ error: 'not found' }); return; }
      if (!canEdit(coll, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
      const update = { $pull: { audioRecordings: req.body.recordingID } };
      const result = await collections.updateOne(query, update);
      // remove colID from audioRecordings collection
      const query2 = { _id: new ObjectId(req.body.recordingID) };
      const update2 = { $pull: { collections: req.body.colID } };
      const result2 = await audioRecordings.updateOne(query2, update2);
      res.json({ result, result2 })
	  } catch (err) {
      console.error(err);
      res.status(500).send(err)
	  }
	})

	app.post('/removeTranscriptionFromCollection', requireSession, requireCsrfHeader, async (req, res) => {
	  try { 
      const query = { _id: new ObjectId(req.body.colID) };
      const coll = await collections.findOne(query);
      if (!coll) { res.status(404).json({ error: 'not found' }); return; }
      if (!canEdit(coll, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
      const update = { $pull: { transcriptions: req.body.transcriptionID } };
      const result = await collections.updateOne(query, update);

      const query2 = { _id: new ObjectId(req.body.transcriptionID) };
      const update2 = { $pull: { collections: req.body.colID } };
      const result2 = await transcriptions.updateOne(query2, update2);
      console.log(result, result2)
      res.json({ result, result2 })
	  } catch (err) {
      console.error(err);
      res.status(500).send(err)
	  }
	})

	app.post('/removeAudioEventFromCollection', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
      const query = { _id: new ObjectId(req.body.colID) };
      const coll = await collections.findOne(query);
      if (!coll) { res.status(404).json({ error: 'not found' }); return; }
      if (!canEdit(coll, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
      const update = { $pull: { audioEvents: req.body.audioEventID } };
      const result = await collections.updateOne(query, update);

      const query2 = { _id: new ObjectId(req.body.audioEventID) };
      const update2 = { $pull: { collections: req.body.colID } };
      const result2 = await audioEvents.updateOne(query2, update2);
      res.json({ result, result2 })
	  } catch (err) {
      console.error(err);
      res.status(500).send(err)
	  }
	})

	app.post('/getRecsFromIds', async (req, res) => {
	  try {
      const reqIds: string[] = req.body.reqIds
      const query = { _id: { $in: reqIds.map(id => new ObjectId(id)) } };
      const result = await audioRecordings.find(query).toArray();
      // post-filter (not a query clause) so legacy string `permissions` docs
      // are honored too — canView handles both permission shapes
      res.json(result.filter(rec => canView(rec, req.user?.uid)))
	  } catch (err) {
      console.error(err);
      res.status(500).send(err)
	  }
	})

	app.get('/getLooseRecordings', async (req, res) => {
	  try {
		const query = { parentID: null };
		const result = await audioRecordings.find(query).toArray();
		res.json(result)
	  } catch (err) {
      console.error(err);
      res.status(500).send(err)
	  }
	})

	app.post('/getAEsFromIds', async (req, res) => {
	  try {
      const aeIDs: string[] = req.body.aeIDs
      const query = { _id: { $in: aeIDs.map(id => new ObjectId(id)) } };
      const result = await audioEvents.find(query).toArray();
      // audioEvents created via /api/uploadAudio historically carry only a
      // `visibility` string instead of explicitPermissions — honor it too.
      res.json(result.filter(ae => canView(ae, req.user?.uid) || ae.visibility === 'public'))
	  } catch (err) {
      console.error(err);
      res.status(500).send(err)
	  }
	})

	app.post('/getTranscriptionsFromIds', async (req, res) => {
	  try {
      const transIDs: string[] = req.body.transIDs;
        const query = { 
          _id: { $in: transIDs.map(id => new ObjectId(id)) },
          $or: [
          { "explicitPermissions.view": req.user?.uid ?? NO_SESSION },
          { "explicitPermissions.publicView": true },
          { "userID": req.user?.uid ?? NO_SESSION },
          { "explicitPermissions.edit": req.user?.uid ?? NO_SESSION }
          ] 
        };
        const proj = {
        title: 1,
        dateCreated: 1,
        dateModified: 1,
        location: 1,
        transcriber: 1,
        _id: 1,
        performers: 1,
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
        soloist: 1
      }
      const result = await transcriptions.find(query).project(proj).toArray();
      res.json(result)
	  } catch (err) {
      console.error(err);
      res.status(500).send(err)
	  }
	})

	app.get('/getConsonants', async (req, res) => {
	  try {
      const query = { type: 'consonant' };
      const projection = { _id: 0 };
      const options = { projection: projection };
      const result = await phonemes.find(query, options).toArray();
      res.json(result)
	  } catch (err) {
      console.error(err);
      res.status(500).send(err)
	  }
	})

	app.post('/saveRaagRules', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
      const query = { name: req.body.name };
      const update = {
        $set: { rules: req.body.rules, updatedDate: req.body.date }
      };
      const options = { upsert: true };
      const result = await ragas.updateOne(query, update, options);
      res.json(result.acknowledged)
	  } catch (err) {
      console.error(err);
      res.status(500).send(err);
	  }
	})

	app.post('/userLoginGoogle', async (req, res) => {
	  try {
		const query = { sub: req.body.sub };
		const update = { $set: req.body };
		const options = { upsert: true, returnDocument: 'after' as const };
		const result = await users.findOneAndUpdate(query, update, options);
		res.json(result);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/agreeToWaiver', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const query = { _id: new ObjectId(req.user!.uid) };
		const update = { $set: { waiverAgreed: true } };
		const options = { upsert: true };
		const result = await users.updateOne(query, update, options);
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	// New PKCE-aware endpoint for Python API clients
app.post('/handleGoogleAuthCodePythonAPI', async (req, res) => {
  try {
    // Normalize the incoming redirect URL just like your other handler
    let url = req.body.redirectURL;
    if (url !== 'http://localhost:8080/') {
      if (url.endsWith('/')) {
        url = url.slice(0, -1);
      }
      if (url.endsWith('logIn')) {
        url = url.slice(0, -6);
      }
    }

    // Grab the PKCE verifier sent from the Python side
    const codeVerifier = req.body.codeVerifier;

    // Construct a fresh OAuth2 client
    const OAuthClient = new OAuth2Client({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri: url,
    });

    // Exchange the auth code plus PKCE verifier for tokens
    const { tokens } = await (OAuthClient.getToken as any)({
      code: req.body.authCode,
      codeVerifier,
      redirectUri: url,
    });

    // Set credentials & fetch the user profile
    OAuthClient.setCredentials(tokens);
    const userinfo = await OAuthClient.request({
      url: 'https://www.googleapis.com/oauth2/v3/userinfo'
    });

    // Return both tokens and profile to the caller
    res.json({ tokens, profile: userinfo.data });
  } catch (err) {
    console.error(err);
    res.status(500).send(err);
  }
});

	app.post('/handleGoogleAuthCode', async (req, res) => {
	  try {
		let url = req.body.redirectURL;
		if (url !== 'http://localhost:8080/') {
			if (url[url.length-1] === '/') {
		  		url = url.slice(0, url.length-1);
			}
			if (url.slice(url.length-5, url.length) === 'logIn')[
				url = url.slice(0, url.length-6)
			]
		}
		
		console.log(url)
		const OAuthClient = new OAuth2Client({
		  clientId: GOOGLE_CLIENT_ID,
		  clientSecret: GOOGLE_CLIENT_SECRET,
		  redirectUri: url
		});
		let { tokens } = await OAuthClient.getToken(req.body.authCode);
		OAuthClient.setCredentials({ access_token: tokens.access_token });
		const userinfo = await OAuthClient.request({
		  url: 'https://www.googleapis.com/oauth2/v3/userinfo'
		})
		res.json(userinfo.data)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/cloneTranscription', requireSession, requireCsrfHeader, async (req, res) => {
	  try {

		const query = { _id: new ObjectId(req.body.id) };
		const copy = await transcriptions.findOne(query);
    if (!copy) {
      return res.status(404).send('Transcription not found');
    }
		if (!canView(copy, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		copy._id = new ObjectId();
		copy.title = req.body.title;
		copy.userID = req.user!.uid; // the cloner owns the new copy
		copy.permissions = req.body.permissions;
		copy.name = req.body.name;
		copy.family_name = req.body.family_name;
		copy.given_name = req.body.given_name;
		copy.dateModified = new Date();
		copy.dateCreated = new Date();
		if (req.body.explicitPermissions) {
		  copy.explicitPermissions = req.body.explicitPermissions;
		}
		const result = await transcriptions.insertOne(copy);
		res.json(result);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err)
	  }
	})

	app.get('/excelData', async (req, res) => {
	  const id = req.query._id as string;
	  const jsonOut = mediaPath('data', 'json', `${id}.json`);
	  const xlsxOut = mediaPath('data', 'excel', `${id}.xlsx`);
	  const argvs = [
      'make_excel.py',
      id,
      jsonOut,
      xlsxOut
	  ];
	  try {
      const pythonScript = spawn(PYTHON_PATH, argvs, { env: pythonEnv() });
      pythonScript.stdout.on('data', data => {
        console.log(`stdout: ${data}`)
      });

      pythonScript.stderr.on('data', data => {
        console.error(`stderr: ${data}`)
      });
      await pythonScript.on('close', () => {
        res.download(xlsxOut);
      })
	  } catch (err) {
      console.error(err);
      res.status(500).send(err)
	  }
	})

	app.get('/jsonData', async (req, res) => {
	  const id = req.query._id as string;
	  const jsonOut = mediaPath('data', 'json', `${id}.json`);
	  const xlsxOut = mediaPath('data', 'excel', `${id}.xlsx`);
	  const argvs = [
		'make_excel.py',
		id,
		jsonOut,
		xlsxOut
	  ];
	  try {
		const pythonScript = spawn(PYTHON_PATH, argvs, { env: pythonEnv() });
		pythonScript.stdout.on('data', data => {
		  console.log(`stdout: ${data}`)
		});

		pythonScript.stderr.on('data', data => {
		  console.error(`stderr: ${data}`)
		});
		pythonScript.on('close', () => {
		  res.download(jsonOut);
		})
	  } catch (err) {
		console.error(err);
		res.status(500).send(err)
	  }
	})

	app.get('/getInstrumentation', async (req, res) => {
	  // from the audio recording.
	  try {
		const audioID = new ObjectId(JSON.parse(req.query.audioID as string));
		const query = { _id: audioID };
		const projection = { projection: { musicians: 1, _id: 0 } };
		const result = await audioRecordings.findOne(query, projection);
    if (!result) {
      return res.status(404).send('Audio recording not found');
    }
		const musicians = result.musicians;
		const keys = Object.keys(musicians);
		const sortOrder = ['Soloist', 'Accompanist'];
		const musiciansArr = keys
		  .map(key => musicians[key])
		  .filter(musician => sortOrder.includes(musician.role))
		const ordering: { [key: string]: number } = {};
		for (let i=0; i<sortOrder.length; i++) {
		  ordering[sortOrder[i]] = i;
		}
		musiciansArr.sort((a, b) => ordering[a.role] - ordering[b.role]);
		const instrumentation = musiciansArr.map(m => m.instrument);
		res.json(instrumentation);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.get('/getTranscriptionInstrumentation', async (req, res) => {
	  // from the transcription.
	  try {
		const transcriptionID = new ObjectId(req.query.transcriptionID as string);
		const query = { _id: transcriptionID };
		const projection = { projection: { instrumentation: 1, _id: 0 } };
		const result = await transcriptions.findOne(query, projection);
    if (!result) {
      return res.status(404).send('Transcription not found');
    }
		res.json(result.instrumentation);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/newUploadFile', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		if (!req.files) {
		  res.send({ status: false, message: 'No file uploaded' });
		} else {
		  const newId = new ObjectId();
		  const dateModified = new Date().toISOString();
		  const audioEventID = req.body.audioEventID;
		  let recIdx = req.body.recIdx;
		  const audioFile = req.files.audioFile as fileUpload.UploadedFile;
		  let parentTitle = undefined;
		  let aeUserID = undefined;
		  if (
			req.body.audioEventType === 'add' || 
			req.body.audioEventType === 'create'
			) {
			const recPath = `recordings.${recIdx}`;
			const afIdPath = `${recPath}.audioFileId`;
			const datePath = `${recPath}.date`;
			const locationPath = `${recPath}.location`;
			const musiciansPath = `${recPath}.musicians`;
			const raagsPath = `${recPath}.raags`;
			const octOffsetPath = `${recPath}.octOffset`;
			const dateModifiedPath = `${recPath}.dateModified`
			const expPermissionsPath = `${recPath}.explicitPermissions`;
			const q = { _id: new ObjectId(audioEventID) };
			// 'add' attaches to an EXISTING audio event → require edit rights on it.
			// 'create' upserts a brand-new event (owned by this uploader), so no check.
			if (req.body.audioEventType === 'add') {
			  const existingAE = await audioEvents.findOne(q);
			  if (!existingAE) { res.status(404).json({ error: 'audio event not found' }); return; }
			  if (!canEdit(existingAE, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
			}
			const update = { $set: {
			  [afIdPath]: newId,
			  [datePath]: {},
			  [locationPath]: {},
			  [musiciansPath]: {},
			  [raagsPath]: {},
			  [octOffsetPath]: 0,
			  [dateModifiedPath]: dateModified,
			  [expPermissionsPath]: {
				publicView: true,
				edit: [],
				view: []
			  }         
			} };
			const op = { upsert: true, returnOriginal: false };
			const result = await audioEvents.findOneAndUpdate(q, update, op);
      if (!result.value) {
        return res.status(404).send('Audio event not found');
      }
			parentTitle = result.value.name;
			aeUserID = result.value.userID;
			console.log(result.value)
		  }
			// here we should also update the audioRecordings collection
			// with the new audio file, so as not to rely on the aggregation
			// which generates from audioEvents forever.
		  await audioRecordings.insertOne({
			_id: newId,
			duration: 0,
			saEstimate: 0,
			saVerified: false,
			octOffset: 0,
			collections: [],
			musicians: {},
			title: '',
			date: {},
			location: {},
			raags: {},
			parentID: audioEventID,
			parentTitle: parentTitle,
			aeUserID: aeUserID,
			userID: req.user!.uid,
			parentTrackNumber: recIdx,
			dateModified: dateModified,
			explicitPermissions: {
			  publicView: true,
			  edit: [],
			  view: []
			}
		  })

		  const suffix = getSuffix(audioFile.mimetype)!;
		  let fn = newId + suffix;
		  audioFile.mv(mediaPath('uploads', fn));
		  if (suffix === '.opus') {
			const newFN = newId + '.wav';
			const spawnArgs = ['-i', mediaPath('uploads', fn), mediaPath('uploads', newFN)];
			const convertToOpus = spawn('ffmpeg', spawnArgs)
			fn = newFN;
			convertToOpus.stderr.on('data', data => {
			  console.error(`stderr: ${data}`)
			});
			convertToOpus.on('close', () => {
			  console.log('opus conversion finished')
			})
		  }
		  const spawns = ['process_audio.py', fn, audioEventID, recIdx, newId];
		  const processAudio = spawn(PYTHON_PATH, spawns, { env: pythonEnv() });
		  processAudio.stderr.on('data', data => {
			console.error(`stderr: ${data}`)
		  });
		  processAudio.on('close', () => {
			console.log('audio processing finished');
			res.send({
			  status: true,
			  message: 'File is uploaded',
			  data: {
				name: audioFile.name,
				mimetype: audioFile.mimetype,
				size: audioFile.size,
				audioFileId: newId
			  }
			});
			const script1 = './visualization_scripts/generate_melograph.py';
			const script2 = './visualization_scripts/make_spec_data.py';
			runPythonScript(script1, [newId.toString()])
			  .then(() => console.log('Melograph generation finished'))
			  .catch(err => console.error('Error in melograph generation:', err));
			runPythonScript(script2, [newId.toString()])
			  .then(() => console.log('Spectrogram data generation finished'))
			  .catch(err => console.error('Error in spectrogram data generation:', err));
		  });
		}
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.get('/getEditableCollections', async (req, res) => {
	  try {
		if (!req.user?.uid) { res.json([]); return; }
		const query1 = { userID: req.user.uid };
		const query2 = { 'permissions.edit': req.user.uid };
		const query = { $or: [query1, query2] };
		const result = await collections.find(query).toArray();
		res.json(result)
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})
	
	app.get('/getSavedSettings', async (req, res) => {
	  try {
		if (!req.user?.uid) { res.json([]); return; }
		const query = { _id: new ObjectId(req.user.uid) };
		const projection = { savedSettings: 1, _id: 0 };
		const result = await users.findOne(query, { projection });
		if (result && result.savedSettings) {
		  res.json(result.savedSettings)
		} else {
		  res.json([])
		}
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.post('/saveDisplaySettings', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const query = { _id: new ObjectId(req.user!.uid) };
		const user = await users.findOne(query);
		if (user) {
		  if (user.savedSettings) {
			const update = { $push: { savedSettings: req.body.settings } };
			const result = await users.updateOne(query, update);
			res.json(result);
		  } else {
			const update = { $set: { savedSettings: [req.body.settings] } };
			const result = await users.updateOne(query, update);
			res.json(result);
		  }
		} else {
		  res.status(404).send('User not found');
		}
		
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.post('/updateDisplaySettings', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const { uniqueId, settings } = req.body;
		const query = { _id: new ObjectId(req.user!.uid), 'savedSettings.uniqueId': uniqueId };
		const update = { $set: { 'savedSettings.$': settings } };
		const result = await users.updateOne(query, update);
		// console.log(userID, uniqueId, settings)
		if (result.matchedCount === 0) {
		  res.status(404).send('User or display settings not found');
		} else {
		  res.json(result);
		}
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.get('/getDefaultSettings', async (req, res) => {
	  try {
		if (!req.user?.uid) { res.json('ffa38001-f592-4778-a91e-c4ef5c99b081'); return; }
		const query = { _id: new ObjectId(req.user.uid) };
		const projection = { defaultSettingsID: 1, _id: 0 };
		const result = await users.findOne(query, { projection });
		if (result && result.defaultSettingsID) {
		  res.json(result.defaultSettingsID)
		} else {
		  res.json('ffa38001-f592-4778-a91e-c4ef5c99b081')
		}
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/setDefaultSettings', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const query = { _id: new ObjectId(req.user!.uid) };
		const update = { $set: { defaultSettingsID: req.body.settingsID } };
		const result = await users.updateOne(query, update);
		res.json(result);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.delete('/deleteDisplaySettings', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const query = { _id: new ObjectId(req.user!.uid) };
		const savedSettings = { uniqueId: req.body.uniqueId };
		const update = { $pull: { savedSettings } };
		const result = await users.updateOne(query, update);
		res.json(result);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/updateInstrumentation', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		// first get the transcription included in the query under
		// the transcriptionID key.
		// then, update the instrumentation field of the transcription.
		// If the new length of instrumentation is less than the original,
		// delete the corresponding idxs from the following fields:
		// instrumentation, phrases, phraseGrid, durArrayGrid, sectionCatGrid,
		// and sectionStartsGrid.

		// If the new length of instrumentation is greater than the original,
		// add the new instrument name to the end of the instrumentation array.
		const { transcriptionID, instrumentation } = req.body;
		if (!transcriptionID || !instrumentation) {
		  res.status(400).send('TranscriptionID and instrumentation are required');
		};
		const query = { _id: new ObjectId(transcriptionID) };
		const transcription = await transcriptions.findOne(query);
		if (!transcription) { res.status(404).json({ error: 'not found' }); return; }
		if (!canEdit(transcription, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		if (!transcription) {
		  res.status(404).send('Transcription not found');
		  return;
		}
		const originalInstrumentation = transcription.instrumentation;
		const originalLength = originalInstrumentation.length;
		const newLength = instrumentation.length;

		await transcriptions.updateOne(query, { $set: { instrumentation } });
		if (newLength < originalLength) {
		  const fieldsToUpdate = [
			'instrumentation',
			'phraseGrid',
			'durArrayGrid',
			'sectionCatGrid',
			'sectionStartsGrid'
		  ];
		  const updateOps = fieldsToUpdate.map(field => ({
			[field]: transcription[field].slice(0, newLength)
		  }));
		  await transcriptions.updateOne(query, {
			$set: Object.assign({}, ...updateOps)
		  });
		}
		// res.status(200).send('Instrumentation updated');
		res.json({ status: 200, message: 'Instrumentation updated' });
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.get('/getTranscriptionInstrumentationAndTitles', async (req, res) => {
	  // from the transcription - get both instrumentation and trackTitles
	  try {
		const transcriptionID = new ObjectId(req.query.transcriptionID as string);
		const query = { _id: transcriptionID };
		const projection = { projection: { instrumentation: 1, trackTitles: 1, _id: 0 } };
		const result = await transcriptions.findOne(query, projection);
		if (!result) {
		  return res.status(404).send('Transcription not found');
		}
		// Return both instrumentation and trackTitles, with empty array fallback for trackTitles
		res.json({
		  instrumentation: result.instrumentation || [],
		  trackTitles: result.trackTitles || []
		});
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.post('/updateInstrumentationAndTitles', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const { transcriptionID, instrumentation, trackTitles } = req.body;
		if (!transcriptionID || !instrumentation) {
		  res.status(400).send('TranscriptionID and instrumentation are required');
		  return;
		}
		const query = { _id: new ObjectId(transcriptionID) };
		const transcription = await transcriptions.findOne(query);
		if (!transcription) { res.status(404).json({ error: 'not found' }); return; }
		if (!canEdit(transcription, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		if (!transcription) {
		  res.status(404).send('Transcription not found');
		  return;
		}
		const originalInstrumentation = transcription.instrumentation;
		const originalLength = originalInstrumentation.length;
		const newLength = instrumentation.length;

		// Update both instrumentation and trackTitles
		const updateData: { [key: string]: any } = { instrumentation };
		if (trackTitles) {
		  updateData.trackTitles = trackTitles;
		}

		await transcriptions.updateOne(query, { $set: updateData });

		if (newLength < originalLength) {
		  const fieldsToUpdate = [
			'instrumentation',
			'phraseGrid',
			'durArrayGrid',
			'sectionCatGrid',
			'sectionStartsGrid',
			'trackTitles'
		  ];
		  const updateOps = fieldsToUpdate.map(field => {
			if (transcription[field]) {
			  return { [field]: transcription[field].slice(0, newLength) };
			}
			return null;
		  }).filter(op => op !== null);

		  await transcriptions.updateOne(query, {
			$set: Object.assign({}, ...updateOps)
		  });
		}
		res.json({ status: 200, message: 'Instrumentation and track titles updated' });
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.post('/updateCollectionInviteCode', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const query = { _id: new ObjectId(req.body.id) };
		const coll = await collections.findOne(query);
		if (!coll) { res.status(404).json({ error: 'not found' }); return; }
		if (!isOwner(coll, req.user!.uid)) { res.status(403).json({ error: 'forbidden' }); return; }
		const update = { $set: { inviteCode: req.body.inviteCode } };
		const result = await collections.updateOne(query, update);
		res.json(result);
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.post('/enrollUserInCollection', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const query = { inviteCode: req.body.inviteCode };
		const collection = await collections.findOne(query);
		if (!collection) {
		  res.status(404).send('Collection not found');
		  return;
		}
		const update = { $addToSet: { "permissions.view": req.user!.uid } };
		const result = await collections.updateOne(query, update);
		res.json(result);

	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/updateTranscriptionViewed', requireSession, requireCsrfHeader, async (req, res) => {
	  try {
		const query = { _id: new ObjectId(req.user!.uid) };
		const update = {
		  $set: {
			[`transcriptionsViewed.${req.body.transcriptionID}`]: new Date()
		  }
		}
		const result = await users.updateOne(query, update);
		res.json(result);
		
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	})

	app.post('/getUsersLastViewedTranscriptions', async (req, res) => {
	  try {
		// Expecting a JSON body with { userId: "someUserId" }
		if (!req.user?.uid) { res.json({}); return; }
		const userID = req.user.uid;
		const query = { _id: new ObjectId(userID) };
		const projection = { projection: { transcriptionsViewed: 1, _id: 0 } };
		const user = await users.findOne(query, projection);
		if (!user) {
		  return res.status(404).send('User not found');
		}
		res.json(user.transcriptionsViewed || {});
	  } catch (err) {
		console.error(err);
		res.status(500).send(err);
	  }
	});

	app.get('/DNExtractExcel', async (req, res) => {
    try {
      const id = req.query.id as string;
      const extractorOptions = JSON.parse(req.query.options as string) as DN_ExtractorOptions;
      const extractor = await DN_Extractor.create(id, extractorOptions);

      // Generate Excel in-memory
      const excelBuffer = await extractor.toBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="extract-${id}.xlsx"`);
      res.send(excelBuffer);
    } catch (err) {
      console.error(err);
      res.status(500).send(err);
    }
  });

	const setNoCache = (res: express.Response) => {
	  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
	  res.setHeader('Pragma', 'no-cache');
	  res.setHeader('Expires', '0')
	};
	app.use('/audio', express.static(mediaPath('audio'), { setHeaders: setNoCache }));
	app.use('/peaks', express.static(mediaPath('peaks'), { setHeaders: setNoCache }));
	app.use('/test', express.static('test', { setHeaders: setNoCache }));
	app.use('/spectrograms', express.static(mediaPath('spectrograms'), {
	  setHeaders: setNoCache
	}))
	app.use('/spec_data', express.static(mediaPath('spec_data'), {
	  setHeaders: setNoCache
	}))
	app.use('/melographs', express.static(mediaPath('melographs'), {
	  setHeaders: setNoCache
	}));
	app.use('/', express.static('dist'))
	const server = app.listen(3000);
	server.timeout = 600000;
  } catch (err) {
	console.error(err)
  }
}

runServer();
