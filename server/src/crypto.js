import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function loadMasterSecret() {
  if (process.env.LITEFOREFLOW_SECRET) return process.env.LITEFOREFLOW_SECRET;
  const file = path.join(config.dataDir, '.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const master = loadMasterSecret();
const derive = (label) => crypto.createHash('sha256').update(`${label}:${master}`).digest();
const encKey = derive('enc');

export const jwtSecret = derive('jwt').toString('hex');

/** AES-256-GCM. Output: base64(iv).base64(tag).base64(ciphertext) */
export function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

export function decryptJson(payload) {
  try {
    const [iv, tag, ct] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'));
  } catch {
    const e = new Error('This credential cannot be unlocked: the secret key (data/.secret or LITEFOREFLOW_SECRET) is not the one it was saved with. '
      + 'Restore the old key, or open Credentials and enter this credential again.');
    e.status = 409;
    throw e;
  }
}
