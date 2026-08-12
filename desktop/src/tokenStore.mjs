// Persists the session JWT across launches, encrypted with the OS keychain via
// Electron safeStorage when available (macOS Keychain / Windows DPAPI / libsecret),
// falling back to a 0600 plaintext file otherwise.

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const file = () => path.join(app.getPath('userData'), 'session.tok');

export function loadToken() {
  try {
    const raw = fs.readFileSync(file());
    const marker = raw.subarray(0, 4).toString();
    const body = raw.subarray(4);
    if (marker === 'enc:') return safeStorage.decryptString(body);
    if (marker === 'raw:') return body.toString('utf8');
    return null;
  } catch {
    return null;
  }
}

export function saveToken(token) {
  try {
    if (token == null) { fs.rmSync(file(), { force: true }); return; }
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(file(), Buffer.concat([Buffer.from('enc:'), safeStorage.encryptString(token)]), { mode: 0o600 });
    } else {
      fs.writeFileSync(file(), Buffer.concat([Buffer.from('raw:'), Buffer.from(token, 'utf8')]), { mode: 0o600 });
    }
  } catch (err) {
    console.error('tokenStore save failed', err);
  }
}
