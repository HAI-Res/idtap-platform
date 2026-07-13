import path from 'path';

/**
 * Centralized configuration for where media files live and how Python is invoked.
 *
 * Historically every media path in the server was a bare CWD-relative string
 * (e.g. `express.static('audio')`, `'peaks/' + id`), so the effective base was
 * simply the directory the node process was launched from. To support the CSAIL
 * migration (media on NFS, separate from the code), these are now routed through
 * a single configurable base dir.
 *
 * Defaults reproduce the exact previous behavior:
 *   - IDTAP_MEDIA_ROOT unset  -> process.cwd()  (identical to bare relative paths)
 *   - IDTAP_PYTHON_PATH unset -> the previous hardcoded interpreter
 *   - IDTAP_UPLOAD_TMP unset  -> '/tmp/'
 *
 * On the new box, set IDTAP_MEDIA_ROOT=/data/hai-res/shared/idtap/media (etc.)
 * and keep the process WorkingDirectory pointed at the Python scripts dir so the
 * bare-name / ./visualization_scripts script spawns still resolve.
 */

// Base directory for all media (audio, peaks, spectrograms, spec_data,
// melographs, uploads, and the data/json|excel export scratch dirs).
export const MEDIA_ROOT = process.env.IDTAP_MEDIA_ROOT
  ? path.resolve(process.env.IDTAP_MEDIA_ROOT)
  : process.cwd();

/** Join path segments onto the media root. `mediaPath('audio','wav')`. */
export const mediaPath = (...segments: string[]): string =>
  path.join(MEDIA_ROOT, ...segments);

// Python interpreter (venv). Override with IDTAP_PYTHON_PATH on the new box.
export const PYTHON_PATH =
  process.env.IDTAP_PYTHON_PATH || '/opt/idtap-python/bin/python';

// Temp dir express-fileupload streams uploads into. Override with IDTAP_UPLOAD_TMP.
export const UPLOAD_TMP_DIR = process.env.IDTAP_UPLOAD_TMP || '/tmp/';

/**
 * Environment passed to spawned Python scripts so they resolve media through the
 * same base. Only sets IDTAP_MEDIA_ROOT when explicitly configured, so that with
 * the env unset the Python scripts fall back to their original path logic.
 */
export const pythonEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  if (process.env.IDTAP_MEDIA_ROOT) {
    env.IDTAP_MEDIA_ROOT = MEDIA_ROOT;
  }
  return env;
};
