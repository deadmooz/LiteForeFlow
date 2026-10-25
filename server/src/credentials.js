import { get } from './db.js';
import { decryptJson } from './crypto.js';

export async function loadCredential(workspaceId, credentialId, expectedType) {
  if (!credentialId) throw new Error('No credential selected for this node');
  const row = await get('SELECT * FROM credentials WHERE id = ? AND workspace_id = ?', credentialId, workspaceId);
  if (!row) throw new Error('Credential not found (was it deleted?)');
  if (expectedType && row.type !== expectedType) {
    throw new Error(`Credential "${row.name}" is of type ${row.type}, expected ${expectedType}`);
  }
  return decryptJson(row.data);
}
