import express from 'express';
import { Collection, ObjectId } from 'mongodb';
import { spawn } from 'child_process';
import fileUpload from 'express-fileupload';

import { mediaPath, PYTHON_PATH, pythonEnv } from './mediaConfig';
import { isOwner, canEdit, canView } from '../shared/authz';

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
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Script ${scriptPath} exited with code ${code}`));
      }
    });
  });
}

interface Collections {
  transcriptions: Collection;
  users?: Collection;
  audioEvents?: Collection;
  audioRecordings?: Collection;
  musicians?: Collection;
  ragas?: Collection;
  locations?: Collection;
}

export default function apiRoutes(collections: Collections) {
  const router = express.Router();

  // The /api auth middleware verifies a Google id_token and sets req.user.id to
  // the Google `sub`. Ownership/permission fields in the DB hold Mongo user _id
  // strings, so every authz decision needs this lookup first.
  const mongoUserId = async (req: express.Request): Promise<string | undefined> => {
    const user = await collections.users?.findOne({ sub: req.user!.id });
    return user?._id?.toString();
  };

  router.get('/transcriptions', async (req, res) => {
    const actorId = await mongoUserId(req);
    const sortKey = String(req.query.sortKey);
    const sortDirParam = String(req.query.sortDir);
    const sortDir = sortDirParam === '1' ? 1 : -1;

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
      explicitPermissions: 1,
      soloist: 1,
      soloInstrument: 1,
    };

    const query = {
      $or: [
        { "explicitPermissions.publicView": true },
        { "explicitPermissions.edit": actorId },
        { "explicitPermissions.view": actorId },
        { userID: actorId },
      ],
    };

    const sort: Record<string, 1 | -1> = {};
    sort[sortKey] = sortDir;

    try {
      const results = await collections.transcriptions
        .find(query)
        .project(projection)
        .collation({ locale: 'en' })
        .sort(sort)
        .toArray();
      res.json(results);
    } catch (err) {
      console.error(err);
      res.status(500).send(err);
    }
  });

  router.get('/transcription/:id', async (req, res) => {
    const transcriptionId = req.params.id;
    const actorId = await mongoUserId(req);

    if (!transcriptionId) {
      return res.status(400).json({ error: 'Transcription ID is required' });
    }

    try {
      const transcription = await collections.transcriptions.findOne({
        _id: new ObjectId(transcriptionId),
      });

      if (!transcription) {
        return res.status(404).json({ error: 'Transcription not found' });
      }
      if (!canView(transcription, actorId)) {
        return res.status(403).json({ error: 'forbidden' });
      }

      res.json(transcription);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/transcription/:id/json', async (req, res) => {
    const transcriptionId = req.params.id;
    // Previously this queried on req.user.id (the Google sub), which never
    // matches the Mongo user ids stored in userID/edit/view — so owners were
    // denied their own private transcriptions here. canView + mongoUserId
    // fixes that and also honors legacy string permissions.
    const actorId = await mongoUserId(req);

    if (!transcriptionId) {
      return res.status(400).json({ error: 'Transcription ID is required' });
    }

    try {
      const transcription = await collections.transcriptions.findOne({
        _id: new ObjectId(transcriptionId),
      });

      if (!transcription) {
        return res.status(404).json({ error: 'Transcription not found' });
      }
      if (!canView(transcription, actorId)) {
        return res.status(403).json({ error: 'forbidden' });
      }

      // Generate and serve JSON data (same logic as original jsonData route)
      const jsonOut = mediaPath('data', 'json', `${transcriptionId}.json`);
      const xlsxOut = mediaPath('data', 'excel', `${transcriptionId}.xlsx`);
      const argvs = [
        'make_excel.py',
        transcriptionId,
        jsonOut,
        xlsxOut
      ];

      const pythonScript = spawn(PYTHON_PATH, argvs, { env: pythonEnv() });

      pythonScript.stdout.on('data', data => {
        console.log(`stdout: ${data}`)
      });

      pythonScript.stderr.on('data', data => {
        console.error(`stderr: ${data}`)
      });

      pythonScript.on('close', () => {
        res.download(jsonOut);
      });

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/transcription/:id/excel', async (req, res) => {
    const transcriptionId = req.params.id;
    // Same sub-vs-Mongo-id fix as /transcription/:id/json above.
    const actorId = await mongoUserId(req);

    if (!transcriptionId) {
      return res.status(400).json({ error: 'Transcription ID is required' });
    }

    try {
      const transcription = await collections.transcriptions.findOne({
        _id: new ObjectId(transcriptionId),
      });

      if (!transcription) {
        return res.status(404).json({ error: 'Transcription not found' });
      }
      if (!canView(transcription, actorId)) {
        return res.status(403).json({ error: 'forbidden' });
      }

      // Generate and serve Excel data (same logic as original excelData route)
      const jsonOut = mediaPath('data', 'json', `${transcriptionId}.json`);
      const xlsxOut = mediaPath('data', 'excel', `${transcriptionId}.xlsx`);
      const argvs = [
        'make_excel.py',
        transcriptionId,
        jsonOut,
        xlsxOut
      ];

      const pythonScript = spawn(PYTHON_PATH, argvs, { env: pythonEnv() });

      pythonScript.stdout.on('data', data => {
        console.log(`stdout: ${data}`)
      });

      pythonScript.stderr.on('data', data => {
        console.error(`stderr: ${data}`)
      });

      pythonScript.on('close', () => {
        res.download(xlsxOut);
      });

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/transcription', async (req, res) => {
    const actorId = await mongoUserId(req);
    if (!actorId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // No _id -> insert a new transcription owned by the caller (the Bearer
    // counterpart of the session-guarded web /insertNewTranscription route).
    if (!req.body._id) {
      try {
        const insert = { ...req.body };
        insert.userID = actorId; // owner is the authenticated user, not client-supplied
        insert.dateCreated = new Date(insert.dateCreated);
        insert.dateModified = new Date(insert.dateModified);

        const result = await collections.transcriptions.insertOne(insert);
        await collections.users?.updateOne(
          { _id: new ObjectId(actorId) },
          { $push: { transcriptions: result.insertedId } } as any,
        );
        return res.json(result);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    try {
      // First, fetch the existing transcription to check permissions
      const transcriptionId = new ObjectId(req.body._id);
      const existingTranscription = await collections.transcriptions.findOne({ _id: transcriptionId });

      if (!existingTranscription) {
        return res.status(404).json({ error: 'Transcription not found' });
      }

      if (!canEdit(existingTranscription, actorId)) {
        return res.status(403).json({
          error: 'You do not have permission to edit this transcription'
        });
      }

      // Content-only update: ownership/sharing changes go through their own
      // owner-gated endpoints (same rule as the web /updateTranscription route).
      const updateObj: { [key: string]: any } = {};
      Object.keys(req.body).forEach(key => {
        if (key !== '_id' && key !== 'userID' && key !== 'permissions' && key !== 'explicitPermissions') {
          updateObj[key] = req.body[key];
        }
      });
      updateObj['dateModified'] = new Date();
      if (updateObj['dateCreated']) {
        updateObj['dateCreated'] = new Date(updateObj['dateCreated']);
      }

      // Update the transcription
      const query = { '_id': transcriptionId };
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
      const result = await collections.transcriptions.updateOne(query, update);

      res.json({ ...result, dateModified: updateObj['dateModified'] });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/transcription/:id/clone', async (req, res) => {
    // Bearer counterpart of the session-guarded web /cloneTranscription route.
    const actorId = await mongoUserId(req);
    if (!actorId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    try {
      const copy = await collections.transcriptions.findOne({ _id: new ObjectId(req.params.id) });
      if (!copy) {
        return res.status(404).json({ error: 'Transcription not found' });
      }
      if (!canView(copy, actorId)) {
        return res.status(403).json({ error: 'forbidden' });
      }

      copy._id = new ObjectId();
      copy.userID = actorId; // the cloner owns the new copy
      copy.dateModified = new Date();
      copy.dateCreated = new Date();
      if (req.body.title !== undefined) copy.title = req.body.title;
      if (req.body.permissions !== undefined) copy.permissions = req.body.permissions;
      if (req.body.name !== undefined) copy.name = req.body.name;
      if (req.body.family_name !== undefined) copy.family_name = req.body.family_name;
      if (req.body.given_name !== undefined) copy.given_name = req.body.given_name;
      if (req.body.explicitPermissions) copy.explicitPermissions = req.body.explicitPermissions;
      if (req.body.soloist !== undefined) copy.soloist = req.body.soloist;
      if (req.body.soloInstrument !== undefined) copy.soloInstrument = req.body.soloInstrument;

      const result = await collections.transcriptions.insertOne(copy);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/transcription/:id', async (req, res) => {
    // Bearer counterpart of the session-guarded web /oneTranscription route.
    const actorId = await mongoUserId(req);
    if (!actorId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    try {
      const query = { _id: new ObjectId(req.params.id) };
      const target = await collections.transcriptions.findOne(query);
      if (!target) {
        return res.status(404).json({ error: 'Transcription not found' });
      }
      if (!isOwner(target, actorId)) {
        return res.status(403).json({ error: 'forbidden' });
      }

      const result = await collections.transcriptions.deleteOne(query);
      await collections.users?.updateOne(
        { _id: new ObjectId(actorId) },
        { $pull: { transcriptions: { $in: [new ObjectId(req.params.id)] } } } as any,
      );
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/audioRecording/:id', async (req, res) => {
    // View-gated single recording metadata (Bearer counterpart of the web
    // /getAudioRecording route).
    const actorId = await mongoUserId(req);

    try {
      const recording = await collections.audioRecordings?.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!recording) {
        return res.status(404).json({ error: 'Recording not found' });
      }
      if (!canView(recording, actorId)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      res.json(recording);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/visibility', async (req, res) => {
    const actorId = await mongoUserId(req);

    if (!req.body._id) {
      return res.status(400).json({ error: 'Artifact ID is required' });
    }

    if (!req.body.artifactType) {
      return res.status(400).json({ error: 'Artifact type is required' });
    }

    if (!req.body.explicitPermissions) {
      return res.status(400).json({ error: 'Explicit permissions are required' });
    }

    try {
      // Only handle transcriptions for now (can be extended later)
      if (req.body.artifactType === 'transcription') {
        // First, fetch the existing transcription to check ownership
        const transcriptionId = new ObjectId(req.body._id);
        const existingTranscription = await collections.transcriptions.findOne({ _id: transcriptionId });

        if (!existingTranscription) {
          return res.status(404).json({ error: 'Transcription not found' });
        }

        // Check ownership: only the owner can update visibility/permissions
        if (!isOwner(existingTranscription, actorId)) {
          return res.status(403).json({
            error: 'Only the owner can update visibility settings'
          });
        }

        // Update the visibility/permissions
        const query = { _id: transcriptionId };
        const update = { $set: { 
          "explicitPermissions": req.body.explicitPermissions 
        } };
        const result = await collections.transcriptions.updateOne(query, update);

        res.json(result);
      } else {
        return res.status(400).json({ 
          error: 'Only transcription visibility updates are currently supported via API' 
        });
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/user', async (req, res) => {
    const googleUserId = req.user!.id; // Google OAuth sub
    
    try {
      // Look up fresh user data from MongoDB using Google OAuth sub
      const user = await collections.users?.findOne({ sub: googleUserId });
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json(user);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/agreeToWaiver', async (req, res) => {
    const actorId = await mongoUserId(req);

    if (!actorId) {
      return res.status(400).json({ error: 'User not found' });
    }

    try {
      const query = { _id: new ObjectId(actorId) };
      const update = { $set: { waiverAgreed: true } };
      const options = { upsert: true };
      const result = await collections.users?.updateOne(query, update, options);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Metadata endpoints for Python API client
  router.get('/musicians', async (req, res) => {
    try {
      const musicians = await collections.musicians?.find({}).toArray();
      res.json(musicians || []);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/ragas', async (req, res) => {
    try {
      const ragas = await collections.ragas?.find({}).toArray();
      const ragaNames = ragas?.map(raga => raga.name).sort() || [];
      res.json(ragaNames);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/ragaRules', async (req, res) => {
    try {
      const ragaName = req.query.name;
      
      if (!ragaName || typeof ragaName !== 'string') {
        return res.status(400).json({ error: 'Raga name is required' });
      }

      const query = { name: ragaName };
      const projection = { _id: 0, rules: 1, updatedDate: 1 };
      const options = { projection: projection };
      const result = await collections.ragas?.findOne(query, options);
      
      if (!result) {
        return res.status(404).json({ error: 'Raga not found' });
      }
      
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/instruments', async (req, res) => {
    try {
      // Get instruments from musicians collection
      const pipeline = [
        { $group: { _id: "$Solo Instrument" } },
        { $match: { _id: { $nin: [null, ""] } } },
        { $sort: { _id: 1 } }
      ];
      
      const instruments = await collections.musicians?.aggregate(pipeline).toArray();
      const instrumentNames = instruments?.map(inst => inst._id) || [];
      
      // Filter for melody instruments if requested
      if (req.query.melody === 'true') {
        const melodyInstruments = instrumentNames.filter(name => 
          !['Tabla', 'Pakhawaj', 'Ghatam', 'Kanjira', 'Mridangam'].includes(name)
        );
        res.json(melodyInstruments);
      } else {
        res.json(instrumentNames);
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/locations', async (req, res) => {
    try {
      const locations = await collections.locations?.findOne({});
      res.json(locations || {});
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/gharanas', async (req, res) => {
    try {
      const pipeline = [
        { $group: { _id: "$Gharana" } },
        { $match: { _id: { $nin: [null, ""] } } },
        { $sort: { _id: 1 } }
      ];
      
      const gharanas = await collections.musicians?.aggregate(pipeline).toArray();
      const gharanaNames = gharanas?.map(gh => ({ name: gh._id })) || [];
      res.json(gharanaNames);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/performanceSections', async (req, res) => {
    try {
      // Common performance sections in Hindustani music
      const sections = [
        'Alap', 'Jor', 'Jhala', 'Vilambit', 'Madhya', 'Drut', 
        'Taan', 'Meend', 'Gamak', 'Sargam', 'Bol-taan'
      ];
      res.json(sections);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/eventTypes', async (req, res) => {
    try {
      const eventTypes = ['Recording', 'Live Performance', 'Practice Session', 'Teaching'];
      res.json(eventTypes);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/audioEvents', async (req, res) => {
    try {
      const actorId = await mongoUserId(req);

      if (!actorId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Get audio events user can edit
      const events = await collections.audioEvents?.find({
        userID: actorId
      }).toArray();
      
      res.json(events || []);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Helper function to get file extension from MIME type
  function getSuffix(mimetype: string): string {
    const end = mimetype.split('/')[1];
    if (end === 'mpeg') {
      return '.mp3';
    } else if (end === 'wav' || end === 'x-wav') {
      return '.wav';
    } else if (end === 'm4a' || end === 'x-m4a') {
      return '.m4a';
    } else if (end === 'flac' || end === 'x-flac') {
      return '.flac';
    } else if (end === 'ogg' || end === 'x-ogg') {
      return '.opus';
    } else if (end === 'opus' || end === 'x-opus') {
      return '.opus';
    }
    return '.mp3'; // default
  }

  router.post('/uploadAudio', async (req, res) => {
    const actorId = await mongoUserId(req);

    if (!actorId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    try {
      if (!req.files || !req.files.audioFile) {
        return res.status(400).json({ error: 'No audio file uploaded' });
      }

      const audioFile = req.files.audioFile as fileUpload.UploadedFile;
      const metadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};
      const audioEventConfig = req.body.audioEventConfig ? JSON.parse(req.body.audioEventConfig) : null;

      // Generate new audio ID
      const newId = new ObjectId();
      const dateModified = new Date().toISOString();

      // Create new audio event if needed or use existing one
      let audioEventID = audioEventConfig?.audioEventId;
      let recIdx = audioEventConfig?.recordingIndex || 0;
      
      if (!audioEventID) {
        // Create new audio event
        const newAudioEvent = {
          _id: new ObjectId(),
          name: metadata.title || 'Untitled Recording',
          userID: actorId,
          recordings: [{}], // Will be populated below
          dateModified: dateModified,
          visibility: metadata.permissions?.publicView ? 'public' : 'private',
          // give the event the same permission shape the rest of the app uses,
          // so canView/canEdit work on it without the visibility special case
          explicitPermissions: {
            publicView: metadata.permissions?.publicView ?? false,
            edit: metadata.permissions?.edit || [],
            view: metadata.permissions?.view || []
          }
        };

        const audioEventResult = await collections.audioEvents?.insertOne(newAudioEvent);
        audioEventID = audioEventResult?.insertedId.toString();
        recIdx = 0;
      }

      // Update audio event with recording info
      const recPath = `recordings.${recIdx}`;
      const afIdPath = `${recPath}.audioFileId`;
      const datePath = `${recPath}.date`;
      const locationPath = `${recPath}.location`;
      const musiciansPath = `${recPath}.musicians`;
      const raagsPath = `${recPath}.raags`;
      const octOffsetPath = `${recPath}.octOffset`;
      const dateModifiedPath = `${recPath}.dateModified`;
      const expPermissionsPath = `${recPath}.explicitPermissions`;

      const aeQuery = { _id: new ObjectId(audioEventID) };
      const aeUpdate = { 
        $set: { 
          [afIdPath]: newId,
          [datePath]: metadata.date || {},
          [locationPath]: metadata.location || {},
          [musiciansPath]: metadata.musicians || {},
          [raagsPath]: metadata.ragas || {},
          [octOffsetPath]: 0,
          [dateModifiedPath]: dateModified,
          [expPermissionsPath]: {
            publicView: metadata.permissions?.publicView ?? false,
            edit: metadata.permissions?.edit || [],
            view: metadata.permissions?.view || []
          }         
        } 
      };
      
      await collections.audioEvents?.findOneAndUpdate(aeQuery, aeUpdate, { upsert: true });

      // Create audio recording entry
      const audioRecording = {
        _id: newId,
        duration: 0,
        saEstimate: 0,
        saVerified: false,
        octOffset: 0,
        collections: [],
        musicians: metadata.musicians || {},
        title: metadata.title || '',
        date: metadata.date || {},
        location: metadata.location || {},
        raags: metadata.ragas || {},
        parentID: audioEventID,
        parentTitle: metadata.title || 'Untitled Recording',
        aeUserID: actorId,
        userID: actorId,
        parentTrackNumber: recIdx,
        dateModified: dateModified,
        explicitPermissions: {
          publicView: metadata.permissions?.publicView ?? false,
          edit: metadata.permissions?.edit || [],
          view: metadata.permissions?.view || []
        }
      };

      await collections.audioRecordings?.insertOne(audioRecording);

      // Save the uploaded file
      const suffix = getSuffix(audioFile.mimetype);
      let filename = newId.toString() + suffix;
      const uploadPath = mediaPath('uploads', filename);

      await audioFile.mv(uploadPath);

      // Convert opus to wav if needed
      if (suffix === '.opus') {
        const newFilename = newId.toString() + '.wav';
        const spawnArgs = ['-i', uploadPath, mediaPath('uploads', newFilename)];
        const convertProcess = spawn('ffmpeg', spawnArgs);
        
        convertProcess.stderr.on('data', data => {
          console.error(`ffmpeg stderr: ${data}`);
        });
        
        convertProcess.on('close', () => {
          console.log('opus conversion finished');
        });
        
        filename = newFilename;
      }

      // Process audio with Python script and wait for completion
      const processArgs = ['process_audio.py', filename, audioEventID, recIdx.toString(), newId.toString()];
      const processAudio = spawn(PYTHON_PATH, processArgs, { env: pythonEnv() });
      
      processAudio.stderr.on('data', data => {
        console.error(`process_audio stderr: ${data}`);
      });

      processAudio.on('close', (code) => {
        console.log(`process_audio finished with code ${code}`);
        
        // After audio processing completes, run visualization scripts
        const script1 = './visualization_scripts/generate_melograph.py';
        const script2 = './visualization_scripts/make_spec_data.py';
        
        runPythonScript(script1, [newId.toString()])
          .then(() => console.log('Melograph generation finished'))
          .catch(err => console.error('Error in melograph generation:', err));
          
        runPythonScript(script2, [newId.toString()])
          .then(() => console.log('Spectrogram data generation finished'))
          .catch(err => console.error('Error in spectrogram data generation:', err));
      });

      // Return response in expected format
      const response = {
        audio_id: newId.toString(),
        success: true,
        file_info: {
          name: audioFile.name,
          mimetype: audioFile.mimetype,
          size: audioFile.size
        },
        processing_status: {
          audio_processed: false, // Will be updated by Python script
          melograph_generated: false,
          spectrograms_generated: false
        }
      };

      res.json(response);
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ error: 'Internal server error', details: err });
    }
  });

  return router;
}
