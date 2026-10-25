import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { all, get, run, transaction, uid, now } from '../db.js';
import { jwtSecret } from '../crypto.js';
import { config } from '../config.js';
import { assertCanInvite } from '../plans.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* Tiny in-memory limiter for credential endpoints. Use a shared store behind multiple instances. */
const attempts = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const t = Date.now();
  const recent = (attempts.get(key) ?? []).filter((x) => t - x < 60_000);
  if (recent.length >= 20) return next(new HttpError(429, 'Too many attempts, try again in a minute'));
  recent.push(t);
  attempts.set(key, recent);
  return next();
}

const sign = (userId) => jwt.sign({ sub: userId }, jwtSecret, { expiresIn: '7d' });
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name });
const workspacesOf = async (userId) => all(
  'SELECT w.id, w.name, w.plan, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY m.created_at',
  userId,
);

export const authRouter = express.Router();

authRouter.post('/signup', rateLimit, async (req, res) => {
  if (!config.allowSignup) throw new HttpError(403, 'Signups are disabled on this server');
  const { email, password, name } = req.body ?? {};
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'A valid email is required');
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const cleanEmail = email.trim().toLowerCase();
  if (await get('SELECT id FROM users WHERE email = ?', cleanEmail)) throw new HttpError(409, 'An account with this email already exists');

  const userId = uid();
  const wsId = uid();
  const displayName = String(name || cleanEmail.split('@')[0]).slice(0, 80);
  const hash = await bcrypt.hash(password, 10);
  try {
    await transaction(async (tx) => {
      await tx.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)', userId, cleanEmail, displayName, hash, now());
      await tx.run('INSERT INTO workspaces (id, name, plan, created_at) VALUES (?,?,?,?)', wsId, `${displayName}'s workspace`, 'free', now());
      await tx.run('INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)', wsId, userId, 'owner', now());
    });
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) throw new HttpError(409, 'An account with this email already exists');
    throw e;
  }
  res.status(201).json({ token: sign(userId), user: { id: userId, email: cleanEmail, name: displayName }, workspaces: await workspacesOf(userId) });
});

authRouter.post('/login', rateLimit, async (req, res) => {
  const { email, password } = req.body ?? {};
  const user = await get('SELECT * FROM users WHERE email = ?', String(email ?? '').trim().toLowerCase());
  // Compare even when the user is missing so response time does not reveal which emails exist.
  const ok = await bcrypt.compare(String(password ?? ''), user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
  if (!user || !ok) throw new HttpError(401, 'Invalid email or password');
  res.json({ token: sign(user.id), user: publicUser(user), workspaces: await workspacesOf(user.id) });
});

export async function requireAuth(req, res, next) {
  try {
    const header = req.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) throw new HttpError(401, 'Authentication required');
    let payload;
    try { payload = jwt.verify(header.slice(7), jwtSecret); } catch { throw new HttpError(401, 'Session expired, please sign in again'); }
    const user = await get('SELECT * FROM users WHERE id = ?', payload.sub);
    if (!user) throw new HttpError(401, 'Account not found');
    const spaces = await workspacesOf(user.id);
    const wanted = req.get('x-workspace-id');
    const ws = spaces.find((w) => w.id === wanted) ?? spaces[0];
    if (!ws) throw new HttpError(403, 'No workspace');
    req.user = user;
    req.workspaceId = ws.id;
    req.role = ws.role;
    next();
  } catch (e) { next(e); }
}

export const meRouter = express.Router();
meRouter.use(requireAuth);

meRouter.get('/me', async (req, res) => {
  res.json({ user: publicUser(req.user), workspaces: await workspacesOf(req.user.id), currentWorkspaceId: req.workspaceId });
});

meRouter.get('/workspace/members', async (req, res) => {
  res.json(await all(
    'SELECT u.id, u.email, u.name, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at',
    req.workspaceId,
  ));
});

meRouter.post('/workspace/invite', async (req, res) => {
  if (req.role !== 'owner') throw new HttpError(403, 'Only the workspace owner can invite members');
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const user = await get('SELECT id FROM users WHERE email = ?', email);
  if (!user) throw new HttpError(404, 'No account with that email yet — ask them to sign up first');
  if (await get('SELECT 1 AS x FROM members WHERE workspace_id = ? AND user_id = ?', req.workspaceId, user.id)) throw new HttpError(409, 'Already a member');
  await assertCanInvite(req.workspaceId);
  await run('INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)', req.workspaceId, user.id, 'member', now());
  res.status(201).json({ ok: true });
});
