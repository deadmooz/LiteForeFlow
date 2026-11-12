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
const note = (ip) => attempts.set(ip, [...(attempts.get(ip) ?? []), Date.now()]);
// Addresses that stopped coming are forgotten, so the map cannot grow for ever.
setInterval(() => { const t = Date.now(); for (const [ip, ts] of attempts) if (!ts.length || t - ts[ts.length - 1] > 60_000) attempts.delete(ip); }, 60_000).unref();
/** Sign-up counts every try; sign-in counts only wrong passwords (see the login route), so people behind one office address are not locked out by good logins. */
function rateLimit(req, res, next) {
  const recent = (attempts.get(req.ip) ?? []).filter((x) => Date.now() - x < 60_000);
  attempts.set(req.ip, recent);
  if (recent.length >= config.authRateLimitPerMin) return next(new HttpError(429, 'Too many attempts, try again in a minute'));
  if (!req.path.endsWith('/login')) note(req.ip);
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
  // bcrypt only uses the first 72 bytes; refusing longer passwords stops two different passwords from being interchangeable.
  if (Buffer.byteLength(password) > 72) throw new HttpError(400, 'Password must be at most 72 bytes long');
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
  if (!user || !ok) { note(req.ip); throw new HttpError(401, 'Invalid email or password'); }
  res.json({ token: sign(user.id), user: publicUser(user), workspaces: await workspacesOf(user.id) });
});

export async function requireAuth(req, res, next) {
  try {
    const header = req.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) throw new HttpError(401, 'Authentication required');
    let payload;
    try { payload = jwt.verify(header.slice(7), jwtSecret); } catch { throw new HttpError(401, 'Session expired, please sign in again'); }
    // One round trip: the account and its workspaces together (no password hash is read).
    const rows = await all(
      'SELECT u.id AS uid, u.email, u.name AS uname, w.id, w.name, w.plan, m.role FROM users u LEFT JOIN members m ON m.user_id = u.id LEFT JOIN workspaces w ON w.id = m.workspace_id WHERE u.id = ? ORDER BY m.created_at',
      payload.sub,
    );
    if (!rows.length) throw new HttpError(401, 'Account not found');
    const user = { id: rows[0].uid, email: rows[0].email, name: rows[0].uname };
    const spaces = rows.filter((r) => r.id).map((r) => ({ id: r.id, name: r.name, plan: r.plan, role: r.role }));
    const wanted = req.get('x-workspace-id');
    const ws = spaces.find((w) => w.id === wanted) ?? spaces[0];
    if (!ws) throw new HttpError(403, 'No workspace');
    req.user = user;
    req.spaces = spaces;
    req.workspaceId = ws.id;
    req.role = ws.role;
    next();
  } catch (e) { next(e); }
}

export const meRouter = express.Router();
meRouter.use(requireAuth);

meRouter.get('/me', async (req, res) => {
  res.json({ user: publicUser(req.user), workspaces: req.spaces, currentWorkspaceId: req.workspaceId });
});

meRouter.get('/workspace/members', async (req, res) => {
  res.json(await all(
    'SELECT u.id, u.email, u.name, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at',
    req.workspaceId,
  ));
});

/** Owner removes a member, or a member leaves. The owner can never be removed. */
meRouter.delete('/workspace/members/:userId', async (req, res) => {
  const target = await get('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?', req.workspaceId, req.params.userId);
  if (!target) throw new HttpError(404, 'Member not found');
  const self = req.params.userId === req.user.id;
  if (!self && req.role !== 'owner') throw new HttpError(403, 'Only the workspace owner can remove other members');
  if (target.role === 'owner') throw new HttpError(400, 'The workspace owner cannot be removed');
  await run('DELETE FROM members WHERE workspace_id = ? AND user_id = ?', req.workspaceId, req.params.userId);
  res.status(204).end();
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
